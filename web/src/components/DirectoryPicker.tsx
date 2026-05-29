/**
 * DirectoryPicker — GitHub-style expandable tree directory navigator.
 * Folders expand/collapse in-place; children load lazily on first open.
 * Replaces the previous Miller-columns (Finder-style) design.
 *
 * API shape:
 *   <DirectoryPicker onChoose={path => …} onCancel={…} />
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FolderClosed, FolderOpen, Loader2 } from 'lucide-react';
import { fetchKbBrowse } from '@/api/kb';
import { queryKeys } from '@/lib/query-keys';
import { Button } from './ui/button';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DirectoryPickerProps {
  /** Starting directory path. Defaults to home (~). */
  startPath?: string;
  onChoose: (path: string) => void;
  onCancel: () => void;
  confirmLabel?: string;
  /** Disables the confirm button (e.g. while an async operation is in-flight). */
  confirmDisabled?: boolean;
}

// ---------------------------------------------------------------------------
// Tree node — fetches children lazily, recurses when expanded
// ---------------------------------------------------------------------------

function DirTreeNode({
  path,
  name,
  depth,
  expandedPaths,
  selectedPath,
  onToggle,
  onSelect,
}: {
  path: string;
  name: string;
  depth: number;
  expandedPaths: Set<string>;
  selectedPath: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const isExpanded = expandedPaths.has(path);
  const isSelected = selectedPath === path;

  // Scroll into view on first mount when pre-selected (handles async lazy-load timing:
  // the node only renders once its parent's fetch resolves, so scrollIntoView on mount
  // fires at exactly the right moment).
  const selectBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (isSelected) {
      selectBtnRef.current?.scrollIntoView({ block: 'nearest' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentional: mount-only

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.kbBrowse(path),
    queryFn: () => fetchKbBrowse(path),
    enabled: isExpanded,
    staleTime: 10_000,
  });
  const children = data?.entries ?? [];

  // 8px base left-padding + 16px per depth level (left-padding accounts for
  // the chevron + icon sitting inside the row, not as external markers).
  const pl = 8 + depth * 16;

  return (
    <div>
      {/* Row — outer div owns the bg so both the chevron and name areas highlight together */}
      <div
        className={[
          'flex w-full items-center',
          isSelected ? 'bg-accent/10' : 'hover:bg-surface-elevated/60',
        ].join(' ')}
        style={{ paddingLeft: pl }}
      >
        {/* Expand/collapse chevron — click = toggle only. tabIndex={-1}: keyboard nav lands on the
            select button; ArrowRight/Left handles expand from there. */}
        <button
          type="button"
          tabIndex={-1}
          onClick={() => onToggle(path)}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
          className="flex w-6 shrink-0 items-center justify-center py-1.5 text-text-subtle hover:text-text focus-visible:outline-none"
        >
          {isExpanded ? (
            <ChevronDown className="h-3 w-3 opacity-60" />
          ) : (
            <ChevronRight className="h-3 w-3 opacity-50" />
          )}
        </button>
        {/* Folder name — click = select only (no expand side-effect) */}
        <button
          ref={selectBtnRef}
          type="button"
          data-dir-tree-row
          data-path={path}
          onClick={() => onSelect(path)}
          className={[
            'flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-3 text-left font-sans text-[13px] transition-colors',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50',
            isSelected ? 'text-accent' : 'text-text',
          ].join(' ')}
        >
          {/* Folder icon */}
          {isExpanded ? (
            <FolderOpen className={`h-3.5 w-3.5 shrink-0 ${isSelected ? 'text-accent/70' : 'text-text-muted'}`} />
          ) : (
            <FolderClosed className={`h-3.5 w-3.5 shrink-0 ${isSelected ? 'text-accent/70' : 'text-text-subtle'}`} />
          )}
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {isLoading && (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-text-subtle" />
          )}
        </button>
      </div>

      {/* Empty state once children loaded */}
      {isExpanded && !isLoading && children.length === 0 && data && (
        <div
          className="py-1 font-serif italic text-[12px] text-text-subtle"
          style={{ paddingLeft: pl + 36 }}
        >
          No subdirectories
        </div>
      )}

      {/* Recurse into children */}
      {isExpanded &&
        children.map((child) => (
          <DirTreeNode
            key={child.path}
            path={child.path}
            name={child.name}
            depth={depth + 1}
            expandedPaths={expandedPaths}
            selectedPath={selectedPath}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DirectoryPicker
// ---------------------------------------------------------------------------

export default function DirectoryPicker({
  startPath,
  onChoose,
  onCancel,
  confirmLabel = 'Choose',
  confirmDisabled,
}: DirectoryPickerProps) {
  // Tree always browses from home root ('').
  // startPath is used only to pre-select + auto-expand — it is NOT the browse root.
  const rootPath = '';
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string>(startPath ?? '');
  const treeRef = useRef<HTMLDivElement>(null);

  // Root query — gives us the absolute home path for breadcrumb stripping,
  // and pre-fetches the top-level entries. Same query key as the first
  // DirTreeNode at depth=0 so the cache is shared.
  const { data: rootData, isLoading: rootLoading, error: rootError } = useQuery({
    queryKey: queryKeys.kbBrowse(rootPath),
    queryFn: () => fetchKbBrowse(undefined),
    staleTime: 10_000,
  });
  const rootAbsPath = rootData?.path ?? '';
  const rootEntries = rootData?.entries ?? [];

  // Auto-expand: when the root loads and startPath is provided, pre-expand all
  // ancestor directories between home and startPath so the target row is visible.
  const autoExpandDoneRef = useRef(false);
  useEffect(() => {
    if (autoExpandDoneRef.current || !rootAbsPath || !startPath) return;
    autoExpandDoneRef.current = true;
    if (!startPath.startsWith(rootAbsPath)) return;

    // e.g. rootAbsPath='/Users/alex', startPath='/Users/alex/anima/web'
    // → rel='/anima/web', segments=['anima','web']
    const rel = startPath.slice(rootAbsPath.length);
    const segments = rel.split('/').filter(Boolean);

    // Expand all ancestors of startPath (every segment except the leaf).
    // The leaf itself is visible once its parent expands, no need to expand it.
    if (segments.length <= 1) return; // direct child of root — already visible, no expansion needed

    const toExpand = new Set<string>();
    for (let i = 0; i < segments.length - 1; i++) {
      toExpand.add(rootAbsPath + '/' + segments.slice(0, i + 1).join('/'));
    }
    setTimeout(() => setExpandedPaths(toExpand), 0);
  }, [rootAbsPath, startPath]);

  function toggleExpanded(path: string) {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  // Breadcrumb: strip rootAbsPath prefix, split into clickable segments.
  const relPath =
    rootAbsPath && selectedPath.startsWith(rootAbsPath)
      ? selectedPath.slice(rootAbsPath.length)
      : selectedPath;
  const breadcrumbs = relPath
    .split('/')
    .filter(Boolean)
    .map((seg, i, arr) => ({
      label: seg,
      path: rootAbsPath + '/' + arr.slice(0, i + 1).join('/'),
    }));

  // Keyboard navigation: Up/Down through visible rows (queried via DOM),
  // Right/Left to expand/collapse, Enter to select.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!treeRef.current) return;
      const rows = Array.from(
        treeRef.current.querySelectorAll<HTMLButtonElement>('[data-dir-tree-row]'),
      );
      if (!rows.length) return;

      const focused = treeRef.current.querySelector<HTMLButtonElement>('[data-dir-tree-row]:focus');
      const idx = focused ? rows.indexOf(focused) : -1;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        rows[idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1)]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        rows[Math.max(0, idx <= 0 ? 0 : idx - 1)]?.focus();
      } else if (e.key === 'ArrowRight' && focused) {
        // Expand only — consistent with chevron click, does not change selection
        e.preventDefault();
        const p = focused.dataset.path;
        if (p && !expandedPaths.has(p)) {
          setExpandedPaths((prev) => new Set([...prev, p]));
        }
      } else if (e.key === 'ArrowLeft' && focused) {
        e.preventDefault();
        const p = focused.dataset.path;
        if (p && expandedPaths.has(p)) {
          setExpandedPaths((prev) => { const n = new Set(prev); n.delete(p); return n; });
        }
      } else if (e.key === 'Enter' && focused) {
        // Select only — consistent with name click, does not expand
        e.preventDefault();
        const p = focused.dataset.path;
        if (p) setSelectedPath(p);
      }
    },
    [expandedPaths],
  );

  return (
    <div className="flex flex-col">
      {/* Breadcrumb */}
      <div className="mb-2 flex min-h-[24px] items-center gap-0.5 overflow-x-auto pb-0.5">
        <button
          type="button"
          onClick={() => {
            setExpandedPaths(new Set());
            setSelectedPath(rootPath);
          }}
          className="shrink-0 font-mono text-[11px] text-text-muted hover:text-text"
          title="Home"
        >
          ~
        </button>
        {breadcrumbs.map((crumb, i) => (
          <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
            <ChevronRight className="h-2.5 w-2.5 text-text-subtle" />
            <button
              type="button"
              onClick={() => setSelectedPath(crumb.path)}
              className={[
                'font-mono text-[11px] hover:text-text',
                i === breadcrumbs.length - 1 ? 'font-semibold text-text' : 'text-text-muted',
              ].join(' ')}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </div>

      {/* Tree panel */}
      <div
        ref={treeRef}
        onKeyDown={handleKeyDown}
        className="h-[360px] overflow-y-auto rounded-sm border border-border bg-surface py-1"
      >
        {rootLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-text-subtle" />
          </div>
        )}
        {rootError && (
          <div className="px-4 py-3 font-sans text-[12px] text-health-error">
            {rootError instanceof Error ? rootError.message : 'Error loading directory'}
          </div>
        )}
        {!rootLoading && !rootError && rootEntries.length === 0 && (
          <div className="px-4 py-8 text-center font-serif italic text-[13px] text-text-subtle">
            No subdirectories
          </div>
        )}
        {rootEntries.map((entry) => (
          <DirTreeNode
            key={entry.path}
            path={entry.path}
            name={entry.name}
            depth={0}
            expandedPaths={expandedPaths}
            selectedPath={selectedPath}
            onToggle={toggleExpanded}
            onSelect={setSelectedPath}
          />
        ))}
      </div>

      {/* Footer — Cancel / Choose */}
      <div className="mt-3 flex items-center justify-end gap-2 border-t border-border-soft pt-3">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => onChoose(selectedPath)}
          disabled={!selectedPath || confirmDisabled}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
