import type { FastifyInstance } from 'fastify';
import type { CycleReport, ReportsResponse } from '@sense/shared';
import type { AppContext } from '../context.js';

export function registerReportRoutes(app: FastifyInstance, ctx: AppContext): void {
  const stmt = ctx.db.prepare('SELECT json FROM reports ORDER BY period DESC LIMIT 24');

  app.get('/reports', async (): Promise<ReportsResponse> => {
    const rows = stmt.all() as { json: string }[];
    const reports: CycleReport[] = [];
    for (const r of rows) {
      try {
        reports.push(JSON.parse(r.json) as CycleReport);
      } catch {
        /* skip corrupt rows */
      }
    }
    return { reports };
  });
}
