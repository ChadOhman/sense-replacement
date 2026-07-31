import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SenseRealtimeSocket } from './realtime.js';

/** An HTTP server that rejects every websocket upgrade with the given status. */
function rejectingServer(status: number): Promise<Server> {
  const server = createServer();
  server.on('upgrade', (_req, socket) => {
    socket.end(`HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\n\r\n`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('SenseRealtimeSocket', () => {
  let server: Server;
  let socket: SenseRealtimeSocket | null = null;
  let uncaught: Error[] = [];

  const captureUncaught = (err: Error): void => {
    uncaught.push(err);
  };

  beforeEach(async () => {
    server = await rejectingServer(401);
    uncaught = [];
    // Vitest installs its own handler; ours records without failing the run so
    // the assertion below can report the crash precisely.
    process.on('uncaughtException', captureUncaught);
  });

  afterEach(async () => {
    process.off('uncaughtException', captureUncaught);
    socket?.stop();
    socket = null;
    await new Promise((resolve) => server.close(resolve));
  });

  it('survives a 401 handshake rejection and reports the auth failure', async () => {
    const { port } = server.address() as AddressInfo;
    const logs: string[] = [];
    let authFailures = 0;

    socket = new SenseRealtimeSocket({
      getMonitorId: () => 1,
      getAccessToken: () => 'stale-token',
      onAuthFailure: async () => {
        authFailures += 1;
      },
      mode: 'persistent',
      log: (msg) => logs.push(msg),
      baseUrl: `ws://127.0.0.1:${port}/monitors`,
    });

    socket.start();

    // Wait for the rejection to be handled, plus a few ticks for the deferred
    // 'error' emit that ws queues when closing a still-connecting socket.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(logs.some((m) => m.includes('connect rejected with HTTP 401'))).toBe(true);
    expect(authFailures).toBeGreaterThan(0);
    expect(socket.isConnected).toBe(false);
    // Regression: teardown() used to removeAllListeners() before close(), so
    // ws's deferred 'error' had no listener and took the whole process down.
    expect(uncaught).toEqual([]);
  });
});
