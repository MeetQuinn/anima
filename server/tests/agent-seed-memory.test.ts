import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { renderSeedMemory } from '../agents/seed-memory.js';

test('seed memory render uses bundled template and only substitutes display name', async () => {
  const body = await renderSeedMemory({
    id: 'ada',
    profile: {
      displayName: 'Ada Lovelace',
      role: 'Should not be rendered.',
    },
  });

  assert.match(body, /^# Ada Lovelace/m);
  assert.doesNotMatch(body, /Should not be rendered/);
  assert.doesNotMatch(body, /{{displayName}}/);
  assert.match(body, /parent and ancestor directories/);
});

test('bundled agent feature reference documents the env how-to', async () => {
  const body = await readFile(join(process.cwd(), 'docs', 'guide', 'agent-features.md'), 'utf8');

  assert.match(body, /^# Agent feature reference/m);
  assert.match(body, /anima env set SERVICE_REGION us-west-2/);
  assert.ok(body.includes('printf \'%s\' "$THE_SECRET_VALUE" | anima env set OPENAI_API_KEY --secret'));
  assert.match(body, /anima env run --keys OPENAI_API_KEY -- some-tool --do-the-thing/);
  assert.match(body, /anima env list/);
  assert.match(body, /Nothing is auto-injected into your shell/);
  assert.match(body, /managed\s+runtime and provider credentials are not forwarded automatically/);
  assert.doesNotMatch(body, /env source --secrets/);
});
