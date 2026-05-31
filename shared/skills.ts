export interface SkillSummary {
  /** Directory name — stable identifier. */
  dirName: string;
  /** Human-readable name from SKILL.md frontmatter, falls back to dirName. */
  name: string;
  /** Trigger description from SKILL.md frontmatter, if present. */
  description?: string;
  /** Source bucket inside Global or This agent's skills. */
  sourceKind?: SkillSourceKind;
  /** Human-readable source label, such as Common, Codex, or Built-in. */
  sourceLabel?: string;
  /** Absolute directory path for this skill. */
  sourcePath?: string;
}

export type SkillSourceKind =
  | "bundled"
  | "common"
  | "local"
  | "provider"
  | "system";

export interface SkillSourceSummary {
  /** Source bucket inside Global or This agent's skills. */
  kind: SkillSourceKind;
  /** Human-readable source label. */
  label: string;
  /** Absolute path that was scanned for this source. */
  path: string;
  /** Skills found in this source. */
  skills: SkillSummary[];
}

export interface AgentSkills {
  /** Skills available globally to this provider/agent. */
  global: SkillSummary[];
  /** Skills local to this agent's home directory. */
  local: SkillSummary[];
  /** Human-readable summary of global paths that were scanned. */
  globalPath: string;
  /** Human-readable summary of local paths that were scanned. */
  localPath: string;
  /** Global skills grouped by source. */
  globalSources?: SkillSourceSummary[];
  /** Agent-local skills grouped by source. */
  localSources?: SkillSourceSummary[];
}
