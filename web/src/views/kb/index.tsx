import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { fetchKb, fetchKbFile, searchKb } from '@/api/kb';
import { useNavigate, useParams } from 'react-router-dom';
import { buildKbPath } from '@/lib/url-state';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import { useIsMobile } from '@/hooks/use-mobile';
import { useNow } from '@/hooks/useNow';
import type { KbTreeNode } from '@shared/kb';

import { TreeRow, TreeSummary, ancestorsOf } from './FileTree';
import { KbDirectoryRows, useKbDirectoryPages } from './KbDirectoryRows';
import {
  FileContent,
  FileBreadcrumb,
  FileOverflowMenu,
  ViewModeToggle,
  TocButton,
  extractToc,
  loadSessionViewMode,
  saveSessionViewMode,
  lineFromHash,
} from './FileViewer';
import type { ViewMode } from './FileViewer';

const expandedDirsByKb = new Map<string, string[]>();
const lastViewedFileByKb = new Map<string, string>();
const DEFAULT_TREE_WIDTH = 288;

function restoredExpandedDirs(kbId: string, filePath: string | null): Set<string> {
  const expanded = new Set(expandedDirsByKb.get(kbId) ?? []);
  for (const ancestor of ancestorsOf(filePath)) expanded.add(ancestor);
  return expanded;
}

function cacheExpandedDirs(kbId: string, expanded: Set<string>): void {
  expandedDirsByKb.set(kbId, [...expanded]);
}

function searchResultTree(matches: KbTreeNode[]): KbTreeNode[] {
  const roots: KbTreeNode[] = [];
  const childrenByDir = new Map<string, KbTreeNode[]>([['', roots]]);
  for (const match of matches) {
    const segments = match.path.split('/');
    let parentPath = '';
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      const path = parentPath ? `${parentPath}/${name}` : name;
      const siblings = childrenByDir.get(parentPath) ?? roots;
      if (!childrenByDir.has(path)) {
        const children: KbTreeNode[] = [];
        siblings.push({ name, path, type: 'dir', children });
        childrenByDir.set(path, children);
      }
      parentPath = path;
    }
    (childrenByDir.get(parentPath) ?? roots).push(match);
  }
  const sort = (nodes: KbTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase());
    });
    for (const node of nodes) if (node.children) sort(node.children);
  };
  sort(roots);
  return roots;
}

export default function Kb() {
  // Route params: id from /kb/:id, splat (*) for the file path.
  const { id: idParam, '*': splatPath } = useParams<{ id: string; '*'?: string }>();
  const id = idParam!;
  const filePath = splatPath || null;

  return <KbContent key={id} id={id} filePath={filePath} />;
}

