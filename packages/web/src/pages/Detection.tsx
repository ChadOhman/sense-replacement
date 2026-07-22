import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  NilmClustersResponse,
  NilmDevice,
  NilmDevicesResponse,
  NilmReclusterResponse,
  NilmStatusResponse,
} from '@sense/shared';
import { get, post, put } from '../api/client.js';
import { useLiveSocket } from '../hooks/useLiveSocket.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatCard } from '../components/StatCard.js';
import { WaveformChart } from '../components/charts/WaveformChart.js';
import { formatRelativeTime, formatWatts } from '../lib/format.js';

function DirectionBadge({ direction }: { direction: 'on' | 'off' }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-medium"
      style={{
        background: 'var(--surface-2)',
        color: direction === 'on' ? 'var(--status-good)' : 'var(--text-muted)',
      }}
    >
      {direction === 'on' ? '▲ on' : '▼ off'}
    </span>
  );
}

function ClusterCard({
  cluster,
  devices,
}: {
  cluster: NilmClustersResponse['clusters'][number];
  devices: NilmDevice[];
}) {
  const qc = useQueryClient();
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['nilm-clusters'] });
    void qc.invalidateQueries({ queryKey: ['nilm-devices'] });
    void qc.invalidateQueries({ queryKey: ['nilm-status'] });
  };

  const assign = useMutation({
    mutationFn: (deviceId: number | null) =>
      put<{ ok: boolean }>(`/api/nilm/clusters/${cluster.id}`, { deviceId }),
    onSuccess: invalidate,
  });
  const createAndAssign = useMutation({
    mutationFn: async (name: string) => {
      const res = await post<NilmDevicesResponse>('/api/nilm/devices', { name });
      const device = res.devices.find((d) => d.name === name);
      if (device) await put(`/api/nilm/clusters/${cluster.id}`, { deviceId: device.id });
    },
    onSuccess: invalidate,
  });

  const onSelect = (value: string): void => {
    if (value === '') {
      assign.mutate(null);
    } else if (value === '__new__') {
      const name = window.prompt('Name this device (e.g. "Fridge", "EV charger"):')?.trim();
      if (name) createAndAssign.mutate(name);
    } else {
      assign.mutate(Number(value));
    }
  };

  return (
    <div className="card space-y-2 p-3">
      <div className="flex items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-2">
          <DirectionBadge direction={cluster.direction} />
          <span style={{ color: 'var(--text-secondary)' }}>
            {cluster.size}× · {cluster.occurrences7d} this week
          </span>
        </div>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {cluster.lastSeenTs !== null ? formatRelativeTime(cluster.lastSeenTs) : 'never seen'}
        </span>
      </div>
      <WaveformChart waveform={cluster.profile} />
      <select
        value={cluster.deviceId ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        disabled={assign.isPending || createAndAssign.isPending}
        className="w-full rounded-md border bg-transparent px-2 py-1.5 text-sm"
        style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}
      >
        <option value="">— unlabeled —</option>
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
        <option value="__new__">＋ New device…</option>
      </select>
    </div>
  );
}

