import { Children, isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Info,
  Lightbulb,
  Link2,
  List,
  Megaphone,
  MoreHorizontal,
  OctagonAlert,
  WrapText,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { Highlight, themes } from 'prism-react-renderer';
import { useNavigate } from 'react-router-dom';
import { buildKbPath, buildKbRawPath } from '@/lib/url-state';
import { copyTextToClipboard } from '@/lib/clipboard';
import { formatBytes } from '@/lib/format';
import { kbDownloadUrl } from '@/api/kb';
import type { KbFile } from '@shared/kb';

// ---------------------------------------------------------------------------
// YAML frontmatter
//
// react-markdown doesn't understand leading `---`-fenced YAML frontmatter, so
// it renders as an <hr> followed by run-together `key: value` text. We instead
// split the frontmatter off and render it as a tidy metadata table (GitHub-
// style), keeping the body Markdown clean. The parser is intentionally minimal
// and never throws — anything it can't read leaves the content untouched.
// ---------------------------------------------------------------------------

interface FrontmatterEntry {
  key: string;
  /** Inline scalar value, e.g. `name: foo`. Null when the value is a block. */
  value: string | null;
  /** Indented/list lines that follow a bare `key:` (nested map or list). */
  block: string[] | null;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseTopLevelYaml(inner: string): FrontmatterEntry[] {
  const lines = inner.split('\n');
  const entries: FrontmatterEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    // A top-level key has no leading indentation.
    const match = /^([A-Za-z0-9_][\w .-]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!match || /^\s/.test(line)) {
      i++;
      continue;
    }
    const key = match[1];
    const inlineVal = (match[2] ?? '').trim();
    if (inlineVal !== '') {
      entries.push({ key, value: stripQuotes(inlineVal), block: null });
      i++;
      continue;
    }
    // Bare `key:` — collect the following indented or list lines as its block.
    const block: string[] = [];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === '') {
        i++;
        continue;
      }
      if (/^\s/.test(next) || /^-[ \t]/.test(next)) {
        block.push(next);
        i++;
        continue;
      }
      break;
    }
    entries.push({ key, value: null, block: block.length > 0 ? block : null });
  }
  return entries;
}

function parseFrontmatter(content: string): { entries: FrontmatterEntry[] | null; body: string } {
  const fenced = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!fenced) return { entries: null, body: content };
  const entries = parseTopLevelYaml(fenced[1]);
  if (entries.length === 0) return { entries: null, body: content };
  return { entries, body: content.slice(fenced[0].length) };
}

function dedentBlock(block: string[]): string[] {
  const indents = block
    .filter((line) => line.trim() !== '')
    .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return block.map((line) => line.slice(common));
}

