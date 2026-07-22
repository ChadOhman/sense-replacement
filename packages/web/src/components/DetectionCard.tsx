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
  const [triggerW, setTriggerW] = useState('');
  const [splitDistance, setSplitDistance] = useState('');
  useEffect(() => {
    if (!settings.data) return;
    if (pct === '') setPct(String(Math.round(settings.data.stallMaxDutyCycle * 100)));
    if (triggerW === '') setTriggerW(String(settings.data.nilmTriggerW));
    if (splitDistance === '') setSplitDistance(String(settings.data.nilmClusterSplitDistance));
  }, [settings.data, pct, triggerW, splitDistance]);

  const save = useMutation({
    mutationFn: () =>
      put<DetectionSettings>('/api/detection/settings', {
        stallMaxDutyCycle: Number(pct) / 100,
        nilmTriggerW: Number(triggerW),
        nilmClusterSplitDistance: Number(splitDistance),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['detection-settings'] }),
  });

  const inputClass = 'w-24 rounded-md border bg-transparent px-2 py-1.5 tabular-nums';
  const inputStyle = { borderColor: 'var(--border)' };

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
            className={inputClass}
            style={inputStyle}
          />
        </label>
        <label>
          <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
            NILM trigger (W)
          </div>
          <input
            type="number"
            min={5}
            max={500}
            value={triggerW}
            onChange={(e) => setTriggerW(e.target.value)}
            className={inputClass}
            style={inputStyle}
          />
        </label>
        <label>
          <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
            NILM cluster split distance
          </div>
          <input
            type="number"
            min={20}
            max={2000}
            value={splitDistance}
            onChange={(e) => setSplitDistance(e.target.value)}
            className={inputClass}
            style={inputStyle}
          />
        </label>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || !pct || !triggerW || !splitDistance}
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
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        NILM trigger is the per-second power change that captures a detection event — below ~20 W
        household noise triggers constantly. Split distance controls how different two waveform
        clusters must be to stay separate on the Detection page; lower splits more aggressively.
        Defaults 20 W / 200.
      </div>
    </div>
  );
}
