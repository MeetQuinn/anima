import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Copy, Download, ExternalLink, List } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Highlight, themes } from 'prism-react-renderer';
import { useNavigate } from 'react-router-dom';
import { buildKbPath, buildKbRawPath } from '@/lib/url-state';
import { formatBytes } from '@/lib/format';
import { kbDownloadUrl } from '@/api/kb';
import type { KbFile } from '@shared/kb';

// ---------------------------------------------------------------------------
// CopyButton
// ---------------------------------------------------------------------------

function CopyButton({ text, variant = 'floating' }: { text: string; variant?: 'floating' | 'inline' }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    });
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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

interface TocEntry {
  depth: number;
  text: string;
  id: string;
}

export function extractToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      const depth = match[1].length;
      const text = match[2].trim();
      entries.push({ depth, text, id: slugify(text) });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Markdown heading renderers — assign id attributes that match extractToc's
// slugify so TOC href="#slug" links actually jump to the right heading.
// ---------------------------------------------------------------------------

function childrenText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      typeof child === 'string'
        ? child
        : isValidElement(child)
          ? childrenText((child.props as { children?: ReactNode }).children)
          : '',
    )
    .join('');
}

function makeHeading(Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') {
  return function Heading({ children }: { children?: ReactNode }) {
    const id = slugify(childrenText(children));
    return (
      <Tag
        id={id}
        onClick={() => {
          window.history.replaceState(null, '', `#${id}`);
        }}
        className="cursor-pointer"
      >
        {children}
      </Tag>
    );
  };
}

const headingComponents = {
  h1: makeHeading('h1'),
  h2: makeHeading('h2'),
  h3: makeHeading('h3'),
  h4: makeHeading('h4'),
  h5: makeHeading('h5'),
  h6: makeHeading('h6'),
};

// ---------------------------------------------------------------------------
// CopyLinkButton
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// BreadcrumbPath
// ---------------------------------------------------------------------------

// Breadcrumb path: shows truncated on first render; tap/click to expand to the full
// path (break-all wrap) so mobile users can read or copy deeply nested paths.
export function BreadcrumbPath({ filePath }: { filePath: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      onClick={() => setExpanded((e) => !e)}
      title={filePath}
      aria-label={expanded ? 'Collapse path' : 'Tap to expand full path'}
      className={[
        'min-w-0 text-left font-mono text-[11px] text-text-subtle',
        expanded ? 'whitespace-normal break-all' : 'truncate',
      ].join(' ')}
    >
      {filePath}
    </button>
  );
}

// ---------------------------------------------------------------------------
// FileToolbar — download (icon only)
// ---------------------------------------------------------------------------

export function FileToolbar({ id, filePath }: { id: string; filePath: string }) {
  return (
    <a
      href={kbDownloadUrl(id, filePath)}
      download
      title="Download file"
      className="chrome flex min-h-[44px] shrink-0 items-center justify-center rounded-sm px-2 text-text-subtle transition-colors hover:bg-surface-elevated hover:text-text-muted"
    >
      <Download className="h-3.5 w-3.5" />
    </a>
  );
}

// ---------------------------------------------------------------------------
// TocButton — floating overlay TOC, doesn't consume layout space.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Markdown link resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a relative href against the current file's directory.
 * Returns { path, hash } for in-KB navigation, or null if the href is
 * absolute (should open in new tab) or unparseable.
 *
 * Examples (currentFilePath = "docs/guide.md"):
 *   "./install.md"    → { path: "docs/install.md", hash: "" }
 *   "../index.md"     → { path: "index.md", hash: "" }
 *   "api.md#endpoint" → { path: "docs/api.md", hash: "#endpoint" }
 *   "https://…"       → null (absolute)
 *   "#heading"        → null (in-page anchor, handled separately)
 */
function resolveKbHref(
  href: string,
  currentFilePath: string,
): { path: string; hash: string } | null {
  if (!href || href.startsWith('#')) return null; // in-page anchor
  // Absolute URL (any scheme) → external
  if (/^[a-z][a-z\d+\-.]*:/i.test(href)) return null;
  try {
    // Rooting the base at the current file lets URL handle `..` and `./` correctly.
    const resolved = new URL(href, `http://x/${currentFilePath}`);
    if (resolved.host !== 'x') return null;
    const path = resolved.pathname.slice(1); // strip leading '/'
    return path ? { path, hash: resolved.hash } : null;
  } catch {
    return null;
  }
}

