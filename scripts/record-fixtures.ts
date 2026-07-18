/**
 * Records sanitized fixtures from the real Sense cloud for SENSE_MOCK=1 replay:
 *   fixtures/devices.json  — device list (ids/names kept, tags trimmed)
 *   fixtures/frames.jsonl  — ~10 minutes of realtime frames
 *
 * Usage: SENSE_EMAIL=... SENSE_PASSWORD=... pnpm record-fixtures
 */
import { createInterface } from 'node:readline/promises';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import {
  MfaRequiredError,
  authenticate,
  completeMfa,
} from '../packages/server/src/sense/auth.js';
import { SenseRealtimeSocket } from '../packages/server/src/sense/realtime.js';
import type { StoredTokens } from '../packages/server/src/sense/types.js';

const DURATION_MS = 10 * 60_000;
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
mkdirSync('fixtures', { recursive: true });

const devRes = await fetch(
  `https://api.sense.com/apiservice/api/v1/app/monitors/${tokens.monitorId}/devices`,
  { headers: { Authorization: `bearer ${tokens.accessToken}` } },
);
const devices = (await devRes.json()) as Record<string, unknown>[];
writeFileSync(
  'fixtures/devices.json',
  JSON.stringify(
    devices.map((d) => ({
      id: d.id,
      name: d.name,
      icon: d.icon ?? null,
      type: d.type ?? null,
      tags: {},
    })),
    null,
    2,
  ),
);
console.log(`✔ wrote fixtures/devices.json (${devices.length} devices)`);

const out = createWriteStream('fixtures/frames.jsonl');
let count = 0;
const socket = new SenseRealtimeSocket({
  getMonitorId: () => tokens.monitorId,
  getAccessToken: () => tokens.accessToken,
  onAuthFailure: async () => undefined,
  mode: 'persistent',
  log: (m) => console.log(`  [ws] ${m}`),
});
socket.events.on('frame', (payload) => {
  out.write(`${JSON.stringify({ payload })}\n`);
  if (++count % 60 === 0) console.log(`  ${count} frames...`);
});
socket.start();
setTimeout(() => {
  socket.stop();
  out.end(() => {
    console.log(`✔ wrote fixtures/frames.jsonl (${count} frames over 10 min)`);
    process.exit(0);
  });
}, DURATION_MS);
