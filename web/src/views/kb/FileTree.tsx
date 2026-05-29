import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileCode,
  FileJson,
  FileText,
  FolderClosed,
  FolderOpen,
  Image as ImageIcon,
  Globe,
} from 'lucide-react';
import { kbFileKind } from '@shared/kb-file-types';
import type { KbFileKind } from '@shared/kb-file-types';
import type { KbTreeNode } from '@shared/kb';

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
          className="tree-row flex w-full items-center gap-1.5 py-1.5 pr-2 text-left font-sans text-[15px] text-text-muted hover:bg-surface-elevated/60 md:py-1 md:text-[14px]"
        >
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
          )}
          {isOpen ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
          ) : (
            <FolderClosed className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
          )}
          <span className="truncate">{node.name}</span>
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
  const iconClass = `h-3.5 w-3.5 shrink-0 ${active ? 'text-accent/70' : 'text-text-subtle'}`;
  return (
    <button
      onClick={() => onSelectFile(node.path)}
      data-tree-row
      data-path={node.path}
      data-type="file"
      style={depthStyle}
      className={[
        'tree-row flex w-full items-center gap-1.5 py-1.5 pr-2 text-left font-sans text-[15px] transition-colors md:py-1 md:text-[14px]',
        active
          ? 'bg-accent/10 text-accent font-medium'
          : 'text-text-muted hover:bg-surface-elevated/60',
      ].join(' ')}
    >
      <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <KindIcon kind={kbFileKind(node.name)} className={iconClass} />
      <span className="truncate">
        <HighlightMatch text={node.name} query={filterQuery ?? ''} />
      </span>
    </button>
  );
}
