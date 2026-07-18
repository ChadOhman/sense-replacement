/**
 * Live smoke test against the real Sense cloud: authenticates, prints monitor
 * info, fetches today's trends, and grabs a few realtime frames, then exits.
 *
 * Usage: SENSE_EMAIL=... SENSE_PASSWORD=... pnpm probe
 * If MFA is enabled you'll be prompted for the code on stdin.
 */
import { createInterface } from 'node:readline/promises';
import {
  MfaRequiredError,
  authenticate,
  completeMfa,
} from '../packages/server/src/sense/auth.js';
import { SenseRealtimeSocket } from '../packages/server/src/sense/realtime.js';
import type { StoredTokens } from '../packages/server/src/sense/types.js';

const email = process.env.SENSE_EMAIL;
const password = process.env.SENSE_PASSWORD;
if (!email || !password) {
  console.error('Set SENSE_EMAIL and SENSE_PASSWORD');
  process.exit(1);
}

async function auth(): Promise<StoredTokens> {
  try {
    return await authenticate(email!, password!);
  } catch (err) {
    if (err instanceof MfaRequiredError) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const totp = (await rl.question('MFA code: ')).trim();
      rl.close();
      return completeMfa(err.mfaToken, totp);
    }
    throw err;
  }
}

const tokens = await auth();
console.log(`✔ authenticated: user ${tokens.userId}, monitor ${tokens.monitorId} (tz ${tokens.monitorTz})`);

const today = new Date().toISOString().slice(0, 10);
const trendsRes = await fetch(
  `https://api.sense.com/apiservice/api/v1/app/history/trends?monitor_id=${tokens.monitorId}&scale=DAY&start=${today}T00:00:00`,
  { headers: { Authorization: `bearer ${tokens.accessToken}` } },
);
const trends = (await trendsRes.json()) as { consumption?: { total?: number } };
console.log(`✔ trends: today so far ${trends.consumption?.total?.toFixed(2) ?? '?'} kWh`);

console.log('connecting to realtime feed (5 frames)...');
let count = 0;
const socket = new SenseRealtimeSocket({
  getMonitorId: () => tokens.monitorId,
  getAccessToken: () => tokens.accessToken,
  onAuthFailure: async () => undefined,
  mode: 'persistent',
  log: (m) => console.log(`  [ws] ${m}`),
});
socket.events.on('frame', (payload) => {
  console.log(
    `  ${payload.w.toFixed(0)} W  |  ${payload.devices.map((d) => `${d.name ?? d.id}: ${d.w.toFixed(0)}W`).join(', ') || 'no devices on'}`,
  );
  if (++count >= 5) {
    socket.stop();
    console.log('✔ realtime feed OK — closing (be nice to their servers)');
    process.exit(0);
  }
});
socket.start();
setTimeout(() => {
  console.error('✗ no frames within 30s');
  process.exit(1);
}, 30_000);
