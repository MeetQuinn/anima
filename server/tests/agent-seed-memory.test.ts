import test from 'node:test';
import assert from 'node:assert/strict';

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
