import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Search, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchAgentHomeDirectory, fetchAgentHomeFile } from '@/api/agent-files';
import type { AgentHomeEntry } from '@/api/agent-files';
import { buildAgentFilePath, buildAgentFileRawPath } from '@/lib/url-state';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import { useNow } from '@/hooks/useNow';
import type { KbTreeNode } from '@shared/kb';
import { TreeRow, TreeSummary, ancestorsOf, matchesFilter } from '../../kb/FileTree';
import {
  FileContent,
  FileBreadcrumb,
  FileOverflowMenu,
  TocButton,
  ViewModeToggle,
  extractToc,
  lineFromHash,
  loadSessionViewMode,
  saveSessionViewMode,
} from '../../kb/FileViewer';
import type { FileLinks, ViewMode } from '../../kb/FileViewer';

// ---------------------------------------------------------------------------
// Shallow directory listing → tree nodes (one level). Children of expanded
// dirs are loaded by AgentHomeDirectoryRows, matching the KB browser's
// lazy directory pattern so huge homes (worktrees / node_modules) stay usable.
// ---------------------------------------------------------------------------

function entryToNode(entry: AgentHomeEntry): KbTreeNode {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.kind === 'dir' ? 'dir' : 'file',
    ...(entry.mtime ? { mtime: entry.mtime } : {}),
    // Omit children for dirs so matchesFilter treats them as not-yet-loaded
    // (lazy rows use renderChildren instead of node.children).
  };
}

function byDirsFirstThenName(a: KbTreeNode, b: KbTreeNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

// Root order is presentation, not data: MEMORY.md first, notes/ second,
// everything else dirs-first-alphabetical.
function orderRoot(nodes: KbTreeNode[]): KbTreeNode[] {
  const rank = (n: KbTreeNode): number => {
    if (n.type === 'file' && n.name === 'MEMORY.md') return 0;
    if (n.type === 'dir' && n.name === 'notes') return 1;
    return 2;
  };
  return [...nodes].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra !== rb ? ra - rb : byDirsFirstThenName(a, b);
  });
}

function sortEntries(entries: AgentHomeEntry[]): KbTreeNode[] {
  return entries.map(entryToNode).sort(byDirsFirstThenName);
}

// Expanded-dirs memory per agent — module-level so the tree survives the
// component remounts that file navigation triggers (same as before).
const expandedDirsByAgent = new Map<string, string[]>();

function restoredExpandedDirs(agentId: string, filePath: string | null): Set<string> {
  const cached = expandedDirsByAgent.get(agentId);
  const expanded = new Set(cached ?? []);
  for (const ancestor of ancestorsOf(filePath)) expanded.add(ancestor);
  // First visit only: open notes/ by default so any note is two clicks.
  if (!cached && !filePath) expanded.add('notes');
  return expanded;
}

function cacheExpandedDirs(agentId: string, expanded: Set<string>): void {
  expandedDirsByAgent.set(agentId, [...expanded]);
}

// ---------------------------------------------------------------------------

function useAgentHomeDirectory(agentId: string, dir: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.agentHomeFiles(agentId, dir),
    queryFn: () => fetchAgentHomeDirectory(agentId, dir),
    enabled,
    refetchInterval: refetchIntervals.kbContent,
  });
}

