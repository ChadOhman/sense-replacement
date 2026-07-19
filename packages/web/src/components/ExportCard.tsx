import { useState } from 'react';

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86400_000);
  return d.toISOString().slice(0, 10);
}

export function ExportCard() {
  const [from, setFrom] = useState(daysAgo(365));
  const [to, setTo] = useState(daysAgo(0));
  const inputStyle = { borderColor: 'var(--border)' };
  const range = `from=${from}&to=${to}`;

  const links = [
    { label: 'Daily usage (CSV)', href: `/api/export/usage.csv?${range}` },
    { label: 'Per-device usage (CSV)', href: `/api/export/devices.csv?${range}` },
    {
      label: 'Hourly power (CSV)',
      href: `/api/export/power.csv?from=${Math.floor(new Date(`${from}T00:00:00`).getTime() / 1000)}&to=${Math.floor(new Date(`${to}T23:59:59`).getTime() / 1000)}&resolution=3600`,
    },
    { label: 'Full database (.db)', href: '/api/export/database' },
  ];

  return (
    <div className="card space-y-3 p-4">
      <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
        Export your data
      </div>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
            From
          </div>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border bg-transparent px-2 py-1.5"
            style={inputStyle}
          />
        </label>
        <label>
          <div className="mb-1" style={{ color: 'var(--text-muted)' }}>
            To
          </div>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border bg-transparent px-2 py-1.5"
            style={inputStyle}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        {links.map((l) => (
          <a
            key={l.label}
            href={l.href}
            className="rounded-md px-3 py-1.5 text-sm"
            style={{ background: 'var(--surface-2)', color: 'var(--series-1)' }}
          >
            ⬇ {l.label}
          </a>
        ))}
      </div>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        The full database download is a consistent snapshot — everything the app knows, yours to
        keep.
      </div>
    </div>
  );
}
