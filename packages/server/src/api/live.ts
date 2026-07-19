import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { LiveFrame, LiveMessage, PowerPoint } from '@sense/shared';
import type { AppContext } from '../context.js';
import { aggregateFrames, bucketStart } from '../collector/rollup.js';

const MAX_BUFFERED_BYTES = 256 * 1024;

/** Ring-buffer frames aggregated into 30s PowerPoints for the connect fill. */
function historyPoints(ctx: AppContext): PowerPoint[] {
  const frames = ctx.ring.all();
  const byBucket = new Map<number, LiveFrame[]>();
  for (const f of frames) {
    const b = bucketStart(f.ts, 30);
    const arr = byBucket.get(b);
    if (arr) arr.push(f);
    else byBucket.set(b, [f]);
  }
  const points: PowerPoint[] = [];
  for (const [b, bucketFrames] of [...byBucket.entries()].sort((a, z) => a[0] - z[0])) {
    const agg = aggregateFrames(bucketFrames);
    if (agg) {
      points.push({ t: b, wAvg: agg.wAvg, wMin: agg.wMin, wMax: agg.wMax, solarWAvg: agg.solarWAvg });
    }
  }
  return points;
}

export function registerLiveRoute(app: FastifyInstance, ctx: AppContext): void {
  const clients = new Set<WebSocket>();
  let relayTimer: NodeJS.Timeout | null = null;
  let lastSentTs = 0;

  const broadcast = (msg: LiveMessage): void => {
    const data = JSON.stringify(msg);
    for (const socket of clients) {
      if (socket.readyState !== socket.OPEN) continue;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) continue; // slow client: skip frame
      socket.send(data);
    }
  };

  const startRelay = (): void => {
    if (relayTimer) return;
    relayTimer = setInterval(() => {
      const frame = ctx.ring.latest();
      if (frame && frame.ts !== lastSentTs) {
        lastSentTs = frame.ts;
        broadcast({ kind: 'frame', frame });
      }
    }, 1000);
  };

  const stopRelayIfIdle = (): void => {
    if (clients.size === 0 && relayTimer) {
      clearInterval(relayTimer);
      relayTimer = null;
    }
  };

  ctx.sense.realtime.on('connected', () => broadcast({ kind: 'status', cloudConnected: true }));
  ctx.sense.realtime.on('disconnected', () => broadcast({ kind: 'status', cloudConnected: false }));

  app.get('/live', { websocket: true }, (socket: WebSocket) => {
    clients.add(socket);
    const history: LiveMessage = { kind: 'history', points: historyPoints(ctx) };
    socket.send(JSON.stringify(history));
    startRelay();
    socket.on('close', () => {
      clients.delete(socket);
      stopRelayIfIdle();
    });
    socket.on('error', () => {
      clients.delete(socket);
      stopRelayIfIdle();
    });
  });
}