function KbContent({ id, filePath }: { id: string; filePath: string | null }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const [expanded, setExpanded] = useState<Set<string>>(() => restoredExpandedDirs(id, filePath));
  const [filterQuery, setFilterQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  // One clock for every row's relative mtime label (see TreeRow's `now`).
  const now = useNow();
  const [treeWidth, setTreeWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('kb.treeWidth');
      if (saved) return Math.max(180, Math.min(480, Number(saved)));
    } catch { /* ignore */ }
    return DEFAULT_TREE_WIDTH;
  });
  const [resizing, setResizing] = useState(false);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(DEFAULT_TREE_WIDTH);

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const {
    data: kb,
    error: kbError,
    isLoading: kbLoading,
  } = useQuery({ queryKey: queryKeys.kb(id), queryFn: () => fetchKb(id) });

  const rootQuery = useKbDirectoryPages(id, '');
  const rootEntries = useMemo(
    () => rootQuery.data?.pages.flatMap((page) => page.entries) ?? [],
    [rootQuery.data?.pages],
  );
  const treeError = rootQuery.error;
  const treeLoading = rootQuery.isPending;

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(filterQuery.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [filterQuery]);

  const searchResult = useQuery({
    queryKey: queryKeys.kbSearch(id, searchQuery),
    queryFn: ({ signal }) => searchKb(id, searchQuery, signal),
    enabled: !!searchQuery,
  });
  const filteredTree = useMemo(
    () => searchResultTree(searchResult.data?.matches ?? []),
    [searchResult.data?.matches],
  );

  const {
    data: file,
    error: fileError,
    isLoading: fileLoading,
  } = useQuery({
    queryKey: queryKeys.kbFile(id, filePath ?? ''),
    queryFn: ({ signal }) => fetchKbFile(id, filePath!, signal),
    enabled: !!filePath,
    refetchInterval: refetchIntervals.kbContent,
  });

  // Find the top-level README so we can show it as default right-panel content.
  const readmePath = useMemo<string | null>(() => {
    const node = rootEntries.find(
      (n) => n.type === 'file' && /^readme(\.(md|txt|rst))?$/i.test(n.name),
    );
    return node?.path ?? null;
  }, [rootEntries]);

  // Fetch README when no file is selected and one was found.
  const {
    data: readmeFile,
    isLoading: readmeLoading,
    error: readmeError,
  } = useQuery({
    queryKey: queryKeys.kbFile(id, readmePath ?? ''),
    queryFn: ({ signal }) => fetchKbFile(id, readmePath!, signal),
    enabled: !filePath && !!readmePath,
    refetchInterval: refetchIntervals.kbContent,
  });

  // Desktop "resume where you left off": when the URL points at a KB root (no
  // file) but this tab session remembers the last file viewed in this KB, jump
  // back to that file so the tree highlight and the content panel agree instead
  // of showing a stale tree selection next to the README. Tab-session memory
  // only (lastViewedFileByKb) — a hard reload has no memory and lands on the
  // README. The file endpoint validates the remembered target directly; it no
  // longer needs a full-tree membership scan. Mobile keeps its list-first flow.
  const rememberedFile = !filePath ? (lastViewedFileByKb.get(id) ?? null) : null;
  const resumeFile = useQuery({
    queryKey: queryKeys.kbFile(id, rememberedFile ?? ''),
    queryFn: ({ signal }) => fetchKbFile(id, rememberedFile!, signal),
    enabled: !isMobile && !filePath && !!rememberedFile,
    retry: false,
  });
  const resumeTarget = isMobile ? null : (resumeFile.data?.path ?? null);

  useEffect(() => {
    if (!resumeTarget) return;
    navigate(buildKbPath({ id, filePath: resumeTarget }), { replace: true });
  }, [resumeTarget, id, navigate]);

  // The document the right panel is actually showing: the selected file, or
  // the README default at the KB root. Header controls (breadcrumb,
  // Preview/Code, overflow, TOC) key off this so the root README gets the same
  // single-bar chrome as any opened file, instead of stacking its own path bar
  // and toggle strip above the content.
  const showingReadme = !filePath && !treeLoading && !resumeTarget && !!readmePath;
  const shownPath = filePath ?? (showingReadme ? readmePath : null);
  const shownFile = filePath ? file : showingReadme ? readmeFile : undefined;
  const shownLoading = filePath ? fileLoading : readmeLoading;
  const rawShownError = filePath ? fileError : showingReadme ? readmeError : null;
  const shownError =
    rawShownError instanceof Error
      ? rawShownError
      : rawShownError
        ? new Error(String(rawShownError))
        : null;

  // TOC entries for the shown markdown document — used by TocButton in the header.
  const toc = useMemo(() => {
    if (!shownFile || shownFile.kind !== 'markdown' || !shownFile.content) return [];
    return extractToc(shownFile.content);
  }, [shownFile]);

  // Preview/Code view-mode for the shown markdown document, lifted to the page
  // so the single toggle can live in the header alongside the other file
  // controls (instead of a second strip inside the viewer). Land in Code when
  // deep-linked to a `#L<n>` source line; otherwise honour the session choice.
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    lineFromHash(window.location.hash) ? 'code' : loadSessionViewMode(),
  );
  const changeViewMode = useCallback((next: ViewMode) => {
    setViewMode(next);
    saveSessionViewMode(next);
  }, []);
  const isMarkdown = shownFile?.kind === 'markdown';

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  // Open the tree to deep-linked files and remember the last file per KB so
  // back-to-files returns to the same branch instead of a reset tree.
  useEffect(() => {
    if (!filePath) return;
    lastViewedFileByKb.set(id, filePath);
    const t = setTimeout(() => {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const a of ancestorsOf(filePath)) next.add(a);
        cacheExpandedDirs(id, next);
        return next;
      });
    }, 0);
    return () => clearTimeout(t);
  }, [id, filePath]);

  // When the file panel returns to the tree, keep the last-opened row in view.
  // This is intentionally transient/in-memory, not a durable preference.
  const rowToRestore = filePath ? null : (lastViewedFileByKb.get(id) ?? null);
  useEffect(() => {
    if (filterQuery.trim() || rootQuery.isPending || !rowToRestore) return;
    const t = setTimeout(() => {
      const rows = Array.from(
        treeRef.current?.querySelectorAll<HTMLElement>('[data-tree-row][data-type="file"]') ?? [],
      );
      const row = rows.find((candidate) => candidate.dataset.path === rowToRestore);
      row?.scrollIntoView({ block: 'center' });
    }, 0);
    return () => clearTimeout(t);
  }, [expanded, filterQuery, rootQuery.isPending, rowToRestore]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const kbTitle = kb?.label ?? 'Knowledge Base';

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      cacheExpandedDirs(id, next);
      return next;
    });
  }, [id]);

  const selectFile = useCallback(
    (path: string) => {
      lastViewedFileByKb.set(id, path);
      navigate(buildKbPath({ id, filePath: path }));
    },
    [id, navigate],
  );

  // ---------------------------------------------------------------------------
  // Tree width resize
  // ---------------------------------------------------------------------------

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = treeWidth;
  }, [treeWidth]);

  useEffect(() => {
    if (!resizing) return;
    function onMove(e: MouseEvent) {
      const delta = e.clientX - startXRef.current;
      const next = Math.max(180, Math.min(480, startWidthRef.current + delta));
      setTreeWidth(next);
    }
    function onUp() {
      setResizing(false);
      try {
        localStorage.setItem('kb.treeWidth', String(treeWidth));
      } catch { /* ignore */ }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [resizing, treeWidth]);

  // Keyboard navigation for the file tree: Up/Down between rows, Right/Left
  // expand/collapse dirs, Enter to select files or toggle dirs.
  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!treeRef.current) return;
      const rows = Array.from(
        treeRef.current.querySelectorAll<HTMLElement>('[data-tree-row]'),
      );
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
        // Expand dir; no-op on files or when filtering (dirs auto-expand)
        e.preventDefault();
        const p = focused.dataset.path;
        if (p && focused.dataset.type === 'dir' && !expanded.has(p)) toggleDir(p);
      } else if (e.key === 'ArrowLeft' && focused && !filterQuery) {
        // Collapse dir; no-op on files or when filtering
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

  // On mobile, right panel (file view) only slides in when a file is selected.
  const mobileShowRight = !!filePath;
  const hasFilter = !!filterQuery.trim();

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ------------------------------------------------------------------ */}
      {/* Header */}
      {/* ------------------------------------------------------------------ */}
      <header className="flex min-h-[3.5rem] shrink-0 items-center gap-2 border-b border-border-soft px-4 md:h-14 md:gap-3 md:px-5">
        {/* Mobile back-to-nav button — shown when list panel is active */}
        {!mobileShowRight && (
          <button
            onClick={() => navigate('/')}
            className="md:hidden flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface-elevated hover:text-text -ml-2"
            aria-label="Back to home"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        {/* Mobile back button — shown when file panel is open */}
        {mobileShowRight && (
          <button
            onClick={() => navigate(buildKbPath({ id, filePath: null }))}
            className="md:hidden flex min-h-[44px] shrink-0 items-center gap-1 rounded-sm px-2 text-text-muted transition-colors hover:bg-surface-elevated hover:text-text"
            aria-label="Back to file list"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="font-sans text-[13px]">Files</span>
          </button>
        )}

        {/* Kb title — hidden on mobile when file panel is open */}
        <span
          className={[
            'font-sans text-[18px] font-semibold tracking-tight text-text shrink-0',
            mobileShowRight ? 'hidden md:block' : '',
          ].join(' ')}
        >
          {kbLoading ? (
            <span className="inline-block h-[1em] w-28 animate-pulse rounded bg-surface-elevated align-middle" />
          ) : (
            kbTitle
          )}
        </span>

        {/* File breadcrumb — left-aligned next to the KB title (desktop). A
            breadcrumb reads as location, so it belongs on the left as the
            continuation of the title path; the action controls stay right.
            The README default shows its own path here too — same chrome
            whether the doc was opened or is the root landing. */}
        {shownPath && (
          <div className="hidden md:flex min-w-0 items-center gap-1.5">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-subtle/40" />
            <FileBreadcrumb filePath={shownPath} />
          </div>
        )}

        {/* Right-side action controls — desktop only: [Preview|Code] [⋯] [TOC]. */}
        {shownPath && (
          <div className="ml-auto hidden md:flex shrink-0 items-center gap-2 pl-2">
            {isMarkdown && !shownLoading && (
              <ViewModeToggle mode={viewMode} onChange={changeViewMode} />
            )}
            <FileOverflowMenu
              id={id}
              filePath={shownPath}
              size={shownFile && !shownLoading ? shownFile.size : undefined}
            />
            <TocButton entries={toc} />
          </div>
        )}
      </header>

      {kbError && (
        <div className="px-5 py-4 font-sans text-[13px] text-health-error">
          Failed to load Knowledge Base:{' '}
          {kbError instanceof Error ? kbError.message : String(kbError)}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Body: left panel + right panel */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex min-h-0 flex-1">
        {/* Left panel */}
        <nav
          className={[
            'flex shrink-0 flex-col bg-surface-raised/40',
            mobileShowRight
              ? 'hidden md:flex md:w-[var(--kb-tree-width)]'
              : 'w-full md:flex md:w-[var(--kb-tree-width)]',
          ].join(' ')}
          style={{ '--kb-tree-width': `${treeWidth}px` } as React.CSSProperties}
        >
          {/* Filter input — pinned above the file tree. Bare row (icon +
              input) on the panel's own hairline; the boxed border-in-a-border
              treatment read as double chrome. */}
          <div className="flex shrink-0 items-center border-b border-border-soft px-4 min-h-[44px]">
            <div className="flex items-center gap-2 w-full">
              <Search className="h-3 w-3 shrink-0 text-text-subtle" />
              <input
                ref={filterInputRef}
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

          {/* File tree */}
          <div ref={treeRef} onKeyDown={handleTreeKeyDown} className="min-h-0 flex-1 overflow-y-auto py-1">
            {!hasFilter && treeError && (
              <div className="px-4 py-3 font-sans text-[12px] text-health-error">
                {treeError instanceof Error ? treeError.message : String(treeError)}
              </div>
            )}
            {!hasFilter && treeLoading && !treeError && (
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
            {!hasFilter && !treeLoading && !treeError && rootEntries.length === 0 && (
              <div className="px-4 py-3 font-sans text-[12px] text-text-subtle">
                No files.
              </div>
            )}
            {!hasFilter && !treeLoading && !treeError && !rootQuery.hasNextPage && (
              <TreeSummary nodes={rootEntries} />
            )}
            {!hasFilter && !treeLoading && !treeError && (
              <KbDirectoryRows
                id={id}
                path=""
                depth={0}
                expanded={expanded}
                selectedPath={filePath ?? rowToRestore}
                now={now}
                onToggleDir={toggleDir}
                onSelectFile={selectFile}
              />
            )}
            {hasFilter && (searchQuery !== filterQuery.trim() || searchResult.isPending) && (
              <div className="px-4 py-3 font-sans text-[12px] text-text-subtle">Searching…</div>
            )}
            {hasFilter && searchResult.error && searchQuery === filterQuery.trim() && (
              <div className="px-4 py-3 font-sans text-[12px] text-health-error">
                {searchResult.error instanceof Error ? searchResult.error.message : String(searchResult.error)}
              </div>
            )}
            {hasFilter && searchQuery === filterQuery.trim() && searchResult.data && (
              <>
                {filteredTree.map((node) => (
                  <TreeRow
                    key={node.path}
                    node={node}
                    depth={0}
                    expanded={expanded}
                    selectedPath={filePath ?? rowToRestore}
                    filterQuery={searchQuery}
                    now={now}
                    onToggleDir={toggleDir}
                    onSelectFile={selectFile}
                  />
                ))}
                {filteredTree.length === 0 && (
                  <div className="px-4 py-3 font-sans text-[12px] text-text-subtle">
                    No files match "{filterQuery}".
                  </div>
                )}
                {searchResult.data.truncated && (
                  <div className="px-4 py-3 font-sans text-[11px] text-text-subtle">
                    Showing a limited result set. Refine the filter to search less of this Knowledge Base.
                  </div>
                )}
              </>
            )}
          </div>
        </nav>

        {/* Resizer — wide hit target, thin visual line */}
        <div
          onMouseDown={startResize}
          className="hidden md:flex shrink-0 w-4 cursor-col-resize items-center justify-center"
        >
          <div
            className={[
              'h-full w-px transition-colors',
              resizing ? 'bg-accent' : 'bg-border-soft hover:bg-accent/50',
            ].join(' ')}
          />
        </div>

        {/* Right panel */}
        <section
          className={[
            'min-w-0 overflow-hidden',
            mobileShowRight ? 'flex-1' : 'hidden md:flex md:flex-1',
          ].join(' ')}
        >
          {shownPath ? (
            /* One render path for every document the panel shows - an opened
               file or the root README default. The page header carries the
               breadcrumb and controls for both, so the doc arrives with
               identical chrome either way and cannot drift into a second
               chrome variant again. w-full matters: at the KB root the parent
               section is itself a flex container, and the @container scroller
               inside would otherwise collapse this content-sized item to
               min-content width. */
            <div className="flex h-full w-full flex-col">
              {/* Mobile file toolbar — only when a file is explicitly open
                  (the README default never shows on mobile, which keeps its
                  file-list-first flow). The "‹ Files" back button already
                  gives location context, so drop the full path and show just
                  the filename plus the Preview/Code toggle and overflow/TOC. */}
              {filePath && (
                <div className="flex min-h-[44px] shrink-0 items-center gap-2 border-b border-border-soft px-4 md:hidden">
                  <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-medium text-text-muted">
                    {filePath.split('/').pop()}
                  </span>
                  {isMarkdown && !shownLoading && (
                    <ViewModeToggle mode={viewMode} onChange={changeViewMode} />
                  )}
                  <FileOverflowMenu
                    id={id}
                    filePath={filePath}
                    size={shownFile && !shownLoading ? shownFile.size : undefined}
                  />
                  <TocButton entries={toc} />
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
                <FileContent
                  id={id}
                  filePath={shownPath}
                  file={shownFile}
                  loading={shownLoading}
                  error={shownError}
                  mode={viewMode}
                  onModeChange={changeViewMode}
                />
              </div>
            </div>
          ) : treeLoading || resumeTarget ? (
            /* Loading, or about to redirect to the remembered file — hold the
               README so it doesn't flash before the resume redirect fires. */
            <div className="flex h-full flex-col items-start justify-start p-8">
              <div className="font-sans text-[13px] text-text-subtle">Loading files…</div>
            </div>
          ) : (
            /* Minimal fallback when no README exists */
            <div className="flex h-full flex-col items-start justify-start p-8">
              <div className="font-serif text-[20px] font-semibold text-text">{kbTitle}</div>
              <div className="mt-3 font-sans text-[13px] text-text-muted">
                Select a file from the tree to view it.
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
