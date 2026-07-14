import { useInfiniteQuery } from '@tanstack/react-query';

import { fetchKbDirectory } from '@/api/kb';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';

import { TreeRow } from './FileTree';

export function useKbDirectoryPages(id: string, path: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.kbDirectory(id, path),
    queryFn: ({ pageParam, signal }) => fetchKbDirectory(id, path, pageParam || undefined, signal),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: refetchIntervals.kbContent,
  });
}

export function KbDirectoryRows({
  id,
  path,
  depth,
  expanded,
  selectedPath,
  now,
  onToggleDir,
  onSelectFile,
}: {
  id: string;
  path: string;
  depth: number;
  expanded: Set<string>;
  selectedPath: string | null;
  now: Date;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const query = useKbDirectoryPages(id, path);
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? [];
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
      <div className="tree-row py-2 pr-3 font-sans text-[12px] text-health-error" style={depthStyle}>
        {query.error instanceof Error ? query.error.message : String(query.error)}
      </div>
    );
  }

  return (
    <>
      {entries.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={depth}
          expanded={expanded}
          selectedPath={selectedPath}
          now={now}
          onToggleDir={onToggleDir}
          onSelectFile={onSelectFile}
          renderChildren={(directory, childDepth) => (
            <KbDirectoryRows
              id={id}
              path={directory.path}
              depth={childDepth}
              expanded={expanded}
              selectedPath={selectedPath}
              now={now}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
            />
          )}
        />
      ))}
      {query.hasNextPage && (
        <button
          type="button"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="tree-row py-2 pr-3 text-left font-sans text-[12px] font-medium text-accent disabled:opacity-50"
          style={depthStyle}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}
