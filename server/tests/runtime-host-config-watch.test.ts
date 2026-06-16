import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { invalidateConfigCacheForWatchEvent } from '../runtime/host.js';
import { cacheSet, JsonFile, statOrNull } from '../storage/json-file.js';

test('runtime host config watch event invalidates changed agent config cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-config-watch-'));
  const agentDir = join(dir, 'agents', 'scout');
  const configPath = join(agentDir, 'config.json');
  await mkdir(agentDir, { recursive: true });
  await writeFile(configPath, '{"value":"fresh"}\n', 'utf8');

  const fileStat = await statOrNull(configPath);
  assert.ok(fileStat);
  cacheSet(configPath, { value: 'stale' }, fileStat);

  const file = new JsonFile<{ value: string }>(configPath, () => ({ value: 'empty' }));
  assert.deepEqual(await file.read(), { value: 'stale' });

  assert.equal(invalidateConfigCacheForWatchEvent('agent:scout', agentDir, 'notes.md'), false);
  assert.deepEqual(await file.read(), { value: 'stale' });

  assert.equal(invalidateConfigCacheForWatchEvent('agent:scout', agentDir, Buffer.from('config.json')), true);
  assert.deepEqual(await file.read(), { value: 'fresh' });
});

test('runtime host root agents watch events schedule reconcile without config cache invalidation', () => {
  assert.equal(invalidateConfigCacheForWatchEvent('agents', '/tmp/anima/agents', 'scout'), true);
});
