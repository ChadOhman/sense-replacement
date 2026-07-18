import { Link } from 'react-router-dom';
import { DeviceIcon } from './DeviceIcon.js';
import { formatWatts } from '../lib/format.js';

interface Props {
  id: string;
  name: string;
  icon: string | null;
  watts: number | null;
  linkable?: boolean;
}

export function DeviceCard({ id, name, icon, watts, linkable = true }: Props) {
  const body = (
    <div className="card flex items-center gap-3 p-3 transition-colors hover:border-neutral-500">
      <DeviceIcon icon={icon} className="text-2xl" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="text-lg font-semibold tabular-nums" style={{ color: 'var(--series-3)' }}>
          {formatWatts(watts)}
        </div>
      </div>
    </div>
  );
  return linkable ? <Link to={`/devices/${id}`}>{body}</Link> : body;
}
