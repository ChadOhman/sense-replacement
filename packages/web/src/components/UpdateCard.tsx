import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateStatusResponse } from '@sense/shared';
import { get, post } from '../api/client.js';
import { UpdateModal } from './UpdateModal.js';
import { formatRelativeTime } from '../lib/format.js';

/** Settings-page "Software update" card: version info, manual check,
 *  install and rollback entry points (progress lives in UpdateModal). */
export function UpdateCard() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);

  const status = useQuery({
    queryKey: ['update-status'],
    queryFn: () => get<UpdateStatusResponse>('/api/update/status'),
    refetchInterval: 30_000,
    retry: false,
  });

  const check = useMutation({
    mutationFn: () => post<UpdateStatusResponse>('/api/update/check', {}),
    onSuccess: (data) => qc.setQueryData(['update-status'], data),
  });
  const rollback = useMutation({
    mutationFn: () => post<{ ok: boolean }>('/api/update/rollback', {}),
    onSuccess: () => {
      setConfirmRollback(false);
      setModalOpen(true);
      void qc.invalidateQueries({ queryKey: ['update-status'] });
    },
  });

  const s = status.data;
  const builtAt = s?.current.builtAt ? new Date(s.current.builtAt).toLocaleDateString() : null;

  return (
    <div className="card space-y-3 p-4">
      <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
        Software update
      </div>

      {!s ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading…
        </div>
      ) : !s.supported ? (
        <div className="space-y-2 text-sm">
          <div>
            Version <span className="tabular-nums">{s.current.shortSha}</span>
            {builtAt && <span style={{ color: 'var(--text-muted)' }}> · built {builtAt}</span>}
          </div>
          <div style={{ color: 'var(--text-muted)' }}>
            Self-update unavailable: {s.unsupportedReason}
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <div style={{ color: 'var(--text-muted)' }}>Installed</div>
              <div className="tabular-nums">
                {s.current.shortSha}
                {builtAt && <span style={{ color: 'var(--text-muted)' }}> · {builtAt}</span>}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)' }}>Latest</div>
              <div className="tabular-nums">{s.latest?.shortSha ?? 'unknown'}</div>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)' }}>Last checked</div>
              <div className="tabular-nums">{formatRelativeTime(s.lastCheckedTs)}</div>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)' }}>Status</div>
              <div style={{ color: s.updateAvailable ? 'var(--status-warning)' : 'var(--status-good)' }}>
                {s.updateAvailable ? 'update available' : 'up to date'}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => check.mutate()}
              disabled={check.isPending}
              className="rounded-md px-4 py-1.5 text-sm font-medium disabled:opacity-50"
              style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
            >
              {check.isPending ? 'Checking…' : 'Check for updates'}
            </button>
            {s.updateAvailable && (
              <button
                onClick={() => setModalOpen(true)}
                className="rounded-md px-4 py-1.5 text-sm font-medium"
                style={{ background: 'var(--series-1)', color: '#fff' }}
              >
                Install update
              </button>
            )}
            {s.previous && !confirmRollback && (
              <button
                onClick={() => setConfirmRollback(true)}
                className="rounded-md px-4 py-1.5 text-sm font-medium"
                style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
              >
                Roll back to {s.previous.shortSha}
              </button>
            )}
            {s.previous && confirmRollback && (
              <>
                <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Revert to {s.previous.shortSha} and restart?
                </span>
                <button
                  onClick={() => rollback.mutate()}
                  disabled={rollback.isPending}
                  className="rounded-md px-4 py-1.5 text-sm font-medium disabled:opacity-50"
                  style={{ background: 'var(--status-critical)', color: '#fff' }}
                >
                  {rollback.isPending ? 'Starting…' : 'Yes, roll back'}
                </button>
                <button
                  onClick={() => setConfirmRollback(false)}
                  className="rounded-md px-4 py-1.5 text-sm font-medium"
                  style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>

          {(check.isError || rollback.isError) && (
            <div className="text-sm" style={{ color: 'var(--status-critical)' }}>
              {((check.error ?? rollback.error) as Error).message}
            </div>
          )}
          {s.checkError && (
            <div className="text-sm" style={{ color: 'var(--status-warning)' }}>
              Last check failed: {s.checkError}
            </div>
          )}
        </>
      )}

      {modalOpen && <UpdateModal onClose={() => setModalOpen(false)} />}
    </div>
  );
}
