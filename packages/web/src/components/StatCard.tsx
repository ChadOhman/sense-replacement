import type { ReactNode } from 'react';

interface Props {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  muted?: boolean;
}

export function StatCard({ label, value, sub, muted }: Props) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div
        className="mt-1 text-2xl font-semibold tabular-nums"
        style={{ color: muted ? 'var(--text-muted)' : 'var(--text-primary)' }}
      >
        {value}
      </div>
      {sub !== undefined && (
        <div className="mt-0.5 text-sm tabular-nums" style={{ color: 'var(--text-secondary)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}
