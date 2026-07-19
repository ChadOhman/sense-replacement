import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SettingsResponse, StatusResponse } from '@sense/shared';
import { get, put } from '../api/client.js';
import { PageHeader } from '../components/PageHeader.js';
import { AlertSettingsCard } from '../components/AlertSettingsCard.js';
import { formatBytes, formatRelativeTime } from '../lib/format.js';

export function Settings() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => get<SettingsResponse>('/api/settings'),
  });
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => get<StatusResponse>('/api/status'),
    refetchInterval: 5000,
  });

  const [rate, setRate] = useState('');
  const [currency, setCurrency] = useState('');
  useEffect(() => {
    if (settings.data) {
      setRate(String(settings.data.rateCentsPerKwh));
      setCurrency(settings.data.currency);
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      put<SettingsResponse>('/api/settings', {
        rateCentsPerKwh: Number(rate),
        currency: currency.toUpperCase(),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  const backfill = status.data?.backfill;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />

      <div className="card space-y-4 p-4">
        <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          Electricity cost
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
              Rate (¢/kWh)
            </div>
            <input
              type="number"
              min="0"
              step="0.1"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              className="w-28 rounded-md border bg-transparent px-2 py-1.5 tabular-nums"
              style={{ borderColor: 'var(--border)' }}
            />
          </label>
          <label className="text-sm">
            <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
              Currency
            </div>
            <input
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              maxLength={8}
              className="w-24 rounded-md border bg-transparent px-2 py-1.5 uppercase"
              style={{ borderColor: 'var(--border)' }}
            />
          </label>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !rate || !currency}
            className="rounded-md px-4 py-1.5 text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--series-1)', color: '#fff' }}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {save.isSuccess && <span style={{ color: 'var(--status-good)' }}>Saved ✓</span>}
          {save.isError && (
            <span style={{ color: 'var(--status-critical)' }}>{(save.error as Error).message}</span>
          )}
        </div>
      </div>

      <AlertSettingsCard />

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