/** Lazy children for one expanded home directory. */
function AgentHomeDirectoryRows({
  agentId,
  path,
  depth,
  expanded,
  selectedPath,
  filterQuery,
  now,
  onToggleDir,
  onSelectFile,
}: {
  agentId: string;
  path: string;
  depth: number;
  expanded: Set<string>;
  selectedPath: string | null;
  filterQuery?: string;
  now: Date;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  // Always fetch when mounted: TreeRow only mounts us when the parent dir is open
  // (or while filtering, when dirs auto-expand).
  const query = useAgentHomeDirectory(agentId, path, true);
  const nodes = useMemo(() => sortEntries(query.data?.entries ?? []), [query.data?.entries]);
  const depthStyle = { '--tree-depth': depth } as React.CSSProperties;

  if (query.isPending) {
    return (
      <div className="tree-row py-2 pr-3 font-sans text-[12px] text-text-subtle" style={depthStyle}>
        Loading…
      </div>
    );
  }
  if (query.error) {
    return (
      <div
        className="tree-row py-2 pr-3 font-sans text-[12px] text-health-error"
        style={depthStyle}
      >
        {query.error instanceof Error ? query.error.message : String(query.error)}
      </div>
    );
  }

  return (
    <>
      {nodes.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={depth}
          expanded={expanded}
          selectedPath={selectedPath}
          filterQuery={filterQuery}
          now={now}
          onToggleDir={onToggleDir}
          onSelectFile={onSelectFile}
          renderChildren={(directory, childDepth) => (
            <AgentHomeDirectoryRows
              agentId={agentId}
              path={directory.path}
              depth={childDepth}
              expanded={expanded}
              selectedPath={selectedPath}
              filterQuery={filterQuery}
              now={now}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
            />
          )}
        />
      ))}
      {query.data?.truncated && (
        <div
          className="tree-row py-1.5 pr-3 font-sans text-[11px] text-text-subtle"
          style={depthStyle}
        >
          Showing the first {query.data.entries.length.toLocaleString()} entries in this folder.
        </div>
      )}
      {filterQuery &&
        nodes.length > 0 &&
        nodes.every((n) => !matchesFilter(n, filterQuery)) &&
        !nodes.some((n) => n.type === 'dir') && (
          <div
            className="tree-row py-1.5 pr-3 font-sans text-[11px] text-text-subtle"
            style={depthStyle}
          >
            No matches in this folder (expand other folders to search further).
          </div>
        )}
    </>
  );
}

export default function AgentFiles() {
  const { agentId, '*': splat } = useParams<{ agentId: string; '*'?: string }>();
  const filePath = splat || null;
  if (!agentId) return null;
  return <AgentFilesContent key={agentId} agentId={agentId} filePath={filePath} />;
}

