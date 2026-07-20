import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DetectionSettings } from '@sense/shared';
import { get, put } from '../api/client.js';

export function DetectionCard() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['detection-settings'],
    queryFn: () => get<DetectionSettings>('/api/detection/settings'),
  });
  const [pct, setPct] = useState('');
  useEffect(() => {
    if (settings.data && pct === '') setPct(String(Math.round(settings.data.stallMaxDutyCycle * 100)));
  }, [settings.data, pct]);

  const save = useMutation({
    mutationFn: () =>
      put<DetectionSettings>('/api/detection/settings', { stallMaxDutyCycle: Number(pct) / 100 }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['detection-settings'] }),
  });

  return (
    <div className="card space-y-3 p-4">
      <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
        Detection tuning
      </div>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
            Motor stall duty-cycle limit (%)
          </div>
          <input
            type="number"
            min={5}
            max={90}
            value={pct}
            onChange={(e) => setPct(e.target.value)}
            className="w-24 rounded-md border bg-transparent px-2 py-1.5 tabular-nums"
            style={{ borderColor: 'var(--border)' }}
          />
        </label>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || !pct}
          className="rounded-md px-4 py-1.5 text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--series-1)', color: '#fff' }}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {save.isSuccess && <span style={{ color: 'var(--status-good)' }}>Saved ✓ (applies immediately)</span>}
        {save.isError && (
          <span style={{ color: 'var(--status-critical)' }}>{(save.error as Error).message}</span>
        )}
      </div>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        A spike cluster only counts as a motor stall if its spikes are ON for less than this share
        of the cluster's timespan. Lower = stricter (fewer false alarms from thermostat-cycling
        appliances like toaster ovens); higher = more sensitive. Default 25%.
      </div>
    </div>
  );
}
