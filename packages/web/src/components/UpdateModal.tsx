import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateStatusResponse, UpdateStep } from '@sense/shared';
import { get, post } from '../api/client.js';
import { Modal } from './Modal.js';

const ACTIVE_PHASES = ['downloading', 'verifying', 'installing', 'restarting', 'rolling-back'];
const GAP_HINT_MS = 3 * 60_000;

function StepRow({ step }: { step: UpdateStep }) {
  const icon =
    step.status === 'ok' ? '✓' : step.status === 'error' ? '✗' : step.status === 'active' ? '⟳' : '○';
  const color =
    step.status === 'ok'
      ? 'var(--status-good)'
      : step.status === 'error'
        ? 'var(--status-critical)'
        : step.status === 'active'
          ? 'var(--text-primary)'
          : 'var(--text-muted)';
  return (
    <div className="flex items-center gap-2 text-sm" style={{ color }}>
      <span className={step.status === 'active' ? 'inline-block animate-spin' : ''}>{icon}</span>
      <span>{step.name}</span>
      {step.detail && <span style={{ color: 'var(--text-muted)' }}>({step.detail})</span>}
    </div>
  );
}

export function UpdateModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['update-status'],
    queryFn: () => get<UpdateStatusResponse>('/api/update/status'),
    refetchInterval: 1500,
    // Keep polling when the tab is backgrounded — the user may switch away
    // during the restart and must still see the outcome on return.
    refetchIntervalInBackground: true,
    retry: false,
  });

  // The server restarts mid-update: fetches fail for a few seconds. Keep the
  // last good payload and poll through the gap instead of showing an error.
  const [gapSince, setGapSince] = useState<number | null>(null);
  const sawRestartRef = useRef(false);
  const s = status.data;
  const phase = s?.state.phase ?? 'idle';
  const inFlight = ACTIVE_PHASES.includes(phase);

  useEffect(() => {
    if (status.isError && inFlight) {
      sawRestartRef.current = true;
      setGapSince((prev) => prev ?? Date.now());
    } else if (!status.isError) {
      setGapSince(null);
    }
  }, [status.isError, inFlight]);

  // After the server comes back with a resolved phase, refresh the app-level
  // status (new version, banner disappears).
  useEffect(() => {
    if (sawRestartRef.current && !status.isError && (phase === 'done' || phase === 'failed')) {
      void qc.invalidateQueries({ queryKey: ['status'] });
    }
  }, [phase, status.isError, qc]);

  const install = useMutation({
    mutationFn: () => post<{ ok: boolean }>('/api/update/install', {}),
    onSettled: () => qc.invalidateQueries({ queryKey: ['update-status'] }),
  });
  const rollback = useMutation({
    mutationFn: () => post<{ ok: boolean }>('/api/update/rollback', {}),
    onSettled: () => qc.invalidateQueries({ queryKey: ['update-status'] }),
  });

  const waiting = status.isError && inFlight;
  const longGap = gapSince !== null && Date.now() - gapSince > GAP_HINT_MS;
  const justFinished = sawRestartRef.current && !status.isError && phase === 'done';

  let body;
  if (!s) {
    body = (
      <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
        {status.isError ? 'Waiting for server…' : 'Loading…'}
      </div>
    );
  } else if (inFlight || waiting) {
    const restartStatus =
      phase === 'restarting' || phase === 'rolling-back'
        ? waiting
          ? 'active'
          : 'pending'
        : 'pending';
    body = (
      <div className="space-y-3">
        <div className="space-y-1.5">
          {s.state.steps.map((step) => (
            <StepRow key={step.name} step={step} />
          ))}
          <StepRow
            step={{
              name: s.state.kind === 'rollback' ? 'Restart on previous version' : 'Restart on new version',
              status: restartStatus,
            }}
          />
        </div>
        {waiting && (
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Server is restarting — waiting for it to come back…
          </div>
        )}
        {longGap && (
          <div className="text-sm" style={{ color: 'var(--status-warning)' }}>
            The server hasn't come back after several minutes. Check{' '}
            <code>systemctl status sense</code> on the host.
          </div>
        )}
      </div>
    );
  } else if (justFinished) {
    body = (
      <div className="space-y-3">
        <div className="text-sm" style={{ color: 'var(--status-good)' }}>
          {s.state.kind === 'rollback' ? 'Rolled back' : 'Updated'} {s.state.fromSha.slice(0, 7)} →{' '}
          {s.current.shortSha}
        </div>
        <button
          onClick={onClose}
          className="rounded-md px-4 py-1.5 text-sm font-medium"
          style={{ background: 'var(--series-1)', color: '#fff' }}
        >
          Done
        </button>
      </div>
    );
  } else if (phase === 'failed') {
    body = (
      <div className="space-y-3">
        <div className="text-sm" style={{ color: 'var(--status-critical)' }}>
          {s.state.kind === 'rollback' ? 'Rollback' : 'Update'} failed: {s.state.error}
        </div>
        {s.state.logTail.length > 0 && (
          <pre
            className="max-h-40 overflow-auto rounded-md p-2 text-xs"
            style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
          >
            {s.state.logTail.join('\n')}
          </pre>
        )}
        <div className="flex gap-2">
          {s.previous && s.state.kind !== 'rollback' && (
            <button
              onClick={() => rollback.mutate()}
              disabled={rollback.isPending}
              className="rounded-md px-4 py-1.5 text-sm font-medium disabled:opacity-50"
              style={{ background: 'var(--status-critical)', color: '#fff' }}
            >
              Roll back to {s.previous.shortSha}
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-md px-4 py-1.5 text-sm font-medium"
            style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
          >
            Close
          </button>
        </div>
        {rollback.isError && (
          <div className="text-sm" style={{ color: 'var(--status-critical)' }}>
            {(rollback.error as Error).message}
          </div>
        )}
      </div>
    );
  } else {
    // Idle: offer the update (or report up-to-date).
    body = (
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div style={{ color: 'var(--text-muted)' }}>Installed</div>
            <div className="tabular-nums">{s.current.shortSha}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)' }}>Latest</div>
            <div className="tabular-nums">
              {s.latest ? s.latest.shortSha : s.checkError ? 'check failed' : 'unknown'}
            </div>
          </div>
        </div>
        {s.updateAvailable ? (
          <button
            onClick={() => install.mutate()}
            disabled={install.isPending}
            className="rounded-md px-4 py-1.5 text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--series-1)', color: '#fff' }}
          >
            {install.isPending ? 'Starting…' : 'Install update'}
          </button>
        ) : (
          <div style={{ color: 'var(--text-muted)' }}>
            {s.supported ? 'You are up to date.' : (s.unsupportedReason ?? 'Updates unavailable.')}
          </div>
        )}
        {install.isError && (
          <div style={{ color: 'var(--status-critical)' }}>{(install.error as Error).message}</div>
        )}
        {s.checkError && (
          <div style={{ color: 'var(--status-warning)' }}>Last check failed: {s.checkError}</div>
        )}
      </div>
    );
  }

  return (
    <Modal title="Software update" onClose={onClose} dismissable={!inFlight && !waiting}>
      {body}
    </Modal>
  );
}
