import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Code2, Copy, Download, ExternalLink, Eye, Link2, List, MoreHorizontal } from 'lucide-react';
import { buildKbRawPath } from '@/lib/url-state';
import { copyTextToClipboard } from '@/lib/clipboard';
import { formatBytes } from '@/lib/format';
import { kbDownloadUrl } from '@/api/kb';
import { headingHref, replaceLocationHash } from './lib/markdown-toc';
import type { TocEntry } from './lib/markdown-toc';
import type { ViewMode } from './lib/view-prefs';

export function CopyButton({ text, variant = 'floating' }: { text: string; variant?: 'floating' | 'inline' }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  const handleCopy = useCallback(() => {
    copyTextToClipboard(text)
      .then(() => {
        setCopied(true);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }, [text]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <button
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Copy'}
      aria-label={copied ? 'Copied' : 'Copy code'}
      className={
        variant === 'floating'
          ? 'chrome absolute right-2 top-2 flex h-7 items-center gap-1 rounded-sm bg-surface-elevated/80 px-2 text-[11px] text-text-subtle opacity-0 transition-opacity hover:bg-surface-elevated hover:text-text focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
          : 'chrome flex h-7 items-center gap-1 rounded-sm px-2 text-[11px] text-text-subtle transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text'
      }
    >
      <Copy className="h-3 w-3" />
      {copied && <span>Copied!</span>}
    </button>
  );
}

export function HeadingAnchor({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  const handleCopy = useCallback(
    (event: React.MouseEvent) => {
      // Don't let the click bubble to the heading's own hash handler twice.
      event.stopPropagation();
      event.preventDefault();
      replaceLocationHash(id);
      copyTextToClipboard(headingHref(id))
        .then(() => {
          setCopied(true);
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          timeoutRef.current = setTimeout(() => setCopied(false), 1500);
        })
        .catch(() => {});
    },
    [id],
  );

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <a
      href={`#${id}`}
      onClick={handleCopy}
      aria-label={copied ? 'Link copied' : 'Copy link to this section'}
      title={copied ? 'Link copied!' : 'Copy link to this section'}
      contentEditable={false}
      className="absolute right-full top-[0.1em] mr-1 inline-flex items-center px-1 text-text-subtle no-underline opacity-0 transition-opacity duration-100 hover:text-accent focus-visible:opacity-100 group-hover:opacity-100"
    >
      <Link2 className="h-[0.7em] w-[0.7em]" strokeWidth={2.5} aria-hidden="true" />
    </a>
  );
}

export function FileBreadcrumb({ filePath }: { filePath: string }) {
  const segments = filePath.split('/').filter(Boolean);
  const name = segments[segments.length - 1] ?? filePath;
  const parents = segments.slice(0, -1);
  const parent = parents[parents.length - 1];
  const hasDeeper = parents.length > 1;
  return (
    <div
      title={filePath}
      className="flex min-w-0 items-center gap-1 font-sans text-[12px] text-text-subtle"
    >
      {parent && (
        <>
          {hasDeeper && <span className="shrink-0 text-text-subtle/70">…</span>}
          {hasDeeper && <ChevronRight className="h-3 w-3 shrink-0 text-text-subtle/50" />}
          <span className="max-w-[12rem] shrink truncate">{parent}</span>
          <ChevronRight className="h-3 w-3 shrink-0 text-text-subtle/50" />
        </>
      )}
      <span className="min-w-0 shrink truncate font-medium text-text-muted">{name}</span>
    </div>
  );
}

export function FileOverflowMenu({
  id,
  filePath,
  size,
  rawUrl: rawUrlProp,
  downloadUrl: downloadUrlProp,
}: {
  id: string;
  filePath: string;
  size?: number;
  // Injectable raw-bytes URL so the same menu serves the KB (default, derived
  // from `id`) and the agent-home Files tab (its home-file raw endpoint).
  rawUrl?: string;
  // Download target. Omitted → KB default derived from `id`. Pass `null` to hide
  // the Download item entirely — the agent Files surface has no download
  // endpoint yet, so it defers that action (Copy path + Open raw carry the value).
  downloadUrl?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const rawUrl = rawUrlProp ?? buildKbRawPath(id, filePath);
  const downloadUrl = downloadUrlProp === undefined ? kbDownloadUrl(id, filePath) : downloadUrlProp;
  const handleCopy = useCallback(() => {
    copyTextToClipboard(filePath)
      .then(() => {
        setCopied(true);
        if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }, [filePath]);

  const itemClass =
    'flex w-full items-center gap-2 px-3 py-2 text-left font-sans text-[12px] text-text-muted transition-colors hover:bg-surface-elevated';

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className={[
          'chrome flex min-h-[44px] shrink-0 items-center justify-center rounded-sm px-2 transition-colors',
          open ? 'text-text' : 'text-text-subtle hover:bg-surface-elevated hover:text-text-muted',
        ].join(' ')}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-md border border-border-soft bg-surface-raised shadow-lg"
        >
          {size !== undefined && (
            <div className="border-b border-border-soft px-3 py-1.5 font-sans text-[11px] text-text-subtle">
              {formatBytes(size)}
            </div>
          )}
          <button role="menuitem" onClick={handleCopy} className={itemClass}>
            <Copy className="h-3.5 w-3.5 shrink-0" />
            {copied ? 'Path copied' : 'Copy path'}
          </button>
          <a
            role="menuitem"
            href={rawUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
            className={itemClass}
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            Open raw
          </a>
          {downloadUrl && (
            <a
              role="menuitem"
              href={downloadUrl}
              download
              onClick={() => setOpen(false)}
              className={itemClass}
            >
              <Download className="h-3.5 w-3.5 shrink-0" />
              Download
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function TocButton({ entries }: { entries: TocEntry[] }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside the button + panel.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (entries.length === 0) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Table of contents"
        className={[
          'chrome flex min-h-[44px] shrink-0 items-center justify-center rounded-sm px-2 transition-colors',
          open
            ? 'text-text'
            : 'text-text-subtle hover:bg-surface-elevated hover:text-text-muted',
        ].join(' ')}
      >
        <List className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-72 max-h-[480px] overflow-y-auto rounded-md border border-border-soft bg-surface shadow-deep">
          <nav className="py-1">
            {entries.map((entry, i) => (
              <a
                key={i}
                href={`#${entry.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  window.history.replaceState(null, '', `#${entry.id}`);
                  document.getElementById(entry.id)?.scrollIntoView({ behavior: 'smooth' });
                }}
                className="flex min-h-[40px] items-center font-sans text-[13px] text-text-muted transition-colors hover:bg-surface-elevated/60 hover:text-text"
                style={{ paddingLeft: `${0.75 + (entry.depth - 1) * 0.75}rem`, paddingRight: '0.75rem' }}
              >
                {entry.text}
              </a>
            ))}
          </nav>
        </div>
      )}
    </div>
  );
}

const VIEW_MODE_OPTIONS = [
  { value: 'preview' as const, label: 'Preview', Icon: Eye },
  { value: 'code' as const, label: 'Code', Icon: Code2 },
];

export function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div
      role="tablist"
      aria-label="File view mode"
      className="chrome inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border-soft bg-surface-raised/40 p-0.5"
    >
      {VIEW_MODE_OPTIONS.map(({ value, label, Icon }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            title={label}
            onClick={() => onChange(value)}
            className={[
              'flex min-h-[28px] items-center gap-1.5 rounded-[5px] px-2 text-[11px] font-medium transition-colors',
              active ? 'bg-surface text-text shadow-sm' : 'text-text-subtle hover:text-text-muted',
            ].join(' ')}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={2} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
