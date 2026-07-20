import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { loadConfig } from './config.js';
import { KvStore, openDb } from './db/index.js';
import { KvTokenStore } from './sense/tokenstore.js';
import { SenseCloudClient } from './sense/rest.js';
import { SenseMockClient } from './sense/mock.js';
import { LiveRingBuffer } from './lib/ringbuffer.js';
import { EventEmitter } from 'node:events';
import { getBackfillStatus, startCollectors } from './collector/index.js';
import { registerRoutes } from './api/routes.js';
import { Notifier } from './alerts/notifier.js';
import { MqttPublisher } from './alerts/mqtt.js';
import { CostEngine } from './lib/costs.js';
import type { AppContext } from './context.js';

const log = (msg: string): void => {
  console.log(`[${new Date().toISOString()}] ${msg}`);
};

const config = loadConfig();
const db = openDb(config.dataDir);
const kv = new KvStore(db);

const sense = config.mock
  ? new SenseMockClient(config.tz, 'fixtures', config.mockSolar)
  : new SenseCloudClient({
      email: config.senseEmail,
      password: config.sensePassword,
      tokenStore: new KvTokenStore(kv),
      realtimeMode: config.realtimeMode,
      log,
    });

const ctx: AppContext = {
  config,
  db,
  kv,
  sense,
  ring: new LiveRingBuffer(3600),
  collectorStatus: new Map(),
  getBackfillStatus: () => getBackfillStatus(kv),
  getActiveBrownout: () => null,
  getActiveNeutralEpisode: () => null,
  getActiveStall: () => null,
  applyDetectionSettings: () => undefined,
  events: new EventEmitter(),
  costs: undefined as unknown as AppContext['costs'], // assigned just below
  log,
};
ctx.costs = new CostEngine(ctx);

const notifier = new Notifier(ctx);
notifier.start();
const mqttPublisher = new MqttPublisher(ctx);
mqttPublisher.start();

try {
  await sense.start();
} catch (err) {
  log(`sense auth failed: ${err instanceof Error ? err.message : String(err)} — serving archive only`);
}

let collectors: ReturnType<typeof startCollectors> | null = null;
let authPoll: NodeJS.Timeout | null = null;

function maybeStartCollectors(): void {
  if (collectors || sense.authState !== 'ok') return;
  collectors = startCollectors(ctx);
  log('collectors started');
  if (authPoll) {
    clearInterval(authPoll);
    authPoll = null;
  }
}

maybeStartCollectors();
if (!collectors) {
  log(`waiting for auth (state: ${sense.authState}) before starting collectors`);
  authPoll = setInterval(maybeStartCollectors, 5000);
}

const app = Fastify({ logger: false });
await app.register(fastifyWebsocket);
await registerRoutes(app, ctx);

const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      void reply.status(404).send({ error: 'not found' });
    } else {
      void reply.sendFile('index.html');
    }
  });
} else {
  log(`no frontend build at ${webDist} — API only (dev mode uses Vite on :5173)`);
}

await app.listen({ host: '0.0.0.0', port: config.port });
log(`listening on :${config.port}${config.mock ? ' (mock mode)' : ''}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down...');
  if (authPoll) clearInterval(authPoll);
  mqttPublisher.stop();
  collectors?.stop();
  await sense.stop();
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
