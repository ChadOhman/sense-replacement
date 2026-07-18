import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SetupStatusResponse } from '@sense/shared';
import type { AppContext } from '../context.js';

const mfaSchema = z.object({
  totp: z.string().regex(/^\d{6,8}$/),
});

export function registerSetupRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/setup/status', async (): Promise<SetupStatusResponse> => ({
    authState: ctx.sense.authState,
    message: ctx.sense.authMessage,
  }));

  app.post('/setup/mfa', async (req, reply) => {
    const parsed = mfaSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Enter a 6-digit code' });
    try {
      await ctx.sense.submitMfa(parsed.data.totp);
      return { ok: true };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'MFA failed' });
    }
  });
}