function AgentFilesContent({ agentId, filePath }: { agentId: string; filePath: string | null }) {
  const navigate = useNavigate();
  const treeRef = useRef<HTMLDivElement>(null);

  const [expanded, setExpanded] = useState<Set<string>>(() =>
    restoredExpandedDirs(agentId, filePath),
  );
  const [filterQuery, setFilterQuery] = useState('');
  const now = useNow();

  const { data: rootListing, error: rootError } = useAgentHomeDirectory(agentId, '', true);

  // Prefetch ancestor directories for deep links so expand + file open work.
  const ancestorDirs = useMemo(() => [...ancestorsOf(filePath)], [filePath]);
  useEffect(() => {
    // Ensure deep-linked path's ancestors are expanded (and thus loaded).
    if (!filePath) return;
    const t = setTimeout(() => {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const a of ancestorsOf(filePath)) next.add(a);
        cacheExpandedDirs(agentId, next);
        return next;
      });
    }, 0);
    return () => clearTimeout(t);
  }, [agentId, filePath]);

  // Warm react-query cache for ancestors (component tree also loads them when expanded).
  for (const dir of ancestorDirs) {
    // Hooks can't be in loops — use a dedicated helper component instead.
    void dir;
  }

  const rootNodes = useMemo(() => {
    if (!rootListing) return [];
    return orderRoot(sortEntries(rootListing.entries));
  }, [rootListing]);

  // Desktop default: MEMORY.md when present.
  const memoryDefault = useMemo(() => {
    if (!rootListing) return null;
    return rootListing.entries.some((e) => e.kind === 'file' && e.path === 'MEMORY.md')
      ? 'MEMORY.md'
      : null;
  }, [rootListing]);
  const previewPath = filePath ?? memoryDefault;

  const {
    data: file,
    error: fileError,
    isLoading: fileLoading,
  } = useQuery({
    queryKey: queryKeys.agentHomeFile(agentId, previewPath ?? ''),
    queryFn: () => fetchAgentHomeFile(agentId, previewPath!),
    enabled: !!previewPath,
    refetchInterval: refetchIntervals.kbContent,
  });

  const links = useMemo<FileLinks>(
    () => ({
      rawPath: (p: string) => buildAgentFileRawPath(agentId, p),
      browsePath: (p: string) => buildAgentFilePath(agentId, p),
    }),
    [agentId],
  );

  const toc = useMemo(
    () => (file?.kind === 'markdown' && file.content ? extractToc(file.content) : []),
    [file],
  );

  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    lineFromHash(window.location.hash) ? 'code' : loadSessionViewMode(),
  );
  const changeViewMode = useCallback((next: ViewMode) => {
    setViewMode(next);
    saveSessionViewMode(next);
  }, []);
  const isMarkdown = file?.kind === 'markdown';

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        cacheExpandedDirs(agentId, next);
        return next;
      });
    },
    [agentId],
  );

  const selectFile = useCallback(
    (path: string) => {
      navigate(buildAgentFilePath(agentId, path));
    },
    [agentId, navigate],
  );

  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!treeRef.current) return;
      const rows = Array.from(treeRef.current.querySelectorAll<HTMLElement>('[data-tree-row]'));
      if (!rows.length) return;
      const focused = treeRef.current.querySelector<HTMLElement>('[data-tree-row]:focus');
      const idx = focused ? rows.indexOf(focused) : -1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        rows[idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1)]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        rows[Math.max(0, idx <= 0 ? 0 : idx - 1)]?.focus();
      } else if (e.key === 'ArrowRight' && focused && !filterQuery) {
        e.preventDefault();
        const p = focused.dataset.path;
        if (p && focused.dataset.type === 'dir' && !expanded.has(p)) toggleDir(p);
      } else if (e.key === 'ArrowLeft' && focused && !filterQuery) {
        e.preventDefault();
        const p = focused.dataset.path;
        if (p && focused.dataset.type === 'dir' && expanded.has(p)) toggleDir(p);
      } else if (e.key === 'Enter' && focused) {
        e.preventDefault();
        const p = focused.dataset.path;
        if (!p) return;
        if (focused.dataset.type === 'file') selectFile(p);
        else if (focused.dataset.type === 'dir' && !filterQuery) toggleDir(p);
      }
    },
    [expanded, filterQuery, toggleDir, selectFile],
  );

  const isEmpty = !!rootListing && rootListing.entries.length === 0;
  const mobileShowRight = !!filePath;

  return (
    <div className="flex h-full overflow-hidden">
      <nav
        className={[
          'flex min-h-0 w-full shrink-0 flex-col bg-surface-raised/40 md:w-72',
          mobileShowRight ? 'hidden md:flex' : 'flex',
        ].join(' ')}
      >
        <div className="flex min-h-[44px] shrink-0 items-center border-b border-border-soft px-3">
          <div className="flex w-full items-center gap-1.5 rounded-md border border-border-soft bg-surface-elevated/40 px-2 py-1.5">
            <Search className="h-3 w-3 shrink-0 text-text-subtle" />
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setFilterQuery('')}
              placeholder="Filter files…"
              className="min-w-0 flex-1 bg-transparent font-sans text-[12px] text-text placeholder:text-text-subtle outline-none"
            />
            {filterQuery && (
              <button
                onClick={() => setFilterQuery('')}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-subtle hover:text-text-muted"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        <div
          ref={treeRef}
          onKeyDown={handleTreeKeyDown}
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {rootError && (
            <div className="px-4 py-3 font-sans text-[12px] text-health-error">
              {rootError instanceof Error ? rootError.message : String(rootError)}
            </div>
          )}
          {!rootListing && !rootError && (
            <div className="animate-pulse py-1">
              {([0, 0, 1, 1, 0, 2, 1] as const).map((depth, i) => (
                <div
                  key={i}
                  className="tree-row flex items-center gap-1.5 py-1 pr-2"
                  style={{ '--tree-depth': depth } as React.CSSProperties}
                >
                  <div className="h-3.5 w-3.5 shrink-0 rounded bg-surface-elevated" />
                  <div
                    className="h-3 rounded bg-surface-elevated"
                    style={{ width: `${48 + ((i * 17 + 11) % 38)}%` }}
                  />
                </div>
              ))}
            </div>
          )}
          {isEmpty && (
            <div className="px-4 py-3 font-sans text-[12px] text-text-subtle">
              This agent's home is empty.
            </div>
          )}
          {!filterQuery && rootNodes.length > 0 && <TreeSummary nodes={rootNodes} />}
          {rootNodes.map((node) => (
            <TreeRow
              key={node.path}
              node={node}
              depth={0}
              expanded={expanded}
              selectedPath={filePath}
              filterQuery={filterQuery || undefined}
              now={now}
              onToggleDir={toggleDir}
              onSelectFile={selectFile}
              renderChildren={(directory, childDepth) => (
                <AgentHomeDirectoryRows
                  agentId={agentId}
                  path={directory.path}
                  depth={childDepth}
                  expanded={expanded}
                  selectedPath={filePath}
                  filterQuery={filterQuery || undefined}
                  now={now}
                  onToggleDir={toggleDir}
                  onSelectFile={selectFile}
                />
              )}
            />
          ))}
          {filterQuery &&
            rootNodes.length > 0 &&
            rootNodes.every((n) => !matchesFilter(n, filterQuery)) && (
              <div className="px-4 py-3 font-sans text-[12px] text-text-subtle">
                No files match "{filterQuery}" in loaded folders. Expand folders to search deeper.
              </div>
            )}
          {rootListing?.truncated && (
            <div className="mt-1 border-t border-border-soft px-4 py-2 font-sans text-[11px] text-text-subtle">
              Showing the first {rootListing.entries.length.toLocaleString()} entries in the home
              root.
            </div>
          )}
        </div>
      </nav>

      <section
        className={[
          'min-w-0 border-l border-border-soft',
          mobileShowRight ? 'flex-1' : 'hidden md:flex md:flex-1',
        ].join(' ')}
      >
        {previewPath ? (
          <div className="flex h-full min-h-0 w-full flex-col">
            <div className="flex min-h-[44px] shrink-0 items-center gap-2 border-b border-border-soft px-4 md:hidden">
              <button
                onClick={() => navigate(buildAgentFilePath(agentId, null))}
                className="-ml-2 flex min-h-[44px] shrink-0 items-center gap-1 rounded-sm px-2 text-text-muted transition-colors hover:bg-surface-elevated hover:text-text"
                aria-label="Back to file list"
              >
                <ChevronLeft className="h-4 w-4" />
                <span className="font-sans text-[13px]">Files</span>
              </button>
              <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-medium text-text-muted">
                {previewPath.split('/').pop()}
              </span>
              {isMarkdown && !fileLoading && (
                <ViewModeToggle mode={viewMode} onChange={changeViewMode} />
              )}
              <FileOverflowMenu
                id={agentId}
                filePath={previewPath}
                size={file && !fileLoading ? file.size : undefined}
                rawUrl={links.rawPath(previewPath)}
                downloadUrl={null}
              />
              <TocButton entries={toc} />
            </div>
            <div className="hidden min-h-[44px] shrink-0 items-center gap-2 border-b border-border-soft px-5 md:flex">
              <FileBreadcrumb filePath={previewPath} />
              <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
                {isMarkdown && !fileLoading && (
                  <ViewModeToggle mode={viewMode} onChange={changeViewMode} />
                )}
                <FileOverflowMenu
                  id={agentId}
                  filePath={previewPath}
                  size={file && !fileLoading ? file.size : undefined}
                  rawUrl={links.rawPath(previewPath)}
                  downloadUrl={null}
                />
                <TocButton entries={toc} />
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <FileContent
                id={agentId}
                filePath={previewPath}
                file={file}
                loading={fileLoading}
                error={
                  fileError instanceof Error
                    ? fileError
                    : fileError
                      ? new Error(String(fileError))
                      : null
                }
                links={links}
                mode={viewMode}
                onModeChange={changeViewMode}
              />
            </div>
          </div>
        ) : (
          <div className="hidden h-full flex-col items-start justify-start p-8 md:flex">
            <div className="font-serif text-[20px] font-semibold text-text">Files</div>
            <div className="mt-3 font-sans text-[13px] text-text-muted">
              {!rootListing && !rootError
                ? 'Loading…'
                : isEmpty
                  ? "This agent's home is empty."
                  : 'Select a file from the list to view it.'}
            </div>
          </div>
        )}
      </section>

      {/* Prefetch ancestor dirs for deep links without conditional hooks. */}
      {ancestorDirs.map((dir) => (
        <AncestorDirPrefetch key={dir} agentId={agentId} dir={dir} />
      ))}
    </div>
  );
}

/** Mount-only prefetch so deep-linked files open with parents already cached. */
function AncestorDirPrefetch({ agentId, dir }: { agentId: string; dir: string }) {
  useAgentHomeDirectory(agentId, dir, true);
  return null;
}
