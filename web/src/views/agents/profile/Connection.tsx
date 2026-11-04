import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Building2, Check, Settings2, X } from 'lucide-react';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { Field } from './Primitives';

// Every platform an agent is reachable on (Slack, Feishu, Linear) is one row
// with the same anatomy: the workspace (icon and name), the notes that need
// the user, and a single action that opens the platform's dialog. Healthy rows
// stay quiet (an icon, no words); handles, IDs and secondary actions live in
// the dialog.

export type ConnectionNote = { tone: 'warn' | 'error'; text: string };

/** The workspace's own icon; its initial when there is none to show. */
function WorkspaceTile({ name, iconUrl, connected }: { name?: string; iconUrl?: string; connected: boolean }) {
  const [broken, setBroken] = useState(false);
  const frame = 'flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[5px]';
  if (!connected) return <span aria-hidden="true" data-tile="none" className={`${frame} border border-dashed border-border`} />;
  if (iconUrl && !broken)
    return (
      <img
        src={iconUrl}
        alt=""
        data-tile="icon"
        onError={() => setBroken(true)}
        className={`${frame} object-cover ring-1 ring-border-soft`}
      />
    );
  const initial = name?.trim().charAt(0).toUpperCase();
  return (
    <span aria-hidden="true" data-tile="initial" className={`${frame} bg-muted font-sans text-[11px] font-semibold text-text-muted ring-1 ring-border-soft`}>
      {initial || <Building2 className="size-3" />}
    </span>
  );
}

export function ConnectionRow({
  label,
  connected,
  workspace,
  iconUrl,
  status,
  notes = [],
  action,
  onAction,
}: {
  label: string;
  connected: boolean;
  /** The workspace name, when the platform reports one. */
  workspace?: string;
  iconUrl?: string;
  /** Shown instead of the workspace when not connected, e.g. "Not connected". */
  status?: string;
  notes?: ConnectionNote[];
  action: string;
  onAction: () => void;
}) {
  return (
    <Field label={label}>
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-2.5">
            <WorkspaceTile name={workspace} iconUrl={iconUrl} connected={connected} />
            {connected ? (
              <span className="min-w-0 break-words font-serif text-[15px] text-text">{workspace || 'Connected'}</span>
            ) : (
              <span className="font-sans text-[13px] text-text-muted">{status ?? 'Not connected'}</span>
            )}
          </p>
          {notes.map((note) => (
            <p
              key={note.text}
              className={`mt-0.5 pl-[30px] font-sans text-[12px] ${note.tone === 'error' ? 'text-health-error' : 'text-health-warn-ink'}`}
            >
              {note.text}
            </p>
          ))}
        </div>
        {/* Quiet when there is nothing to do: a settings icon, like the
          pencils above. A word only when the row asks for the user. */}
        {connected && notes.length === 0 ? (
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`${action} ${label}`}
            title={`${action} ${label}`}
            onClick={onAction}
            className="ml-auto flex size-[44px] shrink-0 items-center justify-center rounded-sm text-text-subtle transition-colors hover:bg-surface-elevated hover:text-text focus-visible:outline focus-visible:outline-accent md:size-8"
          >
            <Settings2 className="size-4" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`${action} ${label}`}
            onClick={onAction}
            className="ml-auto inline-flex min-h-[44px] shrink-0 items-center rounded-sm px-2.5 font-sans text-[12px] font-medium text-accent transition-colors hover:bg-surface-elevated hover:text-accent-hover focus-visible:outline focus-visible:outline-accent md:min-h-8"
          >
            {action}
          </button>
        )}
      </div>
    </Field>
  );
}

/** Opening block of a connected platform's dialog. */
export function ConnectionHeader({ problem = false, title, children }: { problem?: boolean; title: string; children: ReactNode }) {
  return (
    <header className="flex items-start gap-3.5">
      {problem ? (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-health-error-soft text-health-error">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </span>
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-health-ok-soft text-health-ok">
          <Check className="size-5" aria-hidden="true" />
        </span>
      )}
      <div className="min-w-0 space-y-1">
        <h3 className="break-words font-serif text-[20px] font-semibold leading-tight text-text">{title}</h3>
        <p className="font-serif text-[14px] leading-relaxed text-text-muted">{children}</p>
      </div>
    </header>
  );
}

export function Fact({
  label,
  value,
  mono = false,
  wide = false,
  tone,
  title,
}: {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
  wide?: boolean;
  tone?: 'error';
}) {
  return (
    <div className={`min-w-0 border-border-soft px-3.5 py-3 ${wide ? 'col-span-2 border-t' : 'even:border-l'}`}>
      <dt className="font-sans text-[11px] tracking-wide text-text-subtle">{label}</dt>
      <dd
        title={title}
        className={`mt-1 break-all ${mono ? 'font-mono text-[12px]' : 'font-serif text-[14px]'} ${tone === 'error' ? 'text-health-error' : 'text-text'}`}
      >
        {value}
      </dd>
    </div>
  );
}

export function ConnectionDialog({
  platform,
  busy = false,
  onClose,
  children,
}: {
  platform: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { dialogRef, titleId, isTopmostDialog } = useDialogFocus(true);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && isTopmostDialog()) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isTopmostDialog]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-page/70 backdrop-blur-sm md:items-center md:p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex h-full w-full flex-col border-border bg-surface shadow-deep md:h-auto md:max-h-[88dvh] md:max-w-[34rem] md:rounded-sm md:border"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border-soft px-5 py-2.5 md:px-6">
          <h2 id={titleId} className="font-sans text-[12px] font-medium uppercase tracking-[0.08em] text-text-muted">
            {platform}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={`Close ${platform} settings`}
            className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface-elevated hover:text-text disabled:opacity-40 md:size-8"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 py-6 md:px-6">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