function FrontmatterBlockValue({ block }: { block: string[] }) {
  const dedented = dedentBlock(block);
  const nonEmpty = dedented.filter((line) => line.trim() !== '');
  const isList = nonEmpty.length > 0 && nonEmpty.every((line) => /^-[ \t]+/.test(line));
  if (isList) {
    return (
      <ul className="m-0 list-disc space-y-0.5 pl-4">
        {nonEmpty.map((line, idx) => (
          <li key={idx} className="font-mono text-[12px] text-text">
            {stripQuotes(line.replace(/^-[ \t]+/, '').trim())}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text">
      {dedented.join('\n').trimEnd()}
    </pre>
  );
}

function FrontmatterTable({ entries }: { entries: FrontmatterEntry[] }) {
  return (
    <div className="mb-5 overflow-hidden rounded-sm border border-border-soft bg-surface-raised/30">
      <table className="m-0 w-full border-collapse text-left align-top">
        <tbody>
          {entries.map((entry, idx) => (
            <tr
              key={entry.key + idx}
              className={idx > 0 ? 'border-t border-border-soft/70' : undefined}
            >
              <th
                scope="row"
                className="w-px whitespace-nowrap border-r border-border-soft/70 bg-surface-raised/40 px-3 py-2 align-top font-sans text-[11px] font-semibold uppercase tracking-wide text-text-subtle"
              >
                {entry.key}
              </th>
              <td className="px-3 py-2 align-top font-mono text-[12px] text-text">
                {entry.block ? (
                  <FrontmatterBlockValue block={entry.block} />
                ) : (
                  <span className="break-words">{entry.value}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CopyButton
// ---------------------------------------------------------------------------

function CopyButton({ text, variant = 'floating' }: { text: string; variant?: 'floating' | 'inline' }) {
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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-') || 'section';
}

interface TocEntry {
  depth: number;
  text: string;
  id: string;
  line: number;
}

type HeadingNode = {
  position?: {
    start?: {
      line?: number;
    };
  };
};

function uniqueHeadingId(text: string, counts: Map<string, number>): string {
  const base = slugify(text);
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function markdownHeadingText(text: string): string {
  return text.replace(/\s+#+\s*$/, '').trim();
}

function replaceLocationHash(id: string): void {
  if (window.location.hash === `#${id}`) return;
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}#${id}`,
  );
}

export function extractToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const counts = new Map<string, number>();
  const lines = markdown.split('\n');
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      const depth = match[1].length;
      const text = markdownHeadingText(match[2]);
      entries.push({ depth, text, id: uniqueHeadingId(text, counts), line: index + 1 });
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

function makeHeading(
  Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6',
  idsByLine: Map<number, string>,
) {
  return function Heading({
    children,
    node,
    className,
    ...props
  }: React.ComponentPropsWithoutRef<'h1'> & { children?: ReactNode; node?: HeadingNode }) {
    const line = node?.position?.start?.line;
    const id = (typeof line === 'number' ? idsByLine.get(line) : undefined) ?? slugify(childrenText(children));
    return (
      <Tag
        {...props}
        id={id}
        onClick={() => {
          replaceLocationHash(id);
        }}
        className={['group relative cursor-pointer', className].filter(Boolean).join(' ')}
      >
        <HeadingAnchor id={id} />
        {children}
      </Tag>
    );
  };
}

function makeHeadingComponents(idsByLine: Map<number, string>) {
  return {
    h1: makeHeading('h1', idsByLine),
    h2: makeHeading('h2', idsByLine),
    h3: makeHeading('h3', idsByLine),
    h4: makeHeading('h4', idsByLine),
    h5: makeHeading('h5', idsByLine),
    h6: makeHeading('h6', idsByLine),
  };
}

// ---------------------------------------------------------------------------
// HeadingAnchor — GitHub-style hover link affordance on rendered headings.
// Reveals a chain icon on hover/focus; click copies the full deep-link URL to
// the clipboard and sets the location hash. Sits inside a `group` heading.
// ---------------------------------------------------------------------------

function headingHref(id: string): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#${id}`;
}

function HeadingAnchor({ id }: { id: string }) {
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

// ---------------------------------------------------------------------------
// FileBreadcrumb — filename-forward path. Replaces the raw mono filesystem
// path (which read like debug output and duplicated the file tree). Shows the
// filename prominently with at most one parent directory for context; deeper
// nesting collapses to a leading ellipsis. Full path stays in the title.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// FileOverflowMenu — collapses copy-path / open-raw / download (plus the file
// size) into a single "⋯" menu so the header stays one clean row instead of a
// strip of unlabeled icons floating beside a loose size figure.
// ---------------------------------------------------------------------------

export function FileOverflowMenu({
  id,
  filePath,
  size,
}: {
  id: string;
  filePath: string;
  size?: number;
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

  const rawUrl = buildKbRawPath(id, filePath);
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
          <a
            role="menuitem"
            href={kbDownloadUrl(id, filePath)}
            download
            onClick={() => setOpen(false)}
            className={itemClass}
          >
            <Download className="h-3.5 w-3.5 shrink-0" />
            Download
          </a>
        </div>
      )}
    </div>
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
// Inline HTML sanitization (GitHub-like)
// ---------------------------------------------------------------------------

// rehype-raw parses embedded HTML in Markdown into the hast tree; rehype-sanitize
// then strips anything not on this allowlist. We start from the library default
// (which already blocks <script>, event handlers, and unsafe URL protocols) and
// widen it to the presentational subset GitHub renders: <picture>/<source> for
// theme-adaptive images, <details>/<summary>, and the legacy `align` attribute
// on common block tags. Rendering arbitrary file HTML is an XSS surface, so the
// sanitizer is mandatory — never feed rehype-raw output to the DOM unsanitized.
const ALIGN_TAGS = ['div', 'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th'] as const;

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'picture', 'source', 'details', 'summary'],
  attributes: {
    ...defaultSchema.attributes,
    source: ['srcSet', 'srcset', 'media', 'type', 'sizes', 'width', 'height'],
    img: [...(defaultSchema.attributes?.img ?? []), 'align', 'width', 'height', 'loading'],
    details: [...(defaultSchema.attributes?.details ?? []), 'open'],
    // KaTeX needs no extra allowlist here. remark-math emits the LaTeX on
    // <code class="language-math math-inline|math-display"> elements; rehypeKatex
    // runs AFTER rehypeSanitize (see rehypePlugins) and keys off `language-math`,
    // which the default schema already preserves on <code> (the same language-*
    // allowance fenced-code highlighting relies on). Inline vs display is derived
    // structurally (inline <code> vs <pre>), not from the math-inline/display
    // classes sanitize strips, so both render correctly with the default schema.
    // KaTeX runs with trust:false (no \href / raw HTML). Verified: inline +
    // display math both produce .katex / .katex-display output.
    // GitHub-style alert blockquotes: the rehypeGithubAlerts transform tags the
    // <blockquote> with these classes; restrict the allowlist to exactly them.
    blockquote: [
      ...(defaultSchema.attributes?.blockquote ?? []),
      [
        'className',
        'markdown-alert',
        'markdown-alert-note',
        'markdown-alert-tip',
        'markdown-alert-important',
        'markdown-alert-warning',
        'markdown-alert-caution',
      ],
    ],
    ...Object.fromEntries(
      ALIGN_TAGS.map((tag) => [tag, [...(defaultSchema.attributes?.[tag] ?? []), 'align']]),
    ),
  },
};

// ---------------------------------------------------------------------------
// GitHub-style alert blockquotes  ( > [!NOTE] / [!TIP] / [!IMPORTANT] / … )
// ---------------------------------------------------------------------------

type AlertType = 'note' | 'tip' | 'important' | 'warning' | 'caution';

const ALERT_META: Record<AlertType, { label: string; Icon: LucideIcon }> = {
  note: { label: 'Note', Icon: Info },
  tip: { label: 'Tip', Icon: Lightbulb },
  important: { label: 'Important', Icon: Megaphone },
  warning: { label: 'Warning', Icon: AlertTriangle },
  caution: { label: 'Caution', Icon: OctagonAlert },
};

const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;

// Minimal hast types — enough to walk/mutate without pulling in @types/hast.
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function alertTypeFromClassName(className: unknown): AlertType | null {
  const list = Array.isArray(className) ? className : typeof className === 'string' ? className.split(/\s+/) : [];
  if (!list.includes('markdown-alert')) return null;
  for (const type of Object.keys(ALERT_META) as AlertType[]) {
    if (list.includes(`markdown-alert-${type}`)) return type;
  }
  return null;
}

// rehype transform: a blockquote whose first line is `[!NOTE]` (etc.) becomes a
// classed alert. We only tag the <blockquote> + strip the marker text; the React
// `blockquote` component renders the icon + title so the icon stays a real
// lucide glyph (not injected markup that sanitize would have to allow). Runs
// AFTER rehype-raw and BEFORE rehype-sanitize, which keeps the classes (allowlisted).
function rehypeGithubAlerts() {
  function transform(bq: HastNode) {
    const firstPara = bq.children?.find((c) => c.type === 'element' && c.tagName === 'p');
    const lead = firstPara?.children?.[0];
    if (!firstPara || !lead || lead.type !== 'text' || typeof lead.value !== 'string') return;
    const m = ALERT_MARKER.exec(lead.value);
    if (!m) return;
    const type = m[1].toLowerCase() as AlertType;

    // Strip the marker (and an optional following newline) from the lead text.
    const rest = lead.value.slice(m[0].length).replace(/^[^\S\n]*\n?/, '');
    if (rest) {
      lead.value = rest;
    } else {
      // Marker was alone in its text node: drop it plus a trailing soft-break /
      // <br>, and remove the paragraph entirely if nothing remains.
      firstPara.children!.shift();
      const next = firstPara.children![0];
      if (next && next.type === 'text' && typeof next.value === 'string' && /^\s+$/.test(next.value)) {
        firstPara.children!.shift();
      } else if (next && next.type === 'element' && next.tagName === 'br') {
        firstPara.children!.shift();
      }
      if (firstPara.children!.length === 0) {
        bq.children = bq.children!.filter((c) => c !== firstPara);
      }
    }

    bq.properties = bq.properties ?? {};
    bq.properties.className = ['markdown-alert', `markdown-alert-${type}`];
  }

  function walk(node: HastNode) {
    if (!node.children) return;
    for (const child of node.children) {
      if (child.type === 'element' && child.tagName === 'blockquote') transform(child);
      walk(child);
    }
  }

  return (tree: HastNode) => walk(tree);
}

// ---------------------------------------------------------------------------
// MermaidBlock — render a ```mermaid fenced block as a diagram.
// ---------------------------------------------------------------------------

// `mermaid` is heavy (~0.5MB), so it is imported lazily the first time a
// diagram actually renders — it never enters the main KB bundle otherwise.
//
// SECURITY: the diagram source is untrusted KB content and the rendered SVG is
// injected via dangerouslySetInnerHTML (it never passes through the markdown
// sanitize pipeline), so it must be made safe on two independent layers:
//   1. mermaid: securityLevel:'strict' (strips scripts / click handlers / raw
//      anchors) AND htmlLabels:false so node labels render as native SVG <text>
//      instead of <foreignObject> HTML. Strict mode alone is NOT enough — it
//      still emits <foreignObject> wrappers that can carry <img> and other HTML
//      from a crafted label (verified), which would load external resources.
//   2. sanitizeMermaidSvg(): a DOMPurify svg-only pass that drops <foreignObject>
//      and every embedded-resource / script / link vector outright, so even if a
//      diagram type ignores htmlLabels:false the injected markup can never load
//      external content or run code. This is the hard guarantee; htmlLabels:false
//      is what keeps flowchart labels rendering as real text under that guarantee.
let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      });
      return mermaid;
    });
  }
  return mermaidReady;
}

// Strip <foreignObject> (HTML-in-SVG) and every external-resource / script / link
// vector from mermaid's SVG before it is injected. mermaid's own theme <style>,
// <path>, <text>, <g>, markers, etc. are preserved by the svg profile, so the
// diagram still renders fully styled; a malicious HTML label degrades to inert
// escaped text. Verified against <img src=x onerror=…>, <script>, and
// click "javascript:…" payloads — none survive.
function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      'foreignObject', 'img', 'image', 'script', 'iframe', 'object',
      'embed', 'a', 'audio', 'video', 'source', 'link', 'base',
    ],
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'onerror', 'onload', 'onclick'],
  });
}

