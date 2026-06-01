import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureDefaultSkills } from '../agents/default-skills.js';

test('ensureDefaultSkills installs find-skills into common skills and links Claude Code', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-default-skills-'));
  try {
    const result = await ensureDefaultSkills({ homeDir });

    assert.deepEqual(result, {
      claudeLinkInstalled: true,
      commonSkillInstalled: true,
    });
    const skillPath = join(homeDir, '.agents', 'skills', 'find-skills', 'SKILL.md');
    assert.match(await readFile(skillPath, 'utf8'), /name: find-skills/);
    assert.equal(
      await readlink(join(homeDir, '.claude', 'skills', 'find-skills')),
      '../../.agents/skills/find-skills',
    );
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test('ensureDefaultSkills preserves existing skill content and provider paths', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-default-skills-'));
  try {
    const commonSkillDir = join(homeDir, '.agents', 'skills', 'find-skills');
    const claudeSkillDir = join(homeDir, '.claude', 'skills', 'find-skills');
    await mkdir(commonSkillDir, { recursive: true });
    await mkdir(claudeSkillDir, { recursive: true });
    await writeFile(join(commonSkillDir, 'SKILL.md'), 'custom common skill\n', 'utf8');
    await writeFile(join(claudeSkillDir, 'SKILL.md'), 'custom claude skill\n', 'utf8');

    const result = await ensureDefaultSkills({ homeDir });

    assert.deepEqual(result, {
      claudeLinkInstalled: false,
      commonSkillInstalled: false,
    });
    assert.equal(await readFile(join(commonSkillDir, 'SKILL.md'), 'utf8'), 'custom common skill\n');
    assert.equal(await readFile(join(claudeSkillDir, 'SKILL.md'), 'utf8'), 'custom claude skill\n');
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test('ensureDefaultSkills repairs a broken Claude Code find-skills symlink', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-default-skills-'));
  try {
    const claudeSkillsDir = join(homeDir, '.claude', 'skills');
    await mkdir(claudeSkillsDir, { recursive: true });
    await symlink('../missing/find-skills', join(claudeSkillsDir, 'find-skills'), 'dir');

    const result = await ensureDefaultSkills({ homeDir });

    assert.equal(result.claudeLinkInstalled, true);
    assert.equal(await readlink(join(claudeSkillsDir, 'find-skills')), '../../.agents/skills/find-skills');
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});
