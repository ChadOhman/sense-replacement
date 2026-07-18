import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { DeviceListItem, DevicesResponse, SettingsResponse } from '@sense/shared';
import { get } from '../api/client.js';
import { DeviceIcon } from '../components/DeviceIcon.js';
import { PageHeader } from '../components/PageHeader.js';
import { SkeletonRows } from '../components/Skeleton.js';
import { formatCurrency, formatKwh, formatWatts } from '../lib/format.js';

type SortKey = 'name' | 'nowW' | 'todayKwh' | 'monthKwh' | 'monthCost';

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: 'name', label: 'Device', numeric: false },
  { key: 'nowW', label: 'Now', numeric: true },
  { key: 'todayKwh', label: 'Today', numeric: true },
  { key: 'monthKwh', label: 'This month', numeric: true },
  { key: 'monthCost', label: 'Cost', numeric: true },
];

export function Devices() {
  const navigate = useNavigate();
  const [sortKey, setSortKey] = useState<SortKey>('nowW');
  const [asc, setAsc] = useState(false);
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => get<DevicesResponse>('/api/devices'),
    refetchInterval: 15_000,
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => get<SettingsResponse>('/api/settings'),
  });
  const currency = settings.data?.currency ?? 'USD';

  const sorted = (devices.data?.devices ?? []).slice().sort((a, b) => {
    const dir = asc ? 1 : -1;
    if (sortKey === 'name') return a.name.localeCompare(b.name) * dir;
    const av = (a[sortKey] as number | null) ?? -1;
    const bv = (b[sortKey] as number | null) ?? -1;
    return (av - bv) * dir;
  });

  const clickSort = (key: SortKey): void => {
    if (key === sortKey) setAsc(!asc);
    else {
      setSortKey(key);
      setAsc(key === 'name');
    }
  };

  return (
    <div>
      <PageHeader title="Devices" />
      {devices.isLoading ? (
        <SkeletonRows rows={6} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    onClick={() => clickSort(c.key)}
                    className={`cursor-pointer select-none px-4 py-3 font-medium ${c.numeric ? 'text-right' : 'text-left'}`}
                  >
                    {c.label}
                    {sortKey === c.key ? (asc ? ' ↑' : ' ↓') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((d: DeviceListItem) => (
                <tr
                  key={d.id}
                  onClick={() => navigate(`/devices/${d.id}`)}
                  className="cursor-pointer border-t transition-colors hover:bg-neutral-800/50"
                  style={{ borderColor: 'var(--border)', opacity: d.revoked ? 0.5 : 1 }}
                >
                  <td className="px-4 py-3">
                    <span className="mr-2">
                      <DeviceIcon icon={d.icon} />
                    </span>
                    {d.name}
                    {d.revoked && (
                      <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                        (removed)
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums" style={{ color: d.nowW ? 'var(--series-3)' : undefined }}>
                    {formatWatts(d.nowW)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatKwh(d.todayKwh)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatKwh(d.monthKwh)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(d.monthCost, currency)}</td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                    No devices yet — Sense discovers devices over time.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
