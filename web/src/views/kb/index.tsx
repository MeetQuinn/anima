import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Search, X } from 'lucide-react';
import { fetchKb, fetchKbFile, fetchKbTree } from '@/api/kb';
import { useNavigate, useParams } from 'react-router-dom';
import { buildKbPath } from '@/lib/url-state';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';

import { TreeRow, ancestorsOf, matchesFilter } from './FileTree';
import { FileContent, BreadcrumbPath, FileToolbar, TocButton, extractToc } from './FileViewer';

const expandedDirsByKb = new Map<string, string[]>();
const lastViewedFileByKb = new Map<string, string>();

function restoredExpandedDirs(kbId: string, filePath: string | null): Set<string> {
  const expanded = new Set(expandedDirsByKb.get(kbId) ?? []);
  for (const ancestor of ancestorsOf(filePath)) expanded.add(ancestor);
  return expanded;
}

function cacheExpandedDirs(kbId: string, expanded: Set<string>): void {
  expandedDirsByKb.set(kbId, [...expanded]);
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

  const [expanded, setExpanded] = useState<Set<string>>(() => restoredExpandedDirs(id, filePath));
  const [filterQuery, setFilterQuery] = useState('');
  const [treeWidth, setTreeWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('kb.treeWidth');
      if (saved) return Math.max(180, Math.min(480, Number(saved)));
    } catch { /* ignore */ }
    return 256; // default matches md:w-64
  });
  const [resizing, setResizing] = useState(false);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(256);

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const {
    data: kb,
    error: kbError,
    isLoading: kbLoading,
  } = useQuery({ queryKey: queryKeys.kb(id), queryFn: () => fetchKb(id) });

  const {
    data: tree,
    error: treeError,
    isLoading: treeLoading,
  } = useQuery({
    queryKey: queryKeys.kbTree(id),
    queryFn: () => fetchKbTree(id),
    refetchInterval: 30_000,
  });

  const {
    data: file,
    error: fileError,
    isLoading: fileLoading,
  } = useQuery({
    queryKey: queryKeys.kbFile(id, filePath ?? ''),
    queryFn: () => fetchKbFile(id, filePath!),
    enabled: !!filePath,
    refetchInterval: 30_000,
  });

  // Find the top-level README so we can show it as default right-panel content.
  const readmePath = useMemo<string | null>(() => {
    if (!tree) return null;
    const node = tree.nodes.find(
      (n) => n.type === 'file' && /^readme(\.(md|txt|rst))?$/i.test(n.name),
    );
    return node?.path ?? null;
  }, [tree]);

  // Fetch README when no file is selected and one was found.
  const {
    data: readmeFile,
    isLoading: readmeLoading,
    error: readmeError,
  } = useQuery({
    queryKey: queryKeys.kbFile(id, readmePath ?? ''),
    queryFn: () => fetchKbFile(id, readmePath!),
    enabled: !filePath && !!readmePath,
    refetchInterval: 30_000,
  });

  // TOC entries for the currently selected markdown file — used by TocButton in the header.
  const toc = useMemo(() => {
    if (!file || file.kind !== 'markdown' || !file.content) return [];
    return extractToc(file.content);
  }, [file]);

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
    if (filterQuery || !tree || !rowToRestore) return;
    const t = setTimeout(() => {
      const rows = Array.from(
        treeRef.current?.querySelectorAll<HTMLElement>('[data-tree-row][data-type="file"]') ?? [],
      );
      const row = rows.find((candidate) => candidate.dataset.path === rowToRestore);
      row?.scrollIntoView({ block: 'center' });
    }, 0);
    return () => clearTimeout(t);
  }, [expanded, filterQuery, rowToRestore, tree]);

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

        {/* Right-side header controls — desktop only */}
        {filePath && (
          <div className="ml-auto hidden md:flex min-w-0 items-center gap-2">
            <div className="min-w-0 mr-1">
              <BreadcrumbPath filePath={filePath} />
            </div>
            {file && !fileLoading && (
              <span className="chrome shrink-0 text-[11px] text-text-subtle">
                {formatBytes(file.size)}
              </span>
            )}
            <FileToolbar id={id} filePath={filePath} />
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
          {/* Filter input — pinned above the file tree */}
          <div className="flex shrink-0 items-center border-b border-border-soft px-3 min-h-[44px]">
            <div className="flex items-center gap-1.5 rounded-md border border-border-soft bg-surface-elevated/40 px-2 py-1.5 w-full">
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
            {treeError && (
              <div className="px-4 py-3 font-sans text-[12px] text-health-error">
                {treeError instanceof Error ? treeError.message : String(treeError)}
              </div>
            )}
            {!tree && !treeError && (
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
            {tree && tree.nodes.length === 0 && (
              <div className="px-4 py-3 font-sans text-[12px] text-text-subtle">
                No tracked files.
              </div>
            )}
            {tree?.nodes.map((node) => (
              <TreeRow
                key={node.path}
                node={node}
                depth={0}
                expanded={expanded}
                selectedPath={filePath ?? rowToRestore}
                filterQuery={filterQuery || undefined}
                onToggleDir={toggleDir}
                onSelectFile={selectFile}
              />
            ))}
            {/* Filter zero-results notice */}
            {filterQuery && tree && tree.nodes.length > 0 &&
              tree.nodes.every((n) => !matchesFilter(n, filterQuery)) && (
                <div className="px-4 py-3 font-sans text-[12px] text-text-subtle">
                  No files match "{filterQuery}".
                </div>
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
          {filePath ? (
            <div className="flex h-full flex-col">
              {/* Mobile file toolbar */}
              <div className="flex min-h-[44px] shrink-0 items-center gap-2 border-b border-border-soft px-4 md:hidden">
                <div className="min-w-0 flex-1">
                  <BreadcrumbPath filePath={filePath} />
                </div>
                {file && !fileLoading && (
                  <span className="chrome shrink-0 text-[11px] text-text-subtle">
                    {formatBytes(file.size)}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-0.5">
                  <FileToolbar id={id} filePath={filePath} />
                  <TocButton entries={toc} />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
                <FileContent
                  id={id}
                  filePath={filePath}
                  file={file}
                  loading={fileLoading}
                  error={
                    fileError instanceof Error
                      ? fileError
                      : fileError
                        ? new Error(String(fileError))
                        : null
                  }
                />
              </div>
            </div>
          ) : treeLoading ? (
            <div className="flex h-full flex-col items-start justify-start p-8">
              <div className="font-sans text-[13px] text-text-subtle">Loading files…</div>
            </div>
          ) : readmePath ? (
            /* README default */
            <div className="flex h-full flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-5 min-h-[44px]">
                <span className="font-mono text-[11px] text-text-subtle truncate">{readmePath}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
                {readmeLoading ? (
                  <div className="p-6 font-sans text-[13px] text-text-subtle">Loading…</div>
                ) : readmeError ? (
                  <div className="p-6 font-sans text-[13px] text-health-error">
                    Could not load README: {readmeError instanceof Error ? readmeError.message : String(readmeError)}
                  </div>
                ) : readmeFile ? (
                  <FileContent
                    id={id}
                    filePath={readmePath}
                    file={readmeFile}
                    loading={false}
                    error={null}
                  />
                ) : (
                  <div className="p-6 font-sans text-[13px] text-text-subtle">README not found.</div>
                )}
              </div>
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
