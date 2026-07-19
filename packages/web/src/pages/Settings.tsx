import { useQuery } from '@tanstack/react-query';
import type { StatusResponse } from '@sense/shared';
import { get } from '../api/client.js';
import { PageHeader } from '../components/PageHeader.js';
import { AlertSettingsCard } from '../components/AlertSettingsCard.js';
import { RatePlanCard } from '../components/RatePlanCard.js';
import { ExportCard } from '../components/ExportCard.js';
import { formatBytes, formatRelativeTime } from '../lib/format.js';

export function Settings() {
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => get<StatusResponse>('/api/status'),
    refetchInterval: 5000,
  });

  const backfill = status.data?.backfill;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />

      <RatePlanCard />

      <AlertSettingsCard />

      <ExportCard />

      <div className="card space-y-3 p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            System
          </div>
          {status.data?.mock && (
            <span
              className="rounded-full px-2 py-0.5 text-xs font-medium"
              style={{ background: 'var(--status-warning)', color: '#000' }}
            >
              MOCK MODE
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div>
            <div style={{ color: 'var(--text-muted)' }}>Sense cloud</div>
            <div style={{ color: status.data?.cloudConnected ? 'var(--status-good)' : 'var(--status-critical)' }}>
              {status.data?.cloudConnected ? 'connected' : 'disconnected'}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)' }}>Auth</div>
            <div>{status.data?.authState ?? '…'}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)' }}>Database</div>
            <div className="tabular-nums">{status.data ? formatBytes(status.data.dbSizeBytes) : '…'}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)' }}>Last backup</div>
            <div className="tabular-nums">
              {status.data?.lastBackup
                ? `${formatRelativeTime(status.data.lastBackup.ts)} (${formatBytes(status.data.lastBackup.sizeBytes)})`
                : 'never'}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)' }}>History backfill</div>
            <div className="tabular-nums">
              {backfill
                ? backfill.state === 'done'
                  ? `done (${backfill.daysArchived} days)`
                  : backfill.state === 'running'
                    ? `${backfill.daysArchived} days (at ${backfill.cursor})`
                    : 'not started'
                : '…'}
            </div>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          Collectors
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
              <th className="py-1.5 font-medium">Job</th>
              <th className="py-1.5 font-medium">Last success</th>
              <th className="py-1.5 font-medium">Last error</th>
            </tr>
          </thead>
          <tbody>
            {(status.data?.collectors ?? []).map((c) => (
              <tr key={c.name} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="py-1.5">{c.name}</td>
                <td className="py-1.5 tabular-nums">{formatRelativeTime(c.lastSuccess)}</td>
                <td className="py-1.5" style={{ color: c.lastError ? 'var(--status-critical)' : 'var(--text-muted)' }}>
                  {c.lastError ?? '—'}
                </td>
              </tr>
            ))}
            {(status.data?.collectors.length ?? 0) === 0 && (
              <tr>
                <td colSpan={3} className="py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                  Collectors not running yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
