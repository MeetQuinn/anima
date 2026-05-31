import { Bot, ChevronRight, Globe } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fetchAgentSkills } from '@/api/agents';
import { queryKeys } from '@/lib/query-keys';
import type { SkillSourceSummary, SkillSummary } from '@shared/skills';

// ---------------------------------------------------------------------------
// Single skill row
// ---------------------------------------------------------------------------

function SkillRow({
  showSourceBadge = true,
  skill,
}: {
  showSourceBadge?: boolean;
  skill: SkillSummary;
}) {
  return (
    <div className="py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 font-serif text-[14px] leading-snug text-text">
          {skill.name}
        </div>
        {showSourceBadge && skill.sourceLabel && (
          <span className="shrink-0 rounded-full border border-border-soft px-1.5 py-0.5 font-mono text-[10px] leading-none text-text-subtle">
            {skill.sourceLabel}
          </span>
        )}
      </div>
      {skill.description && (
        <div className="mt-0.5 line-clamp-2 font-sans text-[12px] leading-relaxed text-text-muted">
          {skill.description}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skill group (global / local)
// ---------------------------------------------------------------------------

function SkillGroup({
  label,
  icon: Icon,
  path,
  skills,
  sources,
}: {
  label: string;
  icon: LucideIcon;
  path: string;
  skills: SkillSummary[];
  sources?: SkillSourceSummary[];
}) {
  const visibleSources = sources?.filter((source) => source.skills.length > 0) ?? [];
  const sourceSummary =
    visibleSources.length > 0
      ? `${skills.length} skills across ${visibleSources.length} ${visibleSources.length === 1 ? 'source' : 'sources'}`
      : path;
  return (
    <div>
      {/* Label row */}
      <div className="mb-1 flex items-center gap-1.5">
        <Icon className="h-3 w-3 shrink-0 text-text-subtle" />
        <span className="caps text-text-subtle">{label}</span>
      </div>
      {/* Path subtitle */}
      <div
        className="mb-2 font-mono text-[11px] text-text-subtle/60 leading-snug truncate"
        title={path}
      >
        {sourceSummary}
      </div>
      {/* Skill list or empty state */}
      {skills.length === 0 ? (
        <p className="font-serif italic text-[13px] text-text-subtle">None</p>
      ) : visibleSources.length > 0 ? (
        <div className="space-y-2.5">
          {visibleSources.map((source) => (
            <SourceGroup
              key={`${source.kind}:${source.path}`}
              source={source}
            />
          ))}
        </div>
      ) : (
        <div className="divide-y divide-border-soft/60">
          {skills.map((skill) => (
            <SkillRow key={`${skill.sourcePath ?? path}:${skill.dirName}`} skill={skill} />
          ))}
        </div>
      )}
    </div>
  );
}

function SourceGroup({ source }: { source: SkillSourceSummary }) {
  const defaultOpen =
    source.kind === 'common' ||
    source.kind === 'local' ||
    source.kind === 'provider';
  const skillCount = `${source.skills.length} ${source.skills.length === 1 ? 'skill' : 'skills'}`;

  return (
    <details
      className="group border-b border-border-soft/60 pb-1 last:border-b-0"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5">
        <ChevronRight className="h-3 w-3 shrink-0 text-text-subtle/60 transition-transform group-open:rotate-90" />
        <span className="rounded-full border border-border-soft px-1.5 py-0.5 font-mono text-[10px] leading-none text-text-subtle">
          {source.label}
        </span>
        <span className="font-mono text-[10px] leading-none text-text-subtle/60">
          {skillCount}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10px] leading-none text-text-subtle/45"
          title={source.path}
        >
          {source.path}
        </span>
      </summary>
      <div className="ml-5 divide-y divide-border-soft/60">
        {source.skills.map((skill) => (
          <SkillRow
            key={`${skill.sourcePath ?? source.path}:${skill.dirName}`}
            showSourceBadge={false}
            skill={skill}
          />
        ))}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function SkillsSection({ agentId }: { agentId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.agentSkills(agentId),
    queryFn: () => fetchAgentSkills(agentId),
    enabled: !!agentId,
    // Skills change infrequently — no live refetch needed.
    staleTime: 60_000,
  });

  if (isLoading || !data) {
    return (
      <div className="space-y-1">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-4 w-32 animate-pulse rounded bg-surface-elevated" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SkillGroup
        label="Global skills"
        icon={Globe}
        path={data.globalPath}
        skills={data.global}
        sources={data.globalSources}
      />
      <SkillGroup
        label="This agent's skills"
        icon={Bot}
        path={data.localPath}
        skills={data.local}
        sources={data.localSources}
      />
    </div>
  );
}
