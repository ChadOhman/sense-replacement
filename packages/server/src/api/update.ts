import type { FastifyInstance } from 'fastify';
import type { UpdateStatusResponse } from '@sense/shared';
import type { AppContext } from '../context.js';
import { getUpdateEnv } from '../update/env.js';
import { checkForUpdate, getUpdateCheck, isUpdateAvailable } from '../update/check.js';
import { getPreviousVersion, getUpdateState } from '../update/state.js';
import { getVersion } from '../update/version.js';

function buildStatus(ctx: AppContext): UpdateStatusResponse {
  const env = getUpdateEnv(ctx.config);
  const check = getUpdateCheck(ctx.kv);
  return {
    supported: env.supported,
    ...(env.reason ? { unsupportedReason: env.reason } : {}),
    current: getVersion(),
    latest: check?.latest
      ? {
          sha: check.latest.sha,
          shortSha: check.latest.shortSha,
          builtAt: check.latest.builtAt,
          sizeBytes: check.latest.sizeBytes,
        }
      : null,
    updateAvailable: isUpdateAvailable(ctx.kv),
    lastCheckedTs: check?.checkedTs ?? null,
    checkError: check?.error ?? null,
    state: getUpdateState(ctx.kv),
    previous: getPreviousVersion(ctx.kv),
  };
}

export function registerUpdateRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/update/status', async (): Promise<UpdateStatusResponse> => buildStatus(ctx));

  app.post('/update/check', async (): Promise<UpdateStatusResponse> => {
    await checkForUpdate(ctx.kv, ctx.config.updateManifestUrl);
    return buildStatus(ctx);
  });

  app.post('/update/install', async (_req, reply) => {
    try {
      ctx.updater.startUpdate();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes('already in progress') ? 409 : 400;
      return reply.status(code).send({ error: message });
    }
    return reply.status(202).send({ ok: true });
  });

  app.post('/update/rollback', async (_req, reply) => {
    try {
      ctx.updater.startRollback();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes('already in progress') ? 409 : 400;
      return reply.status(code).send({ error: message });
    }
    return reply.status(202).send({ ok: true });
  });
}