/**
 * Factory for the custom <a> component injected into ReactMarkdown.
 * - Absolute URLs  → new tab (unchanged)
 * - #heading       → in-page scroll (unchanged)
 * - Relative paths → resolved and navigated within the KB via React Router
 */
function makeKbLinkComponent(
  kbId: string,
  currentFilePath: string,
  navigate: ReturnType<typeof useNavigate>,
) {
  return function KbLink({
    href,
    children,
    ...rest
  }: React.ComponentPropsWithoutRef<'a'>) {
    // In-page anchor (TOC, heading references)
    if (!href || href.startsWith('#')) {
      return <a href={href} {...rest}>{children}</a>;
    }
    // Absolute URL → open in new tab
    if (/^[a-z][a-z\d+\-.]*:/i.test(href)) {
      return <a href={href} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
    }
    // Relative path → resolve and navigate within the KB
    const resolved = resolveKbHref(href, currentFilePath);
    if (!resolved) {
      return <a href={href} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
    }
    const to = buildKbPath({ id: kbId, filePath: resolved.path }) + resolved.hash;
    return (
      <a
        href={to}
        onClick={(e) => {
          e.preventDefault();
          navigate(to);
        }}
        {...rest}
      >
        {children}
      </a>
    );
  };
}

// ---------------------------------------------------------------------------
// ImageLightbox
// ---------------------------------------------------------------------------

