import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import 'katex/dist/katex.min.css';
import { Highlight, themes } from 'prism-react-renderer';
import { useNavigate } from 'react-router-dom';
import { buildKbPath, buildKbRawPath } from '@/lib/url-state';
import { formatBytes } from '@/lib/format';
import type { KbFile } from '@shared/kb';
import { CodeView } from './CodeView';
import { CopyButton, HeadingAnchor, ViewModeToggle } from './FileChrome';
export { FileBreadcrumb, FileOverflowMenu, TocButton, ViewModeToggle } from './FileChrome';
import { FrontmatterTable } from './FrontmatterTable';
import { ImageLightbox } from './ImageLightbox';
import { MermaidBlock } from './MermaidBlock';
import { ALERT_META, alertTypeFromClassName, rehypeGithubAlerts } from './lib/github-alerts';
import { parseFrontmatter } from './lib/frontmatter';
export { extractToc, lineFromHash } from './lib/markdown-toc';
import { extractToc, lineFromHash, replaceLocationHash, slugify } from './lib/markdown-toc';
import type { HeadingNode } from './lib/markdown-toc';
import { resolveKbHref, resolveRawSrc, resolveSrcset, sourceMatchesLight } from './lib/kb-links';
import type { HastElement } from './lib/kb-links';
export { loadSessionViewMode, saveSessionViewMode } from './lib/view-prefs';
import { loadSessionViewMode, saveSessionViewMode } from './lib/view-prefs';
import type { ViewMode } from './lib/view-prefs';
export type { ViewMode } from './lib/view-prefs';

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

// URL builders the renderer needs, injected so the same component serves both
// the KB surface (default) and the agent-home Files tab. `rawPath` maps a
// surface-relative file path to its raw-bytes endpoint (img / iframe / open-raw);
// `browsePath` maps it to the in-app SPA route for relative-link navigation.
export interface FileLinks {
  rawPath: (filePath: string) => string;
  browsePath: (filePath: string) => string;
}

// The subset of KbFile the renderer actually reads. Both a real KbFile and the
// agent-home file payload (KbFile minus kbId) satisfy this structurally, so the
// renderer stays surface-agnostic.
export type RenderableFile = Pick<
  KbFile,
  'name' | 'kind' | 'size' | 'language' | 'content' | 'truncated'
>;

function makeLinkComponent(
  links: FileLinks,
  currentFilePath: string,
  navigate: ReturnType<typeof useNavigate>,
) {
  return function FileLink({
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
    // Relative path → resolve and navigate within the same surface
    const resolved = resolveKbHref(href, currentFilePath);
    if (!resolved) {
      return <a href={href} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
    }
    const to = links.browsePath(resolved.path) + resolved.hash;
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

export function FileContent({
  id,
  filePath,
  file,
  loading,
  error,
  links: linksProp,
  mode: modeProp,
  onModeChange,
}: {
  id: string;
  filePath: string;
  file: RenderableFile | undefined;
  loading: boolean;
  error: Error | null;
  // URL builders for the surface. Omitted → KB defaults derived from `id`
  // (kbId). The agent Files tab passes home-file builders instead, so the same
  // renderer serves both surfaces with no behavioral drift.
  links?: FileLinks;
  // When the parent owns the Preview/Code toggle (so it can live in the page
  // header alongside the other file controls), it passes a controlled mode +
  // handler and FileContent suppresses its own inline toggle bar. Left
  // undefined (e.g. the README default view) FileContent manages mode itself.
  mode?: ViewMode;
  onModeChange?: (mode: ViewMode) => void;
}) {
  const navigate = useNavigate();
  const links = useMemo<FileLinks>(
    () =>
      linksProp ?? {
        rawPath: (p: string) => buildKbRawPath(id, p),
        browsePath: (p: string) => buildKbPath({ id, filePath: p }),
      },
    [linksProp, id],
  );
  const rawUrl = links.rawPath(filePath);
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
      a: makeLinkComponent(links, filePath, navigate),
      ...makeHeadingComponents(headingIdsByLine),
      img: ({ src, alt }: React.ComponentPropsWithoutRef<'img'>) => {
        let resolvedSrc = src ?? '';
        if (resolvedSrc && !/^[a-z][a-z\d+\-.]*:/i.test(resolvedSrc) && !resolvedSrc.startsWith('#')) {
          const resolved = resolveKbHref(resolvedSrc, filePath);
          if (resolved) {
            resolvedSrc = links.rawPath(resolved.path);
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
            const srcset = resolveSrcset(p.srcSet ?? p.srcset, links.rawPath, filePath);
            const first = srcset ? srcset.split(',')[0]?.trim().split(/\s+/)[0] : '';
            if (first) chosenSrc = first;
          } else if (child.tagName === 'img' && !fallback) {
            fallback = {
              src: resolveRawSrc(typeof p.src === 'string' ? p.src : '', links.rawPath, filePath),
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
    [headingIdsByLine, links, filePath, navigate],
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
                remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
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
