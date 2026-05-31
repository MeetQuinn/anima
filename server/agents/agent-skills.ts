import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { AgentConfig } from "../../shared/agent-config.js";
import type {
  AgentSkills,
  SkillSourceKind,
  SkillSourceSummary,
  SkillSummary,
} from "../../shared/skills.js";
import { resolveAgentHomePath } from "./agent-config-ops.js";

const PLUGIN_CACHE_MAX_DEPTH = 8;

interface SkillScanOptions {
  homeDir?: string;
}

interface SkillRoots {
  agentsSkills: string;
  claudeInstalledPlugins: string;
  claudePluginsCache: string;
  claudeSkills: string;
  codexPluginsCache: string;
  codexSkills: string;
  codexSystemSkills: string;
}

interface SkillSourceDefinition {
  kind: SkillSourceKind;
  label: string;
  path: string;
  scanner?: "nested" | "top-level";
}

interface SkillReadResult extends SkillSummary {
  realPath: string;
}

export async function scanAgentSkills(
  agent: AgentConfig,
  options: SkillScanOptions = {},
): Promise<AgentSkills> {
  const roots = skillRoots(options.homeDir ?? homedir());
  const agentHome = resolveAgentHomePath(agent);
  const globalDefinitions = await globalSkillSources(agent, roots);
  const localDefinitions = localSkillSources(agent, agentHome);
  const globalSources = await scanSources(globalDefinitions);
  const localSources = await scanSources(localDefinitions);
  return {
    global: flattenSources(globalSources),
    globalPath: pathSummary(globalSources, globalDefinitions),
    globalSources,
    local: flattenSources(localSources),
    localPath: pathSummary(localSources, localDefinitions),
    localSources,
  };
}

function skillRoots(homeDir: string): SkillRoots {
  return {
    agentsSkills: join(homeDir, ".agents", "skills"),
    claudeInstalledPlugins: join(
      homeDir,
      ".claude",
      "plugins",
      "installed_plugins.json",
    ),
    claudePluginsCache: join(homeDir, ".claude", "plugins", "cache"),
    claudeSkills: join(homeDir, ".claude", "skills"),
    codexPluginsCache: join(homeDir, ".codex", "plugins", "cache"),
    codexSkills: join(homeDir, ".codex", "skills"),
    codexSystemSkills: join(homeDir, ".codex", "skills", ".system"),
  };
}

async function globalSkillSources(
  agent: AgentConfig,
  roots: SkillRoots,
): Promise<SkillSourceDefinition[]> {
  if (agent.provider.kind === "codex-cli") {
    return [
      { kind: "common", label: "Common", path: roots.agentsSkills },
      { kind: "provider", label: "Codex", path: roots.codexSkills },
      { kind: "system", label: "Built-in", path: roots.codexSystemSkills },
      {
        kind: "bundled",
        label: "Bundled",
        path: roots.codexPluginsCache,
        scanner: "nested",
      },
    ];
  }

  if (agent.provider.kind === "claude-code") {
    return [
      { kind: "common", label: "Common", path: roots.agentsSkills },
      { kind: "provider", label: "Claude Code", path: roots.claudeSkills },
      ...(await claudeUserPluginSources(roots)),
    ];
  }

  return [{ kind: "common", label: "Common", path: roots.agentsSkills }];
}

function localSkillSources(
  agent: AgentConfig,
  agentHome: string,
): SkillSourceDefinition[] {
  const common = {
    kind: "local" as const,
    label: "Agent",
    path: join(agentHome, ".agents", "skills"),
  };
  if (agent.provider.kind === "codex-cli") {
    return [
      common,
      {
        kind: "local",
        label: "Agent Codex",
        path: join(agentHome, ".codex", "skills"),
      },
    ];
  }
  if (agent.provider.kind === "claude-code") {
    return [
      common,
      {
        kind: "local",
        label: "Agent Claude Code",
        path: join(agentHome, ".claude", "skills"),
      },
    ];
  }
  return [common];
}

async function claudeUserPluginSources(
  roots: SkillRoots,
): Promise<SkillSourceDefinition[]> {
  const installed = await readJsonFile(roots.claudeInstalledPlugins);
  if (!isRecord(installed) || !isRecord(installed["plugins"])) return [];
  const sources: SkillSourceDefinition[] = [];
  for (const [pluginId, installs] of Object.entries(installed["plugins"])) {
    if (!Array.isArray(installs)) continue;
    for (const install of installs) {
      if (!isRecord(install)) continue;
      if (install["scope"] !== "user") continue;
      const installPath = stringValue(install["installPath"]);
      if (!installPath) continue;
      sources.push({
        kind: "provider",
        label: pluginLabel(pluginId, "Claude plugin"),
        path: installPath,
        scanner: "nested",
      });
    }
  }
  return sources;
}

