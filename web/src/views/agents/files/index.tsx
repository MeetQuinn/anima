import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Search, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchAgentHomeFile, fetchAgentHomeManifest } from '@/api/agent-files';
import type { AgentHomeEntry } from '@/api/agent-files';
import { buildAgentFilePath, buildAgentFileRawPath } from '@/lib/url-state';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import type { KbTreeNode } from '@shared/kb';
import { TreeRow, ancestorsOf, matchesFilter } from '../../kb/FileTree';
import { FileContent } from '../../kb/FileViewer';
import type { FileLinks } from '../../kb/FileViewer';

// ---------------------------------------------------------------------------
// Flat manifest → nested tree
//
// The backend sends a flat, recursive entry list (one node per file and dir,
// home-relative POSIX paths). We nest it client-side so the KB TreeRow — which
// consumes a KbTreeNode — renders it verbatim, then reorder the root level to
// the presentation order the spec asks for (MEMORY.md → notes/ → rest).
// ---------------------------------------------------------------------------

function buildTree(entries: AgentHomeEntry[]): KbTreeNode[] {
  const nodes = new Map<string, KbTreeNode>();
  for (const e of entries) {
    nodes.set(e.path, {
      name: e.name,
      path: e.path,
      type: e.kind === 'dir' ? 'dir' : 'file',
      ...(e.kind === 'dir' ? { children: [] as KbTreeNode[] } : {}),
    });
  }
  const roots: KbTreeNode[] = [];
  for (const e of entries) {
    const node = nodes.get(e.path)!;
    const slash = e.path.lastIndexOf('/');
    const parent = slash < 0 ? undefined : nodes.get(e.path.slice(0, slash));
    // Attach to parent dir when present; otherwise surface at root (top-level
    // entries, or an orphan whose parent dir wasn't listed) rather than drop it.
    if (parent && parent.children) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function byDirsFirstThenName(a: KbTreeNode, b: KbTreeNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function sortRecursive(nodes: KbTreeNode[]): void {
  nodes.sort(byDirsFirstThenName);
  for (const n of nodes) if (n.children) sortRecursive(n.children);
}

// Root order is presentation, not data: MEMORY.md (the agent's memory) first,
// notes/ (its durable knowledge) second, everything else after in the default
// dirs-first-alphabetical order.
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

// ---------------------------------------------------------------------------

export default function AgentFiles() {
  const { agentId, '*': splat } = useParams<{ agentId: string; '*'?: string }>();
  const filePath = splat || null;
  if (!agentId) return null;
  // Reset all per-agent view state when switching agents.
  return <AgentFilesContent key={agentId} agentId={agentId} filePath={filePath} />;
}

function AgentFilesContent({
  agentId,
  filePath,
}: {
  agentId: string;
  filePath: string | null;
}) {
  const navigate = useNavigate();
  const treeRef = useRef<HTMLDivElement>(null);

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const init = ancestorsOf(filePath);
    // No deep link: open notes/ by default so any note is two clicks (tab →
    // note). Harmless if the dir is absent — TreeRow only expands what exists.
    if (!filePath) init.add('notes');
    return init;
  });
  const [filterQuery, setFilterQuery] = useState('');

  const {
    data: manifest,
    error: manifestError,
    isLoading: manifestLoading,
  } = useQuery({
    queryKey: queryKeys.agentHomeFiles(agentId),
    queryFn: () => fetchAgentHomeManifest(agentId),
    refetchInterval: refetchIntervals.kbContent,
  });

  // Desktop default view: when nothing is deep-linked, land the operator on
  // MEMORY.md (what the agent knows) instead of a placeholder — one click into
  // the tab reaches rendered memory. The URL stays at bare /files so deep-link
  // semantics are untouched; mobile stays list-first (the right panel is hidden
  // until a real selection). Falls back to the placeholder when MEMORY.md is
  // absent.
  const memoryDefault = useMemo(() => {
    if (!manifest) return null;
    return manifest.entries.some((e) => e.kind === 'file' && e.path === 'MEMORY.md')
      ? 'MEMORY.md'
      : null;
  }, [manifest]);
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

  const tree = useMemo(() => {
    if (!manifest) return [];
    const roots = buildTree(manifest.entries);
    sortRecursive(roots);
    return orderRoot(roots);
  }, [manifest]);

  // URL builders pointed at the agent-home endpoints — this is the one swap
  // that repurposes the KB renderer for the Files surface.
  const links = useMemo<FileLinks>(
    () => ({
      rawPath: (p: string) => buildAgentFileRawPath(agentId, p),
      browsePath: (p: string) => buildAgentFilePath(agentId, p),
    }),
    [agentId],
  );

  // Open the tree to the deep-linked file so a refreshed/shared URL lands with
  // its branch expanded. Deferred a tick (matching the KB tree) so the merge
  // runs after commit rather than synchronously inside the effect body.
  useEffect(() => {
    if (!filePath) return;
    const t = setTimeout(() => {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const a of ancestorsOf(filePath)) next.add(a);
        return next;
      });
    }, 0);
    return () => clearTimeout(t);
  }, [filePath]);

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectFile = useCallback(
    (path: string) => {
      navigate(buildAgentFilePath(agentId, path));
    },
    [agentId, navigate],
  );

  // Keyboard navigation for the file tree: Up/Down between rows, Right/Left
  // expand/collapse dirs, Enter to select files or toggle dirs. Mirrors the KB
  // tree so the two surfaces feel identical.
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

  const root = manifest?.root ?? '';
  const isEmpty = !!manifest && manifest.entries.length === 0;
  // On mobile the file panel only slides in once a file is selected.
  const mobileShowRight = !!filePath;

  return (
    <div className="flex min-h-0 flex-1">
      {/* --------------------------------------------------------------- */}
      {/* Left panel: home header line + filter + tree */}
      {/* --------------------------------------------------------------- */}
      <nav
        className={[
          'flex w-full shrink-0 flex-col bg-surface-raised/40 md:w-72',
          mobileShowRight ? 'hidden md:flex' : 'flex',
        ].join(' ')}
      >
        {/* "Files in this agent's home" — ties the tab back to the agent-home
            concept, with the resolved root path visible (Iris/totoday naming). */}
        <div className="shrink-0 border-b border-border-soft px-4 py-2.5">
          <div className="font-sans text-[11px] font-medium uppercase tracking-[0.1em] text-text-subtle">
            Files in this agent's home
          </div>
          <div
            className="mt-0.5 truncate font-mono text-[11px] text-text-muted"
            title={root}
          >
            {manifestLoading && !root ? (
              <span className="inline-block h-[1em] w-40 animate-pulse rounded bg-surface-elevated align-middle" />
            ) : (
              root || '—'
            )}
          </div>
        </div>

        {/* Filter input */}
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

        {/* Tree */}
        <div
          ref={treeRef}
          onKeyDown={handleTreeKeyDown}
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {manifestError && (
            <div className="px-4 py-3 font-sans text-[12px] text-health-error">
              {manifestError instanceof Error ? manifestError.message : String(manifestError)}
            </div>
          )}
          {!manifest && !manifestError && (
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
          {tree.map((node) => (
            <TreeRow
              key={node.path}
              node={node}
              depth={0}
              expanded={expanded}
              selectedPath={filePath}
              filterQuery={filterQuery || undefined}
              onToggleDir={toggleDir}
              onSelectFile={selectFile}
            />
          ))}
          {filterQuery &&
            tree.length > 0 &&
            tree.every((n) => !matchesFilter(n, filterQuery)) && (
              <div className="px-4 py-3 font-sans text-[12px] text-text-subtle">
                No files match "{filterQuery}".
              </div>
            )}
          {manifest?.truncated && (
            <div className="mt-1 border-t border-border-soft px-4 py-2 font-sans text-[11px] text-text-subtle">
              Showing the first {manifest.entries.length.toLocaleString()} entries. This home has more
              files than the listing cap.
            </div>
          )}
        </div>
      </nav>

      {/* --------------------------------------------------------------- */}
      {/* Right panel: file content */}
      {/* --------------------------------------------------------------- */}
      <section
        className={[
          'min-w-0 border-l border-border-soft',
          mobileShowRight ? 'flex-1' : 'hidden md:flex md:flex-1',
        ].join(' ')}
      >
        {previewPath ? (
          <div className="flex h-full min-h-0 w-full flex-col">
            {/* Mobile file toolbar — back to the list, plus the filename. Only
                reachable on a real selection (filePath); the default preview is
                desktop-only, where this bar is hidden. */}
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
            </div>
            {/* Desktop file path bar. */}
            <div className="hidden min-h-[44px] shrink-0 items-center border-b border-border-soft px-5 md:flex">
              <span className="truncate font-mono text-[11px] text-text-subtle" title={previewPath}>
                {previewPath}
              </span>
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
              />
            </div>
          </div>
        ) : (
          <div className="hidden h-full flex-col items-start justify-start p-8 md:flex">
            <div className="font-serif text-[20px] font-semibold text-text">Files</div>
            <div className="mt-3 font-sans text-[13px] text-text-muted">
              {!manifest && !manifestError
                ? 'Loading…'
                : isEmpty
                  ? "This agent's home is empty."
                  : 'Select a file from the list to view it.'}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
