import { lstat, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { readBundledTemplate } from '../bundled-templates.js';
import { isMissingFile } from '../storage/json-file.js';

const FIND_SKILLS_DIR = 'find-skills';
const FIND_SKILLS_TEMPLATE = 'skills/find-skills/SKILL.md';

export interface EnsureDefaultSkillsOptions {
  homeDir?: string;
}

export interface EnsureDefaultSkillsResult {
  claudeLinkInstalled: boolean;
  commonSkillInstalled: boolean;
}

export async function ensureDefaultSkills(
  options: EnsureDefaultSkillsOptions = {},
): Promise<EnsureDefaultSkillsResult> {
  const homeDir = options.homeDir ?? homedir();
  const commonSkillDir = join(homeDir, '.agents', 'skills', FIND_SKILLS_DIR);
  const commonSkillInstalled = await ensureFindSkills(commonSkillDir);
  const claudeLinkInstalled = await ensureClaudeFindSkillsLink(homeDir, commonSkillDir);
  return { claudeLinkInstalled, commonSkillInstalled };
}

async function ensureFindSkills(skillDir: string): Promise<boolean> {
  const skillPath = join(skillDir, 'SKILL.md');
  if (await pathExists(skillPath)) return false;
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, await readBundledTemplate(FIND_SKILLS_TEMPLATE), 'utf8');
  return true;
}

async function ensureClaudeFindSkillsLink(homeDir: string, commonSkillDir: string): Promise<boolean> {
  const claudeSkillPath = join(homeDir, '.claude', 'skills', FIND_SKILLS_DIR);
  const existing = await lstat(claudeSkillPath).catch((error: unknown) => {
    if (isMissingFile(error)) return undefined;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() && !(await pathExists(claudeSkillPath))) {
      await rm(claudeSkillPath, { force: true });
    } else {
      return false;
    }
  }

  await mkdir(dirname(claudeSkillPath), { recursive: true });
  await symlink(relative(dirname(claudeSkillPath), commonSkillDir), claudeSkillPath, 'dir');
  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}