function pluginLabel(pluginId: string, fallback: string): string {
  const [name] = pluginId.split("@");
  return name ? name : fallback;
}

async function scanSources(
  definitions: SkillSourceDefinition[],
): Promise<SkillSourceSummary[]> {
  const seenRealPaths = new Set<string>();
  const sources: SkillSourceSummary[] = [];
  for (const definition of definitions) {
    const results =
      definition.scanner === "nested"
        ? await scanNestedSkillDirs(definition, seenRealPaths)
        : await scanTopLevelSkillDir(definition, seenRealPaths);
    sources.push({
      kind: definition.kind,
      label: definition.label,
      path: definition.path,
      skills: results.map(stripInternalFields),
    });
  }
  return sources;
}

async function scanTopLevelSkillDir(
  definition: SkillSourceDefinition,
  seenRealPaths: Set<string>,
): Promise<SkillReadResult[]> {
  let entries;
  try {
    entries = await readdir(definition.path, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirNames: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      dirNames.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    try {
      const linkTarget = await lstat(join(definition.path, entry.name));
      if (linkTarget.isSymbolicLink()) dirNames.push(entry.name);
    } catch {
      // Ignore broken links.
    }
  }

  const results = await Promise.all(
    dirNames
      .sort()
      .map((dirName) =>
        readSkill(
          join(definition.path, dirName),
          dirName,
          definition,
          seenRealPaths,
        ),
      ),
  );
  return results.filter((skill): skill is SkillReadResult => skill !== null);
}

async function scanNestedSkillDirs(
  definition: SkillSourceDefinition,
  seenRealPaths: Set<string>,
): Promise<SkillReadResult[]> {
  const dirs = await findSkillDirs(
    definition.path,
    definition.scanner === "nested" ? PLUGIN_CACHE_MAX_DEPTH : 3,
  );
  const results = await Promise.all(
    dirs.map((dir) => readSkill(dir, basename(dir), definition, seenRealPaths)),
  );
  return results
    .filter((skill): skill is SkillReadResult => skill !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function findSkillDirs(
  root: string,
  maxDepth: number,
): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      results.push(dir);
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) return;
        if (entry.name === "node_modules") return;
        await walk(join(dir, entry.name), depth + 1);
      }),
    );
  }

  await walk(root, 0);
  return results;
}

async function readSkill(
  skillDir: string,
  dirName: string,
  source: SkillSourceDefinition,
  seenRealPaths: Set<string>,
): Promise<SkillReadResult | null> {
  try {
    const [content, resolvedPath] = await Promise.all([
      readFile(join(skillDir, "SKILL.md"), "utf8"),
      realpath(skillDir),
    ]);
    if (seenRealPaths.has(resolvedPath)) return null;
    seenRealPaths.add(resolvedPath);
    const frontmatter = parseSkillFrontmatter(content);
    return {
      dirName,
      name: frontmatter.name ?? dirName,
      realPath: resolvedPath,
      sourceKind: source.kind,
      sourceLabel: source.label,
      sourcePath: skillDir,
      ...(frontmatter.description
        ? { description: frontmatter.description }
        : {}),
    };
  } catch {
    return null;
  }
}

function stripInternalFields(skill: SkillReadResult): SkillSummary {
  const { realPath: _realPath, ...summary } = skill;
  return summary;
}

function flattenSources(sources: SkillSourceSummary[]): SkillSummary[] {
  return sources.flatMap((source) => source.skills);
}

function pathSummary(
  sources: SkillSourceSummary[],
  definitions: SkillSourceDefinition[],
): string {
  const pathsWithSkills = sources
    .filter((source) => source.skills.length > 0)
    .map((source) => source.path);
  return (
    pathsWithSkills.length > 0
      ? pathsWithSkills
      : definitions.map((definition) => definition.path)
  ).join(", ");
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? resolve(value) : undefined;
}

interface SkillFrontmatter {
  description?: string;
  name?: string;
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: SkillFrontmatter = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const keyValue = line.match(/^(\w+)\s*:\s*(.*)/);
    if (!keyValue) continue;
    const key = keyValue[1]!;
    const value = normalizeFrontmatterValue(keyValue[2]!.trim());
    if (key === "description" && value) result.description = value;
    if (key === "name" && value) result.name = value;
  }
  return result;
}

function normalizeFrontmatterValue(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote)
    return value;
  return value.slice(1, -1);
}
