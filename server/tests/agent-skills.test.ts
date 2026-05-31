import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scanAgentSkills } from "../agents/agent-skills.js";
import type { AgentConfig } from "../../shared/agent-config.js";

test("codex skills include common, user, system, bundled, and agent-local sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "anima-codex-skills-test-"));
  try {
    const agentHome = join(root, "agent-home");
    await writeSkill(join(root, ".agents", "skills", "frontend-design"), {
      description: "Shared frontend skill",
      name: "frontend-design",
    });
    await writeSkill(join(root, ".codex", "skills", "context7-cli"), {
      description: "Codex user skill",
      name: "context7-cli",
    });
    await writeRawSkill(
      join(root, ".codex", "skills", ".system", "imagegen"),
      `---\nname: "imagegen"\ndescription: "Codex system skill"\n---\n\n# imagegen\n`,
    );
    await writeSkill(
      join(
        root,
        ".codex",
        "plugins",
        "cache",
        "openai",
        "documents",
        "1.0.0",
        "skills",
        "documents",
      ),
      {
        description: "Bundled document skill",
        name: "documents",
      },
    );
    await writeSkill(join(agentHome, ".codex", "skills", "release-helper"), {
      description: "Only this agent has it",
      name: "release-helper",
    });

    const skills = await scanAgentSkills(codexAgent(agentHome), {
      homeDir: root,
    });

    assert.deepEqual(
      skills.global.map((skill) => `${skill.sourceLabel}:${skill.name}`).sort(),
      [
        "Built-in:imagegen",
        "Bundled:documents",
        "Codex:context7-cli",
        "Common:frontend-design",
      ],
    );
    assert.deepEqual(
      skills.local.map((skill) => skill.name),
      ["release-helper"],
    );
    assert.equal(skills.globalSources?.length, 4);
    assert.equal(
      skills.localSources?.find((source) => source.label === "Agent Codex")
        ?.skills.length,
      1,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("claude skills follow global symlinks and include only user-scope installed plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "anima-claude-skills-test-"));
  try {
    const agentHome = join(root, "agent-home");
    const commonSkill = join(root, ".agents", "skills", "frontend-design");
    await writeSkill(commonSkill, {
      description: "Shared frontend skill",
      name: "frontend-design",
    });
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await symlink(
      "../../.agents/skills/frontend-design",
      join(root, ".claude", "skills", "frontend-design"),
    );

    const userPluginRoot = join(
      root,
      ".claude",
      "plugins",
      "cache",
      "zai",
      "glm-plan-usage",
      "1.0.0",
    );
    await writeSkill(join(userPluginRoot, "skills", "usage-query-skill"), {
      description: "User installed plugin skill",
      name: "usage-query-skill",
    });
    const unrelatedLocalPluginRoot = join(
      root,
      ".claude",
      "plugins",
      "cache",
      "anthropic",
      "example-skills",
      "1.0.0",
    );
    await writeSkill(
      join(unrelatedLocalPluginRoot, "skills", "algorithmic-art"),
      {
        description: "Local plugin for another project",
        name: "algorithmic-art",
      },
    );
    await writeSkill(join(agentHome, ".claude", "skills", "agent-runbook"), {
      description: "Agent-specific Claude skill",
      name: "agent-runbook",
    });
    await writeFile(
      join(root, ".claude", "plugins", "installed_plugins.json"),
      `${JSON.stringify({
        version: 2,
        plugins: {
          "example-skills@anthropic-agent-skills": [
            {
              installPath: unrelatedLocalPluginRoot,
              projectPath: join(root, "some-other-project"),
              scope: "local",
            },
          ],
          "glm-plan-usage@zai-coding-plugins": [
            {
              installPath: userPluginRoot,
              scope: "user",
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const skills = await scanAgentSkills(claudeAgent(agentHome), {
      homeDir: root,
    });

    assert.deepEqual(
      skills.global.map((skill) => `${skill.sourceLabel}:${skill.name}`).sort(),
      ["Common:frontend-design", "glm-plan-usage:usage-query-skill"],
    );
    assert.equal(
      skills.global.filter((skill) => skill.name === "frontend-design").length,
      1,
    );
    assert.equal(
      skills.global.some((skill) => skill.name === "algorithmic-art"),
      false,
    );
    assert.equal(
      skills.globalSources?.find((source) => source.label === "glm-plan-usage")
        ?.kind,
      "provider",
    );
    assert.deepEqual(
      skills.local.map((skill) => skill.name),
      ["agent-runbook"],
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

async function writeSkill(
  dir: string,
  frontmatter: { description: string; name: string },
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${frontmatter.name}\ndescription: ${frontmatter.description}\n---\n\n# ${frontmatter.name}\n`,
    "utf8",
  );
}

async function writeRawSkill(dir: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf8");
}

function codexAgent(homePath: string): AgentConfig {
  return {
    homePath,
    id: "codex-agent",
    profile: { displayName: "Codex Agent", role: "" },
    provider: { kind: "codex-cli", model: "gpt-5.5" },
    slack: {
      appToken: "",
      botToken: "",
      connected: false,
      manifestVersion: 0,
      teamId: "",
    },
  } as AgentConfig;
}

function claudeAgent(homePath: string): AgentConfig {
  return {
    homePath,
    id: "claude-agent",
    profile: { displayName: "Claude Agent", role: "" },
    provider: { kind: "claude-code", model: "opus" },
    slack: {
      appToken: "",
      botToken: "",
      connected: false,
      manifestVersion: 0,
      teamId: "",
    },
  } as AgentConfig;
}
