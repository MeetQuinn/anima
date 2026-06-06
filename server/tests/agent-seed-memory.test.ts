import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_FEATURE_REFERENCE_FILE, renderAgentFeatureReference, writeAgentFeatureReference } from '../agents/feature-reference.js';
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

test('agent feature reference renders the env how-to', async () => {
  const body = await renderAgentFeatureReference();

  assert.match(body, /^# Anima feature reference/m);
  assert.match(body, /anima env set SERVICE_REGION us-west-2/);
  assert.ok(body.includes('printf \'%s\' "$THE_SECRET_VALUE" | anima env set OPENAI_API_KEY --secret'));
  assert.match(body, /anima env run --keys OPENAI_API_KEY -- some-tool --do-the-thing/);
  assert.match(body, /anima env list/);
  assert.match(body, /Nothing is auto-injected into your shell/);
  assert.match(body, /managed\s+runtime and provider credentials are not forwarded automatically/);
  assert.doesNotMatch(body, /env source --secrets/);
});

test('agent feature reference materializes at the agent home root', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'anima-agent-feature-reference-test-'));
  try {
    await writeAgentFeatureReference({ homePath });

    const body = await readFile(join(homePath, AGENT_FEATURE_REFERENCE_FILE), 'utf8');
    assert.match(body, /^# Anima feature reference/m);
    assert.match(body, /anima env run --keys OPENAI_API_KEY -- some-tool --do-the-thing/);
  } finally {
    await rm(homePath, { force: true, recursive: true });
  }
});
