import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { WebClient } from '@slack/web-api';

import { observedNameReader } from '../runtime/observed-readable-names.js';
import type { SlackProfileResolver, SlackUserProfile } from '../slack/profiles.js';
import { getSlackWorkspaceDirectoryStore } from '../storage/schema/cache.js';
import type { ObservedConversationEntry } from '../storage/schema/observed-conversation.store.js';
import { withAnimaHome } from './anima-home.js';

const client = (): WebClient => ({}) as WebClient;

function fakeProfiles(input: {
  channels?: Record<string, string>;
  hang?: boolean;
  users?: Record<string, SlackUserProfile>;
}): SlackProfileResolver & { userLookups: string[] } {
  const userLookups: string[] = [];
  return {
    userLookups,
    async user({ userId }: { userId: string }) {
      userLookups.push(userId);
      if (input.hang) return new Promise<undefined>(() => {});
      return input.users?.[userId];
    },
    async conversation({ channelId }: { channelId: string }) {
      const name = input.channels?.[channelId];
      return name ? { name } : {};
    },
    async displayText(): Promise<string> {
      throw new Error('not used by the reader');
    },
  } as unknown as SlackProfileResolver & { userLookups: string[] };
}

function row(partial: Partial<ObservedConversationEntry> & { messageTs: string; text: string }): ObservedConversationEntry {
  return {
    channelId: 'C1',
    eventId: `slack:T1:C1:${partial.messageTs}`,
    observedAt: '2026-11-08T00:00:00.000Z',
    ordinal: 1,
    receivedAt: '2026-11-08T00:00:00.000Z',
    surfaceId: 'slack:T1:C1',
    teamId: 'T1',
    ...partial,
  };
}

test('rows read like the wake trigger: named sender, readable mentions, decoded entities', async () => {
  const profiles = fakeProfiles({
    channels: { C9: 'team' },
    users: {
      U1: { displayName: 'Totoday Qiang', handle: 'totodayqiang' },
      U2: { displayName: 'nora', handle: 'nora' },
    },
  });
  const read = observedNameReader({ client, profiles, teamId: 'T1' });

  const [first, second] = await read([
    row({ messageTs: '1.0', text: 'hi <@U2>, see <#C9> &amp; ask', userId: 'U1' }),
    row({ messageTs: '2.0', text: 'thanks <@U1>', userId: 'U2' }),
  ]);

  assert.equal(first?.senderLabel, 'Totoday Qiang (@totodayqiang)');
  assert.equal(first?.text, 'hi @nora, see #team & ask');
  assert.equal(second?.senderLabel, '@nora', 'a name equal to the handle collapses, as on the trigger line');
  assert.equal(second?.text, 'thanks @totodayqiang');
  assert.deepEqual([...profiles.userLookups].sort(), ['U1', 'U2'], 'each user is looked up once');
});

test('an unresolved sender keeps its id and a bot-only row is untouched', async () => {
  const read = observedNameReader({ client, profiles: fakeProfiles({}), teamId: 'T1' });

  const [human, bot] = await read([
    row({ messageTs: '1.0', text: 'ping <@U7>', userId: 'U7' }),
    row({ botId: 'B1', messageTs: '2.0', text: 'deploy done' }),
  ]);

  assert.equal(human?.senderLabel, undefined);
  assert.equal(human?.text, 'ping @U7');
  assert.equal(bot?.senderLabel, undefined);
  assert.equal(bot?.text, 'deploy done');
});

test('a lookup past the deadline is cancelled and leaves rows as journaled', async () => {
  let signal: AbortSignal | undefined;
  const read = observedNameReader({
    client: (lookupSignal) => {
      signal = lookupSignal;
      return {} as WebClient;
    },
    profiles: fakeProfiles({ hang: true }),
    teamId: 'T1',
    timeoutMs: 20,
  });
  const rows = [row({ messageTs: '1.0', text: 'hi <@U2>', userId: 'U1' })];

  assert.deepEqual(await read(rows), rows);
  assert.equal(signal?.aborted, true, 'the lookups still in flight are aborted');
});

// More stale users than the SDK's 100 concurrent requests, so refreshes are
// both in flight and queued when the reader answers from the cache.
const STALE_USERS = 201;
const DEADLINE_MS = 300;

// Runs in its own process, like `anima message send`: read the rows, print
// what came back, and fall off the end. The process exits only once no
// request is left open.
const CHILD = `
const { observedNameReader } = await import(process.env.READER_MODULE);
const { createSlackDeadlineWebClient } = await import(process.env.CLIENT_MODULE);
const rows = Array.from({ length: Number(process.env.STALE_USERS) }, (_, i) => ({
  channelId: 'C1', eventId: 'slack:T1:C1:' + i + '.0', messageTs: i + '.0', observedAt: 'x', ordinal: i + 1,
  receivedAt: 'x', surfaceId: 'slack:T1:C1', teamId: 'T1', text: 'hi', userId: 'U' + i,
}));
const read = observedNameReader({
  client: (signal, requestTimeoutMs) => createSlackDeadlineWebClient('test-only-token', signal, requestTimeoutMs),
  teamId: 'T1',
  timeoutMs: Number(process.env.DEADLINE_MS),
});
const start = performance.now();
const shown = await read(rows);
console.log(JSON.stringify({ ms: performance.now() - start, named: shown.filter((row) => row.senderLabel).length }));
`;

test('stale-cache refreshes stop at the deadline: queued ones are never sent and the process exits', async () => {
  let requests = 0;
  const open = new Set<unknown>();
  const server = createServer((_request, response) => {
    requests += 1;
    open.add(response);
    response.on('close', () => open.delete(response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-readable-names-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await getSlackWorkspaceDirectoryStore('T1').update((cache) => ({
        ...cache,
        teamId: 'T1',
        users: Array.from({ length: STALE_USERS }, (_, i) => ({
          displayName: `Person ${i}`,
          id: `U${i}`,
          name: `person${i}`,
          syncedAt: '2000-01-01T00:00:00.000Z',
        })),
      }));
    });

    const started = performance.now();
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
      env: {
        ...process.env,
        ANIMA_HOME: stateDir,
        ANIMA_SLACK_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`,
        CLIENT_MODULE: new URL('../slack/client.js', import.meta.url).href,
        DEADLINE_MS: String(DEADLINE_MS),
        READER_MODULE: new URL('../runtime/observed-readable-names.js', import.meta.url).href,
        STALE_USERS: String(STALE_USERS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      const kill = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`reader process did not exit; requests=${requests} open=${open.size}`));
      }, 5_000);
      child.on('exit', (exitCode) => {
        clearTimeout(kill);
        resolve(exitCode);
      });
    });
    const exitedAfterMs = performance.now() - started;

    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout.trim()) as { ms: number; named: number };
    assert.ok(result.ms < DEADLINE_MS, `answered from the cache before the deadline (${Math.round(result.ms)}ms)`);
    assert.equal(result.named, STALE_USERS, 'stale names are still shown');
    assert.ok(requests > 0, 'the stale entries were being refreshed');
    assert.ok(requests <= 100, `queued refreshes were never sent (${requests} requests)`);
    assert.ok(exitedAfterMs < 3_000, `the process exits soon after the deadline (${Math.round(exitedAfterMs)}ms)`);

    const sentAtExit = requests;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(requests, sentAtExit, 'nothing is sent after the process is gone');
    assert.equal(open.size, 0, 'no request is left open');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { force: true, recursive: true });
  }
});