function DeviceRow({ device }: { device: NilmDevice }) {
  const qc = useQueryClient();
  const [estW, setEstW] = useState(device.estW !== null ? String(device.estW) : '');
  const [offDelayMin, setOffDelayMin] = useState(
    device.offDelayS !== null ? String(Math.round(device.offDelayS / 60)) : '',
  );
  const [maxDist, setMaxDist] = useState(
    device.maxMatchDistance !== null ? String(device.maxMatchDistance) : '',
  );

  const save = useMutation({
    mutationFn: () =>
      put<NilmDevicesResponse>(`/api/nilm/devices/${device.id}`, {
        name: device.name,
        icon: device.icon,
        estW: estW === '' ? null : Number(estW),
        offDelayS: offDelayMin === '' ? null : Number(offDelayMin) * 60,
        maxMatchDistance: maxDist === '' ? null : Number(maxDist),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nilm-devices'] }),
  });

  const inputClass = 'w-20 rounded-md border bg-transparent px-2 py-1 text-sm tabular-nums';
  const inputStyle = { borderColor: 'var(--border)' };

  return (
    <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
      <td className="py-2 pr-3 font-medium">{device.name}</td>
      <td className="py-2 pr-3">
        <input
          type="number"
          placeholder="auto"
          value={estW}
          onChange={(e) => setEstW(e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
      </td>
      <td className="py-2 pr-3">
        <input
          type="number"
          placeholder="—"
          value={offDelayMin}
          onChange={(e) => setOffDelayMin(e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
      </td>
      <td className="py-2 pr-3">
        <input
          type="number"
          placeholder="auto"
          value={maxDist}
          onChange={(e) => setMaxDist(e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
      </td>
      <td className="py-2">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-md px-3 py-1 text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
        >
          {save.isPending ? '…' : save.isSuccess ? 'Saved ✓' : 'Save'}
        </button>
        {save.isError && (
          <span className="ml-2 text-xs" style={{ color: 'var(--status-critical)' }}>
            {(save.error as Error).message}
          </span>
        )}
      </td>
    </tr>
  );
}

export function Detection() {
  const { frame } = useLiveSocket();
  const qc = useQueryClient();

  const status = useQuery({
    queryKey: ['nilm-status'],
    queryFn: () => get<NilmStatusResponse>('/api/nilm/status'),
    refetchInterval: 10_000,
  });
  const clusters = useQuery({
    queryKey: ['nilm-clusters'],
    queryFn: () => get<NilmClustersResponse>('/api/nilm/clusters'),
    refetchInterval: 60_000,
  });
  const devices = useQuery({
    queryKey: ['nilm-devices'],
    queryFn: () => get<NilmDevicesResponse>('/api/nilm/devices'),
  });

  const recluster = useMutation({
    mutationFn: () => post<NilmReclusterResponse>('/api/nilm/recluster', {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nilm-clusters'] });
      void qc.invalidateQueries({ queryKey: ['nilm-status'] });
    },
  });

  const nilm = frame?.nilm ?? status.data?.live ?? null;
  const deviceList = devices.data?.devices ?? [];
  const clusterList = clusters.data?.clusters ?? [];
  const unlabeled = clusterList.filter((c) => c.deviceId === null);
  const labeled = clusterList.filter((c) => c.deviceId !== null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Detection"
        actions={
          <button
            onClick={() => recluster.mutate()}
            disabled={recluster.isPending}
            className="rounded-md px-4 py-1.5 text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--series-1)', color: '#fff' }}
          >
            {recluster.isPending ? 'Clustering…' : 'Re-cluster now'}
          </button>
        }
      />

      <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        Local device detection, independent of the Sense cloud: sudden power changes are captured as
        waveforms, similar ones are clustered, and clusters you label become devices the live
        matcher tracks from then on.
      </div>
      {recluster.isSuccess && (
        <div className="text-sm" style={{ color: 'var(--status-good)' }}>
          Clustering done — {recluster.data.newClusters} new cluster
          {recluster.data.newClusters === 1 ? '' : 's'}, {recluster.data.assigned} event
          {recluster.data.assigned === 1 ? '' : 's'} absorbed into existing ones.
        </div>
      )}
      {recluster.isError && (
        <div className="text-sm" style={{ color: 'var(--status-critical)' }}>
          {(recluster.error as Error).message}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Unknown power" value={formatWatts(nilm?.unknownW)} />
        <StatCard label="Baseline (1h floor)" value={formatWatts(nilm?.baselineW)} />
        <StatCard label="Captured events" value={String(status.data?.eventCount ?? '—')} />
        <StatCard
          label="Last clustering"
          value={
            status.data?.lastClusterRunTs != null
              ? formatRelativeTime(status.data.lastClusterRunTs)
              : 'never'
          }
        />
      </div>

      <div>
        <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          On now (locally detected)
        </div>
        {nilm && nilm.devices.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {nilm.devices.map((d) => (
              <span
                key={d.id}
                className="rounded-full px-3 py-1 text-sm"
                style={{ background: 'var(--surface-2)' }}
              >
                <span className="font-medium">{d.name}</span>{' '}
                <span className="tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {formatWatts(d.estW)}
                </span>{' '}
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  since {formatRelativeTime(d.sinceTs)}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <div className="card p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
            Nothing matched right now — label some clusters below and their devices will show up
            here when they switch on.
          </div>
        )}
      </div>

      {deviceList.length > 0 && (
        <div className="card p-4">
          <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            Devices
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="pb-2 pr-3 font-normal">Name</th>
                  <th className="pb-2 pr-3 font-normal">Est. watts</th>
                  <th className="pb-2 pr-3 font-normal">Off delay (min)</th>
                  <th className="pb-2 pr-3 font-normal">Match distance</th>
                  <th className="pb-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {deviceList.map((d) => (
                  <DeviceRow key={d.id} device={d} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            Est. watts overrides the per-event estimate. Off delay auto-turns a device off N minutes
            after it turns on — for loads whose off transition is invisible (fridges). Match
            distance overrides how strictly events must resemble this device's clusters.
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            Unlabeled clusters {unlabeled.length > 0 && `(${unlabeled.length})`}
          </div>
          {status.data != null && status.data.unclusteredCount > 0 && (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {status.data.unclusteredCount} captured event
              {status.data.unclusteredCount === 1 ? '' : 's'} awaiting clustering
            </div>
          )}
        </div>
        {unlabeled.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {unlabeled.map((c) => (
              <ClusterCard key={c.id} cluster={c} devices={deviceList} />
            ))}
          </div>
        ) : (
          <div className="card p-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            {clusters.isLoading
              ? 'Loading…'
              : 'No unlabeled clusters. Events accumulate as appliances switch — run "Re-cluster now" once a day or two of data has built up.'}
          </div>
        )}
      </div>

      {labeled.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            Labeled clusters
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {labeled.map((c) => (
              <ClusterCard key={c.id} cluster={c} devices={deviceList} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
