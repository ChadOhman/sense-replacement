import { useEffect } from 'react';
import type { ReactNode } from 'react';

/** Minimal centered modal. `dismissable={false}` disables backdrop/Escape
 *  close for flows that must not be abandoned (e.g. an update in flight). */
export function Modal({
  title,
  onClose,
  dismissable = true,
  children,
}: {
  title: string;
  onClose: () => void;
  dismissable?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!dismissable) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissable, onClose]);

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4"
      onClick={dismissable ? onClose : undefined}
    >
      <div
        className="card w-full max-w-md p-5"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="font-semibold">{title}</div>
          {dismissable && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="rounded-md px-2 py-0.5 text-sm"
              style={{ color: 'var(--text-muted)' }}
            >
              ✕
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
