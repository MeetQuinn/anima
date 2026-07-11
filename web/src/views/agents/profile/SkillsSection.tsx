import { useState } from 'react';
import { ChevronDown, FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchAgentSkills } from '@/api/agents';
import { buildAgentFilePath } from '@/lib/url-state';
import { queryKeys } from '@/lib/query-keys';
import type { SkillSourceSummary, SkillSummary } from '@shared/skills';

// ── Skills as a ledger ────────────────────────────────────────────────────────
//
// Cut-2 shape (task #98): skills read like the Setup ledger above them - quiet
// one-line rows, not description cards. Each row is a disclosure (name +
// truncated trigger line collapsed; full description, source path, and - for
// the agent's own skills - an Open in Files link when expanded). The agent's
// own skills lead: they are the identity-relevant ones; the shared pool is
// reference material. Counts ride the group eyebrows so scale is legible
// before you scroll (a Codex pool can be 45 across three sources).

/** Home-relative path for a skill dir, or null when it lives outside home. */
function homeRelativePath(homePath: string, sourcePath?: string): string | null {
  if (!homePath || !sourcePath) return null;
  const prefix = homePath.endsWith('/') ? homePath : `${homePath}/`;
  return sourcePath.startsWith(prefix) ? sourcePath.slice(prefix.length) : null;
}

// ---------------------------------------------------------------------------
// Single skill row: collapsed one-liner, expandable in place
// ---------------------------------------------------------------------------

function SkillRow({
  agentId,
  homePath,
  skill,
}: {
  agentId: string;
  homePath: string;
  skill: SkillSummary;
}) {
  const [open, setOpen] = useState(false);
  const relative = homeRelativePath(homePath, skill.sourcePath);
  const fileHref = relative ? buildAgentFilePath(agentId, `${relative}/SKILL.md`) : null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex w-full items-baseline gap-2.5 py-2 text-left"
      >
        <span className="shrink-0 font-serif text-[14px] leading-snug text-text">
          {skill.name}
        </span>
        <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-text-subtle transition-colors group-hover:text-text-muted">
          {open ? '' : skill.description}
        </span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 self-center text-text-subtle/50 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="space-y-2 pb-3 pr-6">
          {skill.description && (
            <p className="max-w-prose font-sans text-[12px] leading-relaxed text-text-muted">
              {skill.description}
            </p>
          )}
          {skill.sourcePath && (
            <div className="break-all font-mono text-[11px] text-text-subtle/60">
              {skill.sourcePath}
            </div>
          )}
          {fileHref && (
            <Link
              to={fileHref}
              className="inline-flex items-center gap-1 font-sans text-[11px] text-text-subtle underline decoration-text-subtle/40 underline-offset-2 hover:text-text-muted hover:decoration-text-muted/40"
            >
              <FileText className="h-3 w-3" />
              Open in Files
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function SkillLedger({
  agentId,
  homePath,
  skills,
}: {
  agentId: string;
  homePath: string;
  skills: SkillSummary[];
}) {
  return (
    <div className="divide-y divide-border-soft/60">
      {skills.map((skill) => (
        <SkillRow
          key={`${skill.sourcePath ?? ''}:${skill.dirName}`}
          agentId={agentId}
          homePath={homePath}
          skill={skill}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source subgroup (only when a group spans several sources, e.g. Codex's
// Common / Built-in / Bundled). Big reference piles start collapsed.
// ---------------------------------------------------------------------------

function SourceGroup({
  agentId,
  homePath,
  source,
}: {
  agentId: string;
  homePath: string;
  source: SkillSourceSummary;
}) {
  const [open, setOpen] = useState(
    source.kind === 'common' || source.kind === 'local' || source.kind === 'provider',
  );
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-2 py-1.5 text-left"
        title={source.path}
      >
        <ChevronDown
          className={`h-3 w-3 shrink-0 self-center text-text-subtle/50 transition-transform ${open ? 'rotate-180' : ''}`}
        />
        <span className="font-sans text-[12px] font-medium text-text-muted">{source.label}</span>
        <span className="font-mono text-[11px] text-text-subtle/70">{source.skills.length}</span>
      </button>
      {open && (
        <div className="ml-5">
          <SkillLedger agentId={agentId} homePath={homePath} skills={source.skills} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group: eyebrow label + count, then a flat ledger or source subgroups
// ---------------------------------------------------------------------------

function SkillGroup({
  agentId,
  emptyHint,
  homePath,
  label,
  path,
  skills,
  sources,
}: {
  agentId: string;
  /** Shown under the empty state so it reads as an invitation, not a dead end. */
  emptyHint?: string;
  homePath: string;
  label: string;
  path: string;
  skills: SkillSummary[];
  sources?: SkillSourceSummary[];
}) {
  const visibleSources = sources?.filter((source) => source.skills.length > 0) ?? [];
  return (
    <div>
      <div
        className="chrome mb-1 flex items-baseline gap-1.5 text-[10px] uppercase tracking-[0.1em] text-text-subtle"
        title={path}
      >
        <span>{label}</span>
        <span className="normal-case tracking-normal text-text-subtle/60">· {skills.length}</span>
      </div>
      {skills.length === 0 ? (
        <div className="py-1">
          <p className="font-serif text-[13px] italic text-text-subtle">None yet</p>
          {emptyHint && (
            <p className="mt-1 break-all font-mono text-[11px] text-text-subtle/50">{emptyHint}</p>
          )}
        </div>
      ) : visibleSources.length > 1 ? (
        <div className="space-y-1">
          {visibleSources.map((source) => (
            <SourceGroup
              key={`${source.kind}:${source.path}`}
              agentId={agentId}
              homePath={homePath}
              source={source}
            />
          ))}
        </div>
      ) : (
        <SkillLedger agentId={agentId} homePath={homePath} skills={skills} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function SkillsSection({ agentId, homePath }: { agentId: string; homePath: string }) {
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
    <div className="space-y-7">
      <SkillGroup
        agentId={agentId}
        label="This agent"
        path={data.localPath}
        skills={data.local}
        sources={data.localSources}
        homePath={homePath}
        emptyHint={data.localPath}
      />
      <SkillGroup
        agentId={agentId}
        label="Shared"
        path={data.globalPath}
        skills={data.global}
        sources={data.globalSources}
        homePath={homePath}
      />
    </div>
  );
}
