import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { post } from '../api/client.js';

export function SetupMfa({ message }: { message: string | null }) {
  const qc = useQueryClient();
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await post<{ ok: true }>('/api/setup/mfa', { totp });
      await qc.invalidateQueries({ queryKey: ['status'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MFA failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6 text-center">
        <div className="text-3xl">🔐</div>
        <h1 className="mt-2 text-lg font-semibold">Two-factor authentication</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {message ?? 'Your Sense account requires an authenticator code to sign in. This is needed once — tokens are stored locally afterwards.'}
        </p>
        <input
          value={totp}
          onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 8))}
          onKeyDown={(e) => e.key === 'Enter' && totp.length >= 6 && void submit()}
          inputMode="numeric"
          placeholder="123456"
          autoFocus
          className="mt-4 w-full rounded-md border bg-transparent px-3 py-2 text-center text-2xl tracking-[0.4em] tabular-nums"
          style={{ borderColor: 'var(--border)' }}
        />
        {error && (
          <div className="mt-2 text-sm" style={{ color: 'var(--status-critical)' }}>
            {error}
          </div>
        )}
        <button
          onClick={() => void submit()}
          disabled={busy || totp.length < 6}
          className="mt-4 w-full rounded-md py-2 font-medium disabled:opacity-50"
          style={{ background: 'var(--series-1)', color: '#fff' }}
        >
          {busy ? 'Verifying…' : 'Verify'}
        </button>
      </div>
    </div>
  );
}
