import { NavLink, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { StatusResponse } from '@sense/shared';
import { get } from './api/client.js';
import { Live } from './pages/Live.js';
import { Devices } from './pages/Devices.js';
import { DeviceDetail } from './pages/DeviceDetail.js';
import { Trends } from './pages/Trends.js';
import { PowerQuality } from './pages/PowerQuality.js';
import { Settings } from './pages/Settings.js';
import { SetupMfa } from './pages/SetupMfa.js';

const NAV = [
  { to: '/', label: 'Live', icon: '⚡' },
  { to: '/devices', label: 'Devices', icon: '🔌' },
  { to: '/trends', label: 'Trends', icon: '📊' },
  { to: '/power-quality', label: 'Power', icon: '🩺' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
];

function Nav() {
  const link = ({ isActive }: { isActive: boolean }): React.CSSProperties => ({
    color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
    background: isActive ? 'var(--surface-2)' : 'transparent',
  });
  return (
    <>
      {/* desktop sidebar */}
      <nav
        className="fixed inset-y-0 left-0 hidden w-48 flex-col gap-1 border-r p-3 md:flex"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
      >
        <div className="mb-4 px-2 pt-1 text-sm font-bold tracking-wide">⚡ Sense Monitor</div>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            style={link}
            className="rounded-md px-3 py-2 text-sm font-medium transition-colors"
          >
            <span className="mr-2">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}
      </nav>
      {/* mobile bottom bar */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 flex border-t md:hidden"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
      >
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            style={link}
            className="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs"
          >
            <span className="text-base">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

export function App() {
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => get<StatusResponse>('/api/status'),
    refetchInterval: 5000,
  });

  if (status.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ color: 'var(--text-muted)' }}>
        Connecting…
      </div>
    );
  }

  if (status.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="card max-w-sm p-6 text-center">
          <div className="text-3xl">📡</div>
          <div className="mt-2 font-semibold">Can't reach the server</div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {(status.error as Error).message}
          </div>
        </div>
      </div>
    );
  }

  const s = status.data!;
  if (s.authState === 'needs_mfa') {
    return <SetupMfa message={null} />;
  }
  if (s.authState === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="card max-w-md p-6 text-center">
          <div className="text-3xl">⚠️</div>
          <div className="mt-2 font-semibold">Sense sign-in failed</div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            Check SENSE_EMAIL / SENSE_PASSWORD in your .env and restart. Archived data is still served via the API.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-5xl px-4 pb-20 pt-4 md:pb-8 md:pl-52">
        {!s.cloudConnected && s.authState === 'ok' && (
          <div
            className="mb-4 rounded-md px-3 py-2 text-sm"
            style={{ background: 'var(--surface-2)', color: 'var(--status-warning)' }}
          >
            Sense cloud disconnected — showing archived data
          </div>
        )}
        <Routes>
          <Route path="/" element={<Live />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/devices/:id" element={<DeviceDetail />} />
          <Route path="/trends" element={<Trends />} />
          <Route path="/power-quality" element={<PowerQuality />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
