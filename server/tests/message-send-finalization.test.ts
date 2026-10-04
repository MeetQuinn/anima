import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { ActivityService } from '../activities/activity.service.js';
import { MessageService } from '../messages/message.service.js';
import { MessageStore } from '../storage/schema/message.store.js';
import { ObservedConversationStore } from '../storage/schema/observed-conversation.store.js';
import { SubscriptionStore } from '../storage/schema/subscription.store.js';
import { runMessageSend } from '../tools/messages.js';
import { withToolActivity } from '../tools/tool-context.js';
import { withAnimaHome } from './anima-home.js';
import { slackPostBody, startSlackApiMock } from './helpers/slack-api.js';

const AGENT = 'scout';
const CHANNEL = 'C-product';
const TEAM = 'T-demo';
const TS = '1770000200.000123';
const FAULT = new Error('injected local bookkeeping fault');
type Fault = 'engagement' | 'subscription' | 'activity' | 'outbox' | 'journal';

// These tests use the real command, Slack SDK, and stores. All Slack I/O goes
// to a loopback server; prototype fault injection is serialized and restored.
describe('Slack accepted send finalization', { concurrency: 1 }, () => {
  for (const faults of [[], ['engagement'], ['subscription'], ['activity'], ['outbox'], ['journal'],
    ['engagement', 'subscription', 'activity']] as Fault[][]) {
    test(`accepted post survives ${faults.join(' + ') || 'normal bookkeeping'}`, async (t) => {
      await withSendFixture(t, { faults }, async (state) => {
        await runMessageSend({ agent: AGENT, channel: CHANNEL, text: 'accepted synthetic message' }, {
          writeOutput: (line) => { state.events.push('stdout'); state.lines.push(line); },
        });
        assert.equal(state.posts.length, 1, 'local failures must never retry chat.postMessage');
        assert.equal(state.lines.length, 1);
        assert.match(state.lines[0]!, /^sent successfully\./);
        assert.match(state.lines[0]!, new RegExp(`message_ts=${TS.replaceAll('.', '\\.')}`));
        assert.equal(state.events.at(-1), 'stdout', 'the receipt is printed after audit finalization');
        for (const fault of faults) assert.ok(state.injected.includes(fault), `${fault} seam was exercised`);
        for (const fault of faults.filter((fault) => fault !== 'journal')) {
          assert.match(state.lines[0]!, /Message was sent, but/);
          assert.match(state.lines[0]!, /Do not resend it/);
          assert.match(state.lines[0]!, new RegExp(fault === 'activity' ? 'completion audit' : fault));
        }
        assert.doesNotMatch(state.lines[0]!, /injected local bookkeeping fault/);
        const activities = await new ActivityService(AGENT).readAll();
        assert.equal(activities.filter((activity) => activity.type === 'external.effect.failed').length, 0);
        const completed = activities.find((activity) => activity.type === 'external.effect.completed');
        assert.equal(Boolean(completed), !faults.includes('activity'));
        if (completed) {
          assert.equal(completed.payload?.['ts'], TS);
          assert.equal(completed.payload?.['status'], 'sent');
          assert.equal(completed.payload?.['effect'], 'slack.message.send');
          if (faults.includes('engagement') || faults.includes('subscription')) {
            assert.match(JSON.stringify(completed.payload?.['warnings']), /Do not resend it/);
          }
        }
        const messages = await new MessageStore(AGENT).readAll();
        assert.equal(messages.filter((message) => message.messageTs === TS).length,
          faults.includes('activity') || faults.includes('outbox') ? 0 : 1);
        const journal = await new ObservedConversationStore(AGENT).readJournal(`slack:${TEAM}:${CHANNEL}`, { limit: 10 });
        assert.equal(journal.filter((message) => message.messageTs === TS).length, faults.includes('journal') ? 0 : 1);
        const subscriptions = await new SubscriptionStore(AGENT).list();
        assert.equal(subscriptions.some((subscription) => subscription.kind === 'thread' && subscription.threadTs === TS),
          !faults.includes('subscription'), 'subscription still runs when engagement fails');
      });
    });
  }

  test('thread subscription failure preserves the accepted reply and thread receipt', async (t) => {
    await withSendFixture(t, { faults: ['subscription'] }, async (state) => {
      await runMessageSend({ agent: AGENT, channel: CHANNEL, threadTs: '1770000100.000001', text: 'reply' }, {
        writeOutput: (line) => state.lines.push(line),
      });
      assert.equal(state.posts.length, 1);
      assert.equal(state.posts[0]?.['thread_ts'], '1770000100.000001');
      assert.match(state.lines[0]!, /thread_ts=1770000100\.000001, message_ts=1770000200\.000123/);
      assert.match(state.lines[0]!, /Do not resend it/);
      assert.equal((await new ActivityService(AGENT).readAll()).filter((a) => a.type === 'external.effect.failed').length, 0);
    });
  });

  test('the CLI exits zero with an accepted receipt when its completion audit fails', async (t) => {
    await withSendFixture(t, {}, async (state, stateDir) => {
      const loader = join(stateDir, 'fail-completion.mjs');
      await writeFile(loader, `import { ActivityService } from ${JSON.stringify(new URL('../activities/activity.service.js', import.meta.url).href)};
const record = ActivityService.prototype.record;
ActivityService.prototype.record = function(input) {
  if (input.type === 'external.effect.completed') throw new Error('injected completion audit fault');
  return record.call(this, input);
};\n`);
      const child = spawn(process.execPath, ['--import', loader, resolve('dist/server/cli/anima.js'),
        'message', 'send', '--channel', CHANNEL], {
        env: { ...process.env, ANIMA_HOME: stateDir, ANIMA_AGENT_ID: AGENT, ANIMA_INBOX_ITEM_ID: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end('synthetic CLI post');
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      const [code] = await once(child, 'close');
      assert.equal(code, 0, stderr || stdout);
      assert.equal(state.posts.length, 1);
      assert.match(stdout, /^sent successfully\./);
      assert.match(stdout, /message_ts=1770000200\.000123/);
      assert.match(stdout, /completion audit could not be saved\. Do not resend it/);
      assert.match(stderr, /injected completion audit fault/);
      assert.equal((await new ActivityService(AGENT).readAll()).filter((a) => a.type === 'external.effect.failed').length, 0);
      const journal = await new ObservedConversationStore(AGENT).readJournal(`slack:${TEAM}:${CHANNEL}`, { limit: 10 });
      assert.equal(journal.filter((message) => message.messageTs === TS).length, 1);
    });
  });

  test('Slack rejection still fails, records failure, and prints no sent receipt', async (t) => {
    await withSendFixture(t, { rejectPost: true }, async (state) => {
      await assert.rejects(runMessageSend({ agent: AGENT, channel: CHANNEL, text: 'rejected' }, {
        writeOutput: (line) => state.lines.push(line),
      }), /not_in_channel/);
      assert.equal(state.posts.length, 1);
      assert.deepEqual(state.lines, []);
      const activities = await new ActivityService(AGENT).readAll();
      assert.equal(activities.filter((a) => a.type === 'external.effect.failed').length, 1);
      assert.equal(activities.filter((a) => a.type === 'external.effect.completed').length, 0);
      assert.deepEqual(await new MessageStore(AGENT).readAll(), []);
      assert.deepEqual(await new ObservedConversationStore(AGENT).readJournal(`slack:${TEAM}:${CHANNEL}`, { limit: 10 }), []);
    });
  });

  test('started audit failure remains before Slack I/O', async (t) => {
    await withSendFixture(t, { failStarted: true }, async (state) => {
      await assert.rejects(runMessageSend({ agent: AGENT, channel: CHANNEL, text: 'never posted' }, {
        writeOutput: (line) => state.lines.push(line),
      }), /injected local bookkeeping fault/);
      assert.equal(state.posts.length, 0);
      assert.deepEqual(state.lines, []);
    });
  });

  test('other tools retain fatal completion audit semantics without opting in', async (t) => {
    await withSendFixture(t, { faults: ['activity'] }, async () => {
      await assert.rejects(withToolActivity({
        audit: { agentId: AGENT }, basePayload: { tool: 'other-tool' },
        op: async () => ({ result: 'done' }),
      }), /injected local bookkeeping fault/);
      const activities = await new ActivityService(AGENT).readAll();
      assert.equal(activities.filter((a) => a.type === 'tool.call.failed').length, 1);
    });
  });
});

async function withSendFixture(t: TestContext, options: {
  faults?: Fault[];
  failStarted?: boolean;
  rejectPost?: boolean;
}, body: (state: { events: string[]; injected: Fault[]; lines: string[]; posts: Record<string, unknown>[] }, stateDir: string) => Promise<void>): Promise<void> {
  const state = { events: [] as string[], injected: [] as Fault[], lines: [] as string[], posts: [] as Record<string, unknown>[] };
  const faults = options.faults ?? [];
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-send-finalization-'));
  const slackApi = await startSlackApiMock((method, requestBody) => {
    if (method === 'auth.test') return { ok: true, team_id: TEAM, user_id: 'U-scout' };
    if (method === 'users.list') return { ok: true, members: [] };
    if (method === 'users.conversations' || method === 'conversations.list') return { ok: true, channels: [] };
    if (method === 'conversations.info') return { ok: true, channel: { id: CHANNEL, is_channel: true, name: 'product' } };
    if (method === 'conversations.members') return { ok: true, members: ['U-scout'] };
    if (method !== 'chat.postMessage') throw new Error(`unexpected Slack method ${method}`);
    state.events.push('post');
    state.posts.push(slackPostBody(requestBody));
    return options.rejectPost ? { ok: false, error: 'not_in_channel' } : { ok: true, channel: CHANNEL, ts: TS };
  });
  const previousUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = slackApi.url;
  const originalRecord = ActivityService.prototype.record;
  t.mock.method(ActivityService.prototype, 'record', function (this: ActivityService, input: Parameters<typeof originalRecord>[0]) {
    state.events.push(input.type);
    if (options.failStarted && input.type === 'external.effect.started') throw FAULT;
    if (faults.includes('activity') && (input.type === 'external.effect.completed' || input.type === 'tool.call.completed')) {
      state.injected.push('activity');
      throw FAULT;
    }
    return originalRecord.call(this, input);
  });
  const originalFind = SubscriptionStore.prototype.find;
  t.mock.method(SubscriptionStore.prototype, 'find', function (this: SubscriptionStore, id: string) {
    const fault = id.endsWith(':channel') ? 'engagement' : id.includes(':thread:') ? 'subscription' : undefined;
    if (state.posts.length && fault && faults.includes(fault)) {
      state.injected.push(fault);
      throw FAULT;
    }
    return originalFind.call(this, id);
  });
  if (faults.includes('outbox')) t.mock.method(MessageService.prototype, 'recordOutboxActivity', () => {
    state.injected.push('outbox');
    throw FAULT;
  });
  if (faults.includes('journal')) t.mock.method(ObservedConversationStore.prototype, 'observe', () => {
    state.injected.push('journal');
    throw FAULT;
  });
  t.mock.method(console, 'warn', () => undefined);
  try {
    await withAnimaHome(stateDir, async () => {
      const agentDir = join(stateDir, 'agents', AGENT);
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(stateDir, 'config.json'), '{}\n');
      await writeFile(join(agentDir, 'config.json'), JSON.stringify({ id: AGENT,
        homePath: join(stateDir, 'home'), provider: { kind: 'codex-cli' },
        slack: { appToken: 'xapp-test', botToken: 'xoxb-test', botUserId: 'U-scout', teamId: TEAM },
      }));
      await body(state, stateDir);
    });
  } finally {
    t.mock.restoreAll();
    if (previousUrl === undefined) delete process.env.ANIMA_SLACK_API_URL;
    else process.env.ANIMA_SLACK_API_URL = previousUrl;
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
}
