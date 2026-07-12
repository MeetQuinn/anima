import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileCode,
  FileJson,
  FileText,
  Folder,
  Image as ImageIcon,
  Globe,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { kbFileKind } from '@shared/kb-file-types';
import type { KbFileKind } from '@shared/kb-file-types';
import type { KbTreeNode } from '@shared/kb';
import { formatRelativeShort } from '@/lib/format';

// Ancestor dir paths of a file, so the tree opens to the deep-linked file.
export function ancestorsOf(filePath: string | null): Set<string> {
  const set = new Set<string>();
  if (!filePath) return set;
  const segs = filePath.split('/');
  let prefix = '';
  for (let i = 0; i < segs.length - 1; i += 1) {
    prefix = prefix ? `${prefix}/${segs[i]}` : segs[i];
    set.add(prefix);
  }
  return set;
}

// Returns true if a node or any of its descendants match the filter query.
export function matchesFilter(node: KbTreeNode, query: string): boolean {
  const q = query.toLowerCase();
  if (node.type === 'file') return node.name.toLowerCase().includes(q);
  return node.children?.some((c) => matchesFilter(c, query)) ?? false;
}

function useIsTruncated<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setTruncated(el.scrollWidth > el.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, truncated];
}

function KindIcon({ kind, className }: { kind: KbFileKind; className: string }) {
  switch (kind) {
    case 'markdown':
    case 'text':
      return <FileText className={className} />;
    case 'json':
      return <FileJson className={className} />;
    case 'code':
      return <FileCode className={className} />;
    case 'image':
      return <ImageIcon className={className} />;
    case 'html':
      return <Globe className={className} />;
    default:
      return <FileIcon className={className} />;
  }
}

// Inline match highlight — wraps the matching substring in a subtle highlight span.
function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-accent/20 text-text not-italic">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function TreeRow({
  node,
  depth,
  expanded,
  selectedPath,
  filterQuery,
  onToggleDir,
  onSelectFile,
}: {
  node: KbTreeNode;
  depth: number;
  expanded: Set<string>;
  selectedPath: string | null;
  filterQuery?: string;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isFiltering = !!filterQuery;
  const [nameRef, isTruncated] = useIsTruncated<HTMLSpanElement>();

  // When filtering, skip nodes that don't match.
  if (isFiltering && !matchesFilter(node, filterQuery)) return null;

  // Indent via CSS custom property + .tree-row class so a single @media rule in
  // index.css can reduce per-level width on mobile (8px) vs desktop (12px) without
  // JS viewport detection.
  const depthStyle = { '--tree-depth': depth } as React.CSSProperties;

  if (node.type === 'dir') {
    // While filtering, dirs auto-expand to reveal matching children.
    const isOpen = isFiltering ? true : expanded.has(node.path);
    return (
      <div>
        <button
          onClick={() => !isFiltering && onToggleDir(node.path)}
          data-tree-row
          data-path={node.path}
          data-type="dir"
          style={depthStyle}
          title={isTruncated ? node.name : undefined}
          className="tree-row group flex min-h-[46px] w-full items-center gap-2.5 border-b border-border-soft/45 pr-3.5 text-left font-sans text-[15px] font-semibold text-text hover:bg-surface-elevated/60 md:min-h-0 md:gap-1.5 md:border-b-0 md:py-1.5 md:pr-2 md:text-[14px] md:font-normal md:text-text-muted"
        >
          {/* Mobile leads with a folder glyph (list reads as a file manager;
              the expand state moves to the trailing chevron). Desktop keeps
              the chevron alone - the folder glyph doubled it and made every
              row carry two icons, which read as IDE chrome rather than an
              index. Files keep their kind icon on both (real information, and
              the agent Files tab shares this tree over mixed-kind homes). */}
          <Folder className="h-[17px] w-[17px] shrink-0 fill-accent/15 text-text-subtle md:hidden" />
          {isOpen ? (
            <ChevronDown className="hidden h-3.5 w-3.5 shrink-0 opacity-60 md:block" />
          ) : (
            <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 opacity-60 md:block" />
          )}
          <span ref={nameRef} className="truncate">{node.name}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 font-normal text-[12px] tabular-nums text-text-subtle md:hidden">
            {node.mtime ? formatRelativeShort(node.mtime, new Date()) : null}
            <ChevronRight
              className={`h-3.5 w-3.5 opacity-55 transition-transform ${isOpen ? 'rotate-90' : ''}`}
            />
          </span>
        </button>
        {isOpen &&
          node.children?.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedPath={selectedPath}
              filterQuery={filterQuery}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
            />
          ))}
      </div>
    );
  }

  const active = node.path === selectedPath;
  const iconClass = `h-4 w-4 shrink-0 md:h-3.5 md:w-3.5 ${active ? 'text-accent/70' : 'text-text-subtle'}`;
  return (
    <button
      onClick={() => onSelectFile(node.path)}
      data-tree-row
      data-path={node.path}
      data-type="file"
      style={depthStyle}
      title={isTruncated ? node.name : undefined}
      className={[
        'tree-row group flex min-h-[46px] w-full items-center gap-2.5 border-b border-border-soft/45 pr-3.5 text-left font-sans text-[14.5px] transition-colors md:min-h-0 md:gap-1.5 md:border-b-0 md:py-1.5 md:pr-2 md:text-[14px]',
        active
          ? 'bg-accent/10 text-accent font-medium'
          : 'text-text-muted hover:bg-surface-elevated/60',
      ].join(' ')}
    >
      <KindIcon kind={kbFileKind(node.name)} className={iconClass} />
      <span ref={nameRef} className="truncate">
        <HighlightMatch text={node.name} query={filterQuery ?? ''} />
      </span>
      {node.mtime ? (
        <span className="ml-auto shrink-0 pl-2 text-[12px] tabular-nums text-text-subtle md:hidden">
          {formatRelativeShort(node.mtime, new Date())}
        </span>
      ) : null}
    </button>
  );
}

// Mobile-only root summary under the filter row - "10 folders · 6 files".
// Callers hide it while a filter query narrows the tree (the counts describe
// the full root level, not the filtered view).
export function TreeSummary({ nodes }: { nodes: KbTreeNode[] }) {
  if (nodes.length === 0) return null;
  const dirs = nodes.filter((n) => n.type === 'dir').length;
  const files = nodes.length - dirs;
  const label = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return (
    <div className="px-4 pb-1.5 pt-2.5 font-sans text-[10.5px] font-semibold uppercase tracking-[0.09em] text-text-subtle md:hidden">
      {label(dirs, 'folder')} · {label(files, 'file')}
    </div>
  );
}