function MermaidBlock({ code }: { code: string }) {
  const reactId = useId();
  // Single state set only from the async resolution, so there's no synchronous
  // setState in the effect (and no flicker: the prior diagram stays until the
  // next one resolves). `svg: null, failed: false` is the loading state.
  const [state, setState] = useState<{ svg: string | null; failed: boolean }>({
    svg: null,
    failed: false,
  });

  useEffect(() => {
    let cancelled = false;
    // mermaid requires a DOM-id-safe string; React's useId contains ':'.
    const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    loadMermaid()
      .then((mermaid) => mermaid.render(renderId, code))
      .then(({ svg }) => {
        if (!cancelled) setState({ svg, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ svg: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [code, reactId]);

  const { svg, failed } = state;

  // On parse/render failure, fall back to showing the raw source so the
  // author can still read and fix it (matches GitHub's behavior).
  if (failed) {
    return (
      <pre className="font-mono text-[0.82em] leading-[1.55] text-text-muted" style={{ background: 'transparent', margin: 0 }}>
        {code}
      </pre>
    );
  }
  if (svg === null) {
    return <div className="px-3 py-4 text-[0.82em] text-text-subtle">Rendering diagram…</div>;
  }
  return (
    <div
      className="flex justify-center overflow-x-auto px-3 py-3 [&_svg]:max-w-full [&_svg]:h-auto"
      // svg-only sanitized (no foreignObject / img / script / event attrs / active links) — see sanitizeMermaidSvg
      dangerouslySetInnerHTML={{ __html: sanitizeMermaidSvg(svg) }}
    />
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

// Minimal hast element shape — enough to read a <picture>'s children without
// pulling the full hast types in.
type HastElement = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastElement[];
};

/**
 * Resolve a relative asset reference (raw HTML `<img src>` / `<source srcset>`)
 * to the KB raw-bytes endpoint, matching what the Markdown `img` component does.
 * Absolute URLs, anchors, and root-absolute paths are left untouched.
 */
function resolveRawSrc(src: string, kbId: string, currentFilePath: string): string {
  if (!src || /^[a-z][a-z\d+\-.]*:/i.test(src) || src.startsWith('#') || src.startsWith('/')) {
    return src;
  }
  const resolved = resolveKbHref(src, currentFilePath);
  return resolved ? buildKbRawPath(kbId, resolved.path) : src;
}

/**
 * Decide whether a <picture><source> applies on our always-light content panel.
 * A `prefers-color-scheme: dark` source never matches (the panel is light); a
 * `light` one always does; any other media (e.g. width) is evaluated live.
 */
function sourceMatchesLight(media: unknown): boolean {
  if (typeof media !== 'string' || media.trim() === '') return true;
  if (/prefers-color-scheme:\s*dark/i.test(media)) return false;
  if (/prefers-color-scheme:\s*light/i.test(media)) return true;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      return window.matchMedia(media).matches;
    } catch {
      return true;
    }
  }
  return true;
}

/** Resolve every candidate URL inside a srcset (hast may store it as an array). */
function resolveSrcset(
  srcset: unknown,
  kbId: string,
  currentFilePath: string,
): string | undefined {
  const raw = Array.isArray(srcset) ? srcset.join(', ') : typeof srcset === 'string' ? srcset : '';
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((candidate) => {
      const [url, ...descriptor] = candidate.split(/\s+/);
      return [resolveRawSrc(url, kbId, currentFilePath), ...descriptor].join(' ').trim();
    })
    .join(', ');
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
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const openLightbox = useCallback(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);

  const closeLightbox = useCallback(() => {
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closeLightbox();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        closeButtonRef.current?.focus();
      }
    }
    closeButtonRef.current?.focus();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previousFocusRef.current?.focus();
    };
  }, [closeLightbox, open]);

  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={openLightbox}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openLightbox();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={alt ? `Open image: ${alt}` : 'Open image'}
        className="max-w-full cursor-zoom-in rounded"
      />
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={alt ? `Image preview: ${alt}` : 'Image preview'}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={closeLightbox}
        >
          <button
            ref={closeButtonRef}
            onClick={(e) => {
              e.stopPropagation();
              closeLightbox();
            }}
            aria-label="Close image preview"
            title="Close"
            className="chrome absolute right-4 top-4 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm bg-black/40 text-white transition-colors hover:bg-black/60 focus-visible:bg-black/60"
          >
            <X className="h-4 w-4" />
          </button>
          <img
            src={src}
            alt={alt}
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          {alt && (
            <div className="chrome absolute bottom-4 left-4 right-4 rounded-sm bg-black/45 px-3 py-2 text-center text-[12px] text-white/85">
              {alt}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// View mode toggle + raw source view (GitHub-style Preview / Code)
// ---------------------------------------------------------------------------

export type ViewMode = 'preview' | 'code';

const VIEW_MODE_STORAGE_KEY = 'kb-file-view-mode';

// Remember the reader's last choice for the tab session (default Preview on a
// fresh session). A power user inspecting raw source across several files
// shouldn't have to re-toggle each time, but newcomers still land on the
// friendly rendered view first.
export function loadSessionViewMode(): ViewMode {
  try {
    return window.sessionStorage.getItem(VIEW_MODE_STORAGE_KEY) === 'code' ? 'code' : 'preview';
  } catch {
    return 'preview';
  }
}

export function saveSessionViewMode(mode: ViewMode): void {
  try {
    window.sessionStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // sessionStorage can be unavailable (private mode / disabled) — non-fatal.
  }
}

const CODE_WRAP_STORAGE_KEY = 'kb-code-wrap';

// Wrap defaults ON; only an explicit 'off' disables it.
function loadSessionWrap(): boolean {
  try {
    return window.sessionStorage.getItem(CODE_WRAP_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function saveSessionWrap(wrap: boolean): void {
  try {
    window.sessionStorage.setItem(CODE_WRAP_STORAGE_KEY, wrap ? 'on' : 'off');
  } catch {
    // non-fatal
  }
}

// Parse a `#L<n>` line anchor from a location hash.
export function lineFromHash(hash: string): number | null {
  const m = /^#L(\d+)$/.exec(hash);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
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

// GitHub-style source view: syntax-highlighted lines with a clickable line-number
// gutter. Clicking a number sets a shareable `#L<n>` hash and highlights the row.
// Shared by Markdown's Code mode and the json/code/text renderer.
function CodeView({ body, language }: { body: string; language: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeLine, setActiveLine] = useState<number | null>(() => lineFromHash(window.location.hash));
  // Soft-wrap toggle. Default ON (long lines wrap, no horizontal scroll);
  // turning it off gives GitHub-style no-wrap + horizontal scroll. Remembered
  // per tab session like the view mode.
  const [wrap, setWrap] = useState<boolean>(loadSessionWrap);
  const toggleWrap = useCallback(() => {
    setWrap((prev) => {
      const next = !prev;
      saveSessionWrap(next);
      return next;
    });
  }, []);

  useEffect(() => {
    function onHashChange() {
      setActiveLine(lineFromHash(window.location.hash));
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Bring the deep-linked line into view once, after the highlighter paints.
  useEffect(() => {
    const target = lineFromHash(window.location.hash);
    if (target === null) return;
    const el = scrollRef.current?.querySelector(`#L${target}`);
    if (!el) return;
    const t = setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
    return () => clearTimeout(t);
    // Intentionally mount-only: deep-link landing, not on every hash edit.
  }, []);

  function selectLine(n: number) {
    const next = activeLine === n ? null : n;
    setActiveLine(next);
    // replaceState keeps the back button clean while updating the shareable URL.
    const url = next === null ? window.location.pathname + window.location.search : `#L${next}`;
    window.history.replaceState(null, '', url);
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
      <div className="relative group min-h-0 flex-1 overflow-auto">
        <button
          type="button"
          onClick={toggleWrap}
          aria-pressed={wrap}
          title={wrap ? 'Disable soft wrap' : 'Enable soft wrap'}
          className={[
            'chrome absolute right-12 top-2 z-10 flex h-7 items-center gap-1 rounded-sm px-2 text-[11px] transition-opacity',
            'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100',
            wrap
              ? 'bg-accent/10 text-accent hover:bg-accent/15'
              : 'bg-surface-elevated/80 text-text-subtle hover:bg-surface-elevated hover:text-text',
          ].join(' ')}
        >
          <WrapText className="h-3 w-3" />
        </button>
        <CopyButton text={body} />
        <Highlight code={body.replace(/\n$/, '')} language={language} theme={themes.github}>
          {({ className, style, tokens, getLineProps, getTokenProps }) => (
            <pre
              className={`${className} min-h-full font-mono text-[12.5px] leading-relaxed ${wrap ? '' : 'w-max'}`}
              style={{
                ...style,
                background: 'transparent',
                padding: 0,
                whiteSpace: wrap ? 'pre-wrap' : 'pre',
                wordBreak: wrap ? 'break-word' : 'normal',
              }}
            >
              <div className="py-4">
                {tokens.map((line, i) => {
                  const n = i + 1;
                  const { className: lineClass, ...lineProps } = getLineProps({ line });
                  const active = activeLine === n;
                  return (
                    <div
                      key={i}
                      {...lineProps}
                      id={`L${n}`}
                      className={[
                        lineClass ?? '',
                        'flex px-5',
                        wrap ? '' : 'min-w-full',
                        active ? 'bg-accent/10' : '',
                      ]
                        .join(' ')
                        .trim()}
                    >
                      <a
                        href={`#L${n}`}
                        onClick={(e) => {
                          e.preventDefault();
                          selectLine(n);
                        }}
                        title={`Link to line ${n}`}
                        className={[
                          'mr-4 inline-block w-8 shrink-0 select-none text-right tabular-nums transition-colors',
                          active ? 'text-accent' : 'text-text-subtle/50 hover:text-text-muted',
                        ].join(' ')}
                      >
                        {n}
                      </a>
                      <span className={wrap ? 'min-w-0 flex-1' : 'shrink-0'}>
                        {line.map((token, key) => {
                          const tokenProps = getTokenProps({ token });
                          return <span key={key} {...tokenProps} />;
                        })}
                      </span>
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

// ---------------------------------------------------------------------------
// FileContent
// ---------------------------------------------------------------------------

export function FileContent({
  id,
  filePath,
  file,
  loading,
  error,
  mode: modeProp,
  onModeChange,
}: {
  id: string;
  filePath: string;
  file: KbFile | undefined;
  loading: boolean;
  error: Error | null;
  // When the parent owns the Preview/Code toggle (so it can live in the page
  // header alongside the other file controls), it passes a controlled mode +
  // handler and FileContent suppresses its own inline toggle bar. Left
  // undefined (e.g. the README default view) FileContent manages mode itself.
  mode?: ViewMode;
  onModeChange?: (mode: ViewMode) => void;
}) {
  const rawUrl = buildKbRawPath(id, filePath);
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { entries: frontmatter, body: markdownBody } = useMemo(() => {
    if (file?.kind !== 'markdown' || !file.content) return { entries: null, body: '' };
    return parseFrontmatter(file.content);
  }, [file]);
  // Map TOC heading ids by line against the same body ReactMarkdown renders
  // (frontmatter-stripped), so node line numbers line up after the fence is cut.
  const headingIdsByLine = useMemo(() => {
    if (file?.kind !== 'markdown' || !markdownBody) return new Map<number, string>();
    return new Map(extractToc(markdownBody).map((entry) => [entry.line, entry.id]));
  }, [file, markdownBody]);

  // Preview / Code toggle for Markdown. Land in Code mode when deep-linked to a
  // `#L<n>` source line; otherwise honour the session's last choice.
  const [internalMode, setInternalMode] = useState<ViewMode>(() =>
    lineFromHash(window.location.hash) ? 'code' : loadSessionViewMode(),
  );
  const controlledMode = modeProp !== undefined && onModeChange !== undefined;
  const mode = controlledMode ? modeProp : internalMode;
  const changeMode = useCallback(
    (next: ViewMode) => {
      if (controlledMode && onModeChange) {
        onModeChange(next);
      } else {
        setInternalMode(next);
        saveSessionViewMode(next);
      }
    },
    [controlledMode, onModeChange],
  );
  const showAsCode = file?.kind === 'markdown' && mode === 'code';

  // Scroll to hash target after markdown renders.
  useEffect(() => {
    if (file?.kind !== 'markdown' || mode !== 'preview') return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el) {
      // Small delay to let ReactMarkdown finish rendering.
      const t = setTimeout(() => el.scrollIntoView({ behavior: 'smooth' }), 100);
      return () => clearTimeout(t);
    }
  }, [file, mode]);

  // Keep the hash aligned with the heading closest to the top of the markdown
  // scroller. This preserves shareable anchors while reading long KB docs.
  useEffect(() => {
    if (file?.kind !== 'markdown' || mode !== 'preview') return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const root: HTMLDivElement = scroller;
    const headings = Array.from(
      root.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'),
    );
    if (headings.length === 0) return;

    let frame = 0;
    function syncHash() {
      frame = 0;
      const edge = root.getBoundingClientRect().top + 24;
      let active = headings[0];
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= edge) active = heading;
        else break;
      }
      if (active?.id) replaceLocationHash(active.id);
    }
    function onScroll() {
      if (frame) return;
      frame = window.requestAnimationFrame(syncHash);
    }

    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [file, mode]);

  // Memoised so ReactMarkdown sees stable component references (avoids remounting
  // all links on every parent re-render while the file content stays the same).
  const markdownComponents = useMemo(
    () => ({
      a: makeKbLinkComponent(id, filePath, navigate),
      ...makeHeadingComponents(headingIdsByLine),
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
      // The KB content panel is always a light surface (the dashboard has no
      // dark theme for content), so resolve <picture> to its light variant
      // rather than following the viewer's OS color scheme — otherwise an
      // OS-dark user gets the dark-mode asset washed out on our light panel.
      // We collapse the <picture> to the chosen <img> built straight from the
      // hast node (resolving relative asset paths) instead of routing the inner
      // <img> through the lightbox.
      picture: ({ node }: { node?: HastElement }) => {
        let chosenSrc: string | null = null;
        let fallback: { src: string; alt: string; width?: string } | null = null;
        for (const child of node?.children ?? []) {
          if (child.type !== 'element') continue;
          const p = child.properties ?? {};
          if (child.tagName === 'source' && !chosenSrc && sourceMatchesLight(p.media)) {
            const srcset = resolveSrcset(p.srcSet ?? p.srcset, id, filePath);
            const first = srcset ? srcset.split(',')[0]?.trim().split(/\s+/)[0] : '';
            if (first) chosenSrc = first;
          } else if (child.tagName === 'img' && !fallback) {
            fallback = {
              src: resolveRawSrc(typeof p.src === 'string' ? p.src : '', id, filePath),
              alt: typeof p.alt === 'string' ? p.alt : '',
              width: p.width != null ? String(p.width) : undefined,
            };
          }
        }
        const src = chosenSrc ?? fallback?.src;
        if (!src) return null;
        return (
          <img
            src={src}
            alt={fallback?.alt ?? ''}
            width={fallback?.width}
            className="inline-block h-auto max-w-full"
          />
        );
      },
      // GitHub-style alert: rehypeGithubAlerts tagged the blockquote; render the
      // lucide icon + title here so the glyph is a real React element. Plain
      // blockquotes fall through to the default rendering.
      blockquote: ({
        node,
        children,
        ...props
      }: React.ComponentPropsWithoutRef<'blockquote'> & { node?: HastElement }) => {
        const alert = alertTypeFromClassName(node?.properties?.className);
        if (!alert) return <blockquote {...props}>{children}</blockquote>;
        const { label, Icon } = ALERT_META[alert];
        return (
          <blockquote className={`markdown-alert markdown-alert-${alert}`}>
            <p className="markdown-alert-title">
              <Icon className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
              {label}
            </p>
            {children}
          </blockquote>
        );
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
        if (lang === 'mermaid') {
          return (
            <div className="kb-markdown-code-block group">
              <div className="chrome flex min-h-9 items-center justify-between gap-2 border-b border-border-soft/70 bg-surface-raised/45 px-2 py-1">
                <span className="rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-subtle">
                  mermaid
                </span>
                <CopyButton text={codeText} variant="inline" />
              </div>
              <MermaidBlock code={codeText.replace(/\n$/, '')} />
            </div>
          );
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
            {/* Syntax-highlight the fenced block with the same Prism pipeline the
                Code view uses, so rendered Markdown matches GitHub instead of
                showing flat monospace. Unknown languages fall back to plain. */}
            <Highlight code={codeText.replace(/\n$/, '')} language={lang || 'text'} theme={themes.github}>
              {({ className, style, tokens, getLineProps, getTokenProps }) => (
                <pre
                  className={`${className} font-mono text-[0.82em] leading-[1.55]`}
                  style={{ ...style, background: 'transparent', margin: 0 }}
                >
                  {tokens.map((line, i) => (
                    <div key={i} {...getLineProps({ line })}>
                      {line.map((token, key) => (
                        <span key={key} {...getTokenProps({ token })} />
                      ))}
                    </div>
                  ))}
                </pre>
              )}
            </Highlight>
          </div>
        );
      },
    }),
    [headingIdsByLine, id, filePath, navigate],
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
      <div className="flex h-full min-h-0 flex-col">
        {/* GitHub-style Preview / Code switch. Markdown is the one kind that has
            both a rendered form and inline source, so it's the only place the
            toggle appears. When the parent owns the toggle (controlled mode, the
            primary file view) it lives in the page header instead, so the inline
            bar is suppressed to avoid a redundant second row. */}
        {!controlledMode && (
          <div className="flex h-9 shrink-0 items-center justify-end border-b border-border-soft px-3">
            <ViewModeToggle mode={mode} onChange={changeMode} />
          </div>
        )}
        {showAsCode ? (
          // Raw source includes frontmatter, matching what GitHub shows.
          <CodeView body={file.content} language="markdown" />
        ) : (
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {/* Rendered outside .md-prose so the metadata table keeps its own
                styling instead of inheriting the Markdown code-block / table look. */}
            {frontmatter && <FrontmatterTable entries={frontmatter} />}
            <div className="md-prose">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[
                  rehypeRaw,
                  rehypeGithubAlerts,
                  [rehypeSanitize, sanitizeSchema],
                  // KaTeX last: it renders trusted markup from the (already
                  // sanitized) LaTeX text, so its output bypasses sanitize.
                  rehypeKatex,
                ]}
                components={markdownComponents}
              >
                {markdownBody}
              </ReactMarkdown>
            </div>
          </div>
        )}
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

  return <CodeView body={body} language={language} />;
}