function ImageLightbox({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={() => setOpen(true)}
        className="max-w-full cursor-zoom-in rounded"
      />
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(false)}
        >
          <img
            src={src}
            alt={alt}
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// FileContent
// ---------------------------------------------------------------------------

export function FileContent({
  id,
  filePath,
  file,
  loading,
  error,
}: {
  id: string;
  filePath: string;
  file: KbFile | undefined;
  loading: boolean;
  error: Error | null;
}) {
  const rawUrl = buildKbRawPath(id, filePath);
  const navigate = useNavigate();

  // Scroll to hash target after markdown renders.
  useEffect(() => {
    if (file?.kind !== 'markdown') return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el) {
      // Small delay to let ReactMarkdown finish rendering.
      const t = setTimeout(() => el.scrollIntoView({ behavior: 'smooth' }), 100);
      return () => clearTimeout(t);
    }
  }, [file]);

  // Memoised so ReactMarkdown sees stable component references (avoids remounting
  // all links on every parent re-render while the file content stays the same).
  const markdownComponents = useMemo(
    () => ({
      a: makeKbLinkComponent(id, filePath, navigate),
      ...headingComponents,
      img: ({ src, alt }: React.ComponentPropsWithoutRef<'img'>) => {
        let resolvedSrc = src ?? '';
        if (resolvedSrc && !/^[a-z][a-z\d+\-.]*:/i.test(resolvedSrc) && !resolvedSrc.startsWith('#')) {
          const resolved = resolveKbHref(resolvedSrc, filePath);
          if (resolved) {
            resolvedSrc = buildKbRawPath(id, resolved.path);
          }
        }
        return <ImageLightbox src={resolvedSrc} alt={alt ?? ''} />;
      },
      table: ({ children, ...props }: React.ComponentPropsWithoutRef<'table'>) => (
        <div className="overflow-x-auto">
          <table {...props}>{children}</table>
        </div>
      ),
      pre: ({ children }: { children?: ReactNode }) => {
        const codeText = childrenText(children);
        // ReactMarkdown wraps fenced code in <code className="language-xxx">.
        let lang = '';
        const first = Children.toArray(children)[0];
        if (isValidElement(first)) {
          const cls = (first.props as { className?: string }).className ?? '';
          const m = cls.match(/language-(\S+)/);
          if (m) lang = m[1];
        }
        return (
          <div className="kb-markdown-code-block group">
            <div className="chrome flex min-h-9 items-center justify-between gap-2 border-b border-border-soft/70 bg-surface-raised/45 px-2 py-1">
              {lang ? (
                <span className="rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-subtle">
                  {lang}
                </span>
              ) : (
                <span aria-hidden="true" />
              )}
              <CopyButton text={codeText} variant="inline" />
            </div>
            <pre>{children}</pre>
          </div>
        );
      },
    }),
    [id, filePath, navigate],
  );

  if (error) {
    return (
      <div className="p-6 font-sans text-[13px] text-health-error">
        Could not open <span className="font-mono">{filePath}</span>: {error.message}
      </div>
    );
  }
  if (loading || !file) {
    return <div className="p-6 font-sans text-[13px] text-text-subtle">Loading…</div>;
  }

  // HTML reports render as a real page in a sandboxed iframe (scripts run for
  // collapsibles/toggles, but the opaque origin can't touch the web app).
  if (file.kind === 'html') {
    return (
      <div className="flex h-full flex-col">
        {/* Thin toolbar: the in-app iframe sits beside the tree, so offer
            a pop-out to the full-width raw page — the same URL a share-link
            recipient opens. */}
        <div className="flex h-8 shrink-0 items-center justify-end border-b border-border-soft px-3">
          <a
            href={rawUrl}
            target="_blank"
            rel="noreferrer"
            title="Open the full-width report in a new tab"
            className="chrome flex items-center gap-1 rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-subtle transition-colors hover:bg-surface-elevated hover:text-text-muted"
          >
            <ExternalLink className="h-3 w-3" />
            Open full page
          </a>
        </div>
        <iframe
          title={file.name}
          src={rawUrl}
          sandbox="allow-scripts"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      </div>
    );
  }

  if (file.kind === 'image') {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 items-center justify-center overflow-auto bg-surface-elevated/30 p-6">
          <ImageLightbox src={rawUrl} alt={file.name} />
        </div>
      </div>
    );
  }

  if (file.truncated) {
    return (
      <div className="p-6 font-sans text-[13px] text-text-muted">
        This file is too large to inline ({formatBytes(file.size)}).{' '}
        <a
          href={rawUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline underline-offset-2"
        >
          Open raw
        </a>
      </div>
    );
  }

  if (file.kind === 'binary' || file.content === undefined) {
    return (
      <div className="p-6 font-sans text-[13px] text-text-muted">
        Binary file ({formatBytes(file.size)}).{' '}
        <a
          href={rawUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline underline-offset-2"
        >
          Open raw
        </a>
      </div>
    );
  }

  if (file.kind === 'markdown') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="md-prose">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {file.content}
          </ReactMarkdown>
        </div>
      </div>
    );
  }

  // json / code / text → syntax-highlighted source.
  const language = file.kind === 'json' ? 'json' : (file.language ?? 'text');
  let body = file.content;
  if (file.kind === 'json') {
    try {
      body = JSON.stringify(JSON.parse(file.content), null, 2);
    } catch {
      // Leave malformed JSON as-is.
    }
  }

  return (
    // overflow-auto enables both-axis scroll. min-w-max on the <pre> ensures it
    // expands to the width of the longest line (max-content) rather than being
    // clipped to the container — this is what makes long JSON values scrollable
    // instead of visually truncated with no affordance.
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="relative group min-h-0 flex-1 overflow-auto">
        <CopyButton text={body} />
        <Highlight code={body.replace(/\n$/, '')} language={language} theme={themes.github}>
          {({ className, style, tokens, getLineProps, getTokenProps }) => (
            <pre
              className={`${className} min-h-full font-mono text-[12.5px] leading-relaxed`}
              style={{ ...style, background: 'transparent', padding: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              <div className="px-5 py-4">
                {tokens.map((line, i) => {
                  const lineProps = getLineProps({ line });
                  return (
                    <div key={i} {...lineProps}>
                      <span className="mr-4 inline-block w-8 select-none text-right text-text-subtle/50">
                        {i + 1}
                      </span>
                      {line.map((token, key) => {
                        const tokenProps = getTokenProps({ token });
                        return <span key={key} {...tokenProps} />;
                      })}
                    </div>
                  );
                })}
              </div>
            </pre>
          )}
        </Highlight>
      </div>
    </div>
  );
}
