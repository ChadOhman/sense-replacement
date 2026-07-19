import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AlertKind, AlertSettings, DevicesResponse } from '@sense/shared';
import { get, post, put } from '../api/client.js';

const KIND_LABELS: Record<AlertKind, string> = {
  brownout: 'Brownouts',
  neutral: 'Floating neutral',
  stall: 'Motor stalls',
  device_finished: 'Device finished',
  alwayson_creep: 'Always-on creep',
  device_anomaly: 'Device anomalies',
};

export function AlertSettingsCard() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['alert-settings'],
    queryFn: () => get<AlertSettings>('/api/alerts/settings'),
  });
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => get<DevicesResponse>('/api/devices'),
  });

  const [draft, setDraft] = useState<AlertSettings | null>(null);
  useEffect(() => {
    if (settings.data && !draft) setDraft(settings.data);
  }, [settings.data, draft]);

  const save = useMutation({
    mutationFn: (s: AlertSettings) => put<AlertSettings>('/api/alerts/settings', s),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alert-settings'] }),
  });
  const test = useMutation({
    mutationFn: () => post<{ ok: boolean; results: string[] }>('/api/alerts/test', {}),
  });

  if (!draft) return null;
  const update = (patch: Partial<AlertSettings>): void => setDraft({ ...draft, ...patch });

  return (
    <div className="card space-y-4 p-4">
      <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
        Notifications
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
            ntfy topic URL
          </div>
          <input
            value={draft.ntfyUrl}
            onChange={(e) => update({ ntfyUrl: e.target.value })}
            placeholder="https://ntfy.sh/your-secret-topic"
            className="w-full rounded-md border bg-transparent px-2 py-1.5"
            style={{ borderColor: 'var(--border)' }}
          />
        </label>
        <label className="text-sm">
          <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
            Webhook URL (JSON POST)
          </div>
          <input
            value={draft.webhookUrl}
            onChange={(e) => update({ webhookUrl: e.target.value })}
            placeholder="https://…"
            className="w-full rounded-md border bg-transparent px-2 py-1.5"
            style={{ borderColor: 'var(--border)' }}
          />
        </label>
      </div>

      <div>
        <div className="mb-1.5 text-sm" style={{ color: 'var(--text-muted)' }}>
          Alert types
        </div>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(KIND_LABELS) as AlertKind[]).map((kind) => (
            <button
              key={kind}
              onClick={() => update({ enabled: { ...draft.enabled, [kind]: !draft.enabled[kind] } })}
              className="rounded-full px-3 py-1 text-sm transition-colors"
              style={{
                background: draft.enabled[kind] ? 'var(--series-1)' : 'var(--surface-2)',
                color: draft.enabled[kind] ? '#fff' : 'var(--text-muted)',
              }}
            >
              {KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
            Quiet hours
          </div>
          <div className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={draft.quietHours !== null}
              onChange={(e) =>
                update({ quietHours: e.target.checked ? { startHour: 22, endHour: 7 } : null })
              }
            />
            {draft.quietHours && (
              <>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={draft.quietHours.startHour}
                  onChange={(e) =>
                    update({ quietHours: { ...draft.quietHours!, startHour: Number(e.target.value) } })
                  }
                  className="w-14 rounded-md border bg-transparent px-1 py-1 tabular-nums"
                  style={{ borderColor: 'var(--border)' }}
                />
                <span style={{ color: 'var(--text-muted)' }}>to</span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={draft.quietHours.endHour}
                  onChange={(e) =>
                    update({ quietHours: { ...draft.quietHours!, endHour: Number(e.target.value) } })
                  }
                  className="w-14 rounded-md border bg-transparent px-1 py-1 tabular-nums"
                  style={{ borderColor: 'var(--border)' }}
                />
                <span style={{ color: 'var(--text-muted)' }}>(urgent alerts still send)</span>
              </>
            )}
          </div>
        </label>
      </div>

      {draft.enabled.device_finished && (
        <div className="text-sm">
          <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
            Notify when these devices finish (after ≥{' '}
            <input
              type="number"
              min={0}
              value={Math.round(draft.finishedMinRuntimeS / 60)}
              onChange={(e) => update({ finishedMinRuntimeS: Number(e.target.value) * 60 })}
              className="w-14 rounded-md border bg-transparent px-1 py-0.5 tabular-nums"
              style={{ borderColor: 'var(--border)' }}
            />{' '}
            min run)
          </div>
          <div className="flex flex-wrap gap-2">
            {(devices.data?.devices ?? [])
              .filter((d) => !d.revoked)
              .map((d) => {
                const selected = draft.finishedDeviceIds.includes(d.id);
                return (
                  <button
                    key={d.id}
                    onClick={() =>
                      update({
                        finishedDeviceIds: selected
                          ? draft.finishedDeviceIds.filter((id) => id !== d.id)
                          : [...draft.finishedDeviceIds, d.id],
                      })
                    }
                    className="rounded-full px-3 py-1 text-sm"
                    style={{
                      background: selected ? 'var(--series-2)' : 'var(--surface-2)',
                      color: selected ? '#000' : 'var(--text-muted)',
                    }}
                  >
                    {d.name}
                  </button>
                );
              })}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() => save.mutate(draft)}
          disabled={save.isPending}
          className="rounded-md px-4 py-1.5 text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--series-1)', color: '#fff' }}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={() => test.mutate()}
          disabled={test.isPending || (!draft.ntfyUrl && !draft.webhookUrl)}
          className="rounded-md px-4 py-1.5 text-sm disabled:opacity-50"
          style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
        >
          Send test
        </button>
        {save.isSuccess && <span className="text-sm" style={{ color: 'var(--status-good)' }}>Saved ✓</span>}
        {test.isSuccess && (
          <span className="text-sm" style={{ color: 'var(--status-good)' }}>
            {test.data.results.join(' · ')}
          </span>
        )}
        {(save.isError || test.isError) && (
          <span className="text-sm" style={{ color: 'var(--status-critical)' }}>
            {((save.error ?? test.error) as Error).message}
          </span>
        )}
      </div>
    </div>
  );
}
