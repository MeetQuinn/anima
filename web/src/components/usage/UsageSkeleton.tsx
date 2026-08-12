export function UsageSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="flex items-center gap-2.5">
        <div className="h-7 w-7 rounded-md bg-surface-elevated" />
        <div className="h-3 w-24 rounded bg-surface-elevated" />
      </div>
      <div className="space-y-2 pl-[38px]">
        <div className="h-1.5 w-full rounded-full bg-surface-elevated" />
        <div className="h-1.5 w-2/3 rounded-full bg-surface-elevated" />
      </div>
    </div>
  );
}
