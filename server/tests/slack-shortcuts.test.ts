import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebClient } from '@slack/web-api';

import { slackShortcutHandoffServiceForAgent } from '../inbox/slack-shortcut-handoff.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { SlackShortcutService, type ShortcutModalView } from '../slack-interactions/shortcut.service.js';
import {
  SLACK_SHORTCUTS,
  ensureSlackShortcutManifest,
  hasCommandsScope,
  inspectSlackShortcutManifest,
  parseOauthScopesHeader,
  slackShortcutManifestUpdateYaml,
} from '../slack/shortcuts.js';
import {
  ObservedConversationStore,
  surfaceIdForObservation,
} from '../storage/schema/observed-conversation.store.js';
import { withAnimaHome } from './anima-home.js';

test('shortcut manifest helper adds commands scope and required shortcuts idempotently', () => {
  const manifest = {
    display_information: { name: 'Iris' },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
      },
      shortcuts: [
        {
          callback_id: 'existing.action',
          description: 'Keep me',
          name: 'Existing',
          type: 'message',
        },
        {
          callback_id: 'anima.stop',
          description: 'Old stop shortcut',
          name: 'Stop current turn',
          type: 'global',
        },
        {
          callback_id: 'anima.status',
          description: 'Old status shortcut',
          name: 'Show status',
          type: 'global',
        },
        {
          callback_id: 'anima.toggle_enabled',
          description: 'Old enable shortcut',
          name: 'Disable or enable',
          type: 'global',
        },
        {
          callback_id: 'anima.reminders',
          description: 'Old reminders shortcut',
          name: 'Show reminders',
          type: 'global',
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: ['chat:write', 'users:read'],
      },
    },
  };

  assert.deepEqual(inspectSlackShortcutManifest(manifest), {
    commandsScope: false,
    missingRequiredBotScopes: ['commands', 'canvases:read', 'canvases:write', 'lists:read', 'lists:write'],
    missingShortcutCallbackIds: SLACK_SHORTCUTS.map((shortcut) => shortcut.callback_id),
    ready: false,
  });

  const first = ensureSlackShortcutManifest(manifest);
  assert.equal(first.updated, true);
  assert.deepEqual(first.status, {
    commandsScope: true,
    missingRequiredBotScopes: [],
    missingShortcutCallbackIds: [],
    ready: true,
  });
  const features = first.manifest.features as Record<string, unknown>;
  const shortcuts = features.shortcuts as Array<Record<string, unknown>>;
  assert.equal(shortcuts.length, 1 + SLACK_SHORTCUTS.length);
  assert.ok(shortcuts.some((shortcut) => shortcut.callback_id === 'existing.action'));
  assert.ok(shortcuts.some((shortcut) => shortcut.callback_id === 'anima.home' && shortcut.name === 'Home'));
  assert.ok(shortcuts.some((shortcut) => shortcut.callback_id === 'anima.hand_to_agent' && shortcut.type === 'message'));
  assert.equal(shortcuts.some((shortcut) => shortcut.callback_id === 'anima.reminders'), false);
  assert.equal(shortcuts.some((shortcut) => shortcut.callback_id === 'anima.status'), false);
  assert.equal(shortcuts.some((shortcut) => shortcut.callback_id === 'anima.stop'), false);
  assert.equal(shortcuts.some((shortcut) => shortcut.callback_id === 'anima.toggle_enabled'), false);

  const scopes = ((first.manifest.oauth_config as Record<string, unknown>).scopes as Record<string, unknown>).bot;
  assert.deepEqual(scopes, [
    'canvases:read',
    'canvases:write',
    'chat:write',
    'commands',
    'lists:read',
    'lists:write',
    'users:read',
  ]);

  const second = ensureSlackShortcutManifest(first.manifest);
  assert.equal(second.updated, false);
  assert.deepEqual(second.manifest, first.manifest);
});

test('shortcut manifest helper corrects wrong shortcut type without byte-equality matching', () => {
  const manifest = {
    features: {
      shortcuts: [
        {
          callback_id: 'anima.hand_to_agent',
          description: 'Wrong type',
          name: 'Hand to agent',
          type: 'global',
        },
      ],
    },
    oauth_config: { scopes: { bot: ['commands'] } },
  };

  const before = inspectSlackShortcutManifest(manifest);
  assert.equal(before.commandsScope, true);
  assert.deepEqual(before.missingRequiredBotScopes, ['canvases:read', 'canvases:write', 'lists:read', 'lists:write']);
  assert.ok(before.missingShortcutCallbackIds.includes('anima.hand_to_agent'));

  const updated = ensureSlackShortcutManifest(manifest);
  const shortcuts = (updated.manifest.features as Record<string, unknown>).shortcuts as Array<Record<string, unknown>>;
  assert.ok(shortcuts.some((shortcut) => shortcut.callback_id === 'anima.hand_to_agent' && shortcut.type === 'message'));
  assert.equal(updated.status.ready, true);
});

test('oauth scope header parser detects commands scope', () => {
  assert.deepEqual(parseOauthScopesHeader('chat:write, commands,users:read'), ['chat:write', 'commands', 'users:read']);
  assert.equal(hasCommandsScope(parseOauthScopesHeader('chat:write,users:read')), false);
  assert.equal(hasCommandsScope(parseOauthScopesHeader('chat:write,commands')), true);
});

test('shortcut manifest update YAML describes the manual migration block', () => {
  const yaml = slackShortcutManifestUpdateYaml();
  assert.match(yaml, /oauth_config:\n  scopes:\n    bot:\n      - commands/);
  assert.match(yaml, /- canvases:read/);
  assert.match(yaml, /- canvases:write/);
  assert.match(yaml, /- lists:read/);
  assert.match(yaml, /- lists:write/);
  assert.match(yaml, /callback_id: anima.home/);
  assert.match(yaml, /callback_id: anima.hand_to_agent/);
  assert.doesNotMatch(yaml, /callback_id: anima.reminders/);
  assert.doesNotMatch(yaml, /callback_id: anima.status/);
  assert.doesNotMatch(yaml, /callback_id: anima.stop/);
  assert.doesNotMatch(yaml, /callback_id: anima.toggle_enabled/);
});

test('home shortcut opens a read-only agent home without queueing agent work', async () => {
  const client = fakeWebClient();
  const activities: unknown[] = [];
  const service = new SlackShortcutService({
    activityRecorder: {
      record: async (_agentId: string, input: { payload?: Record<string, unknown>; type: string }) => {
        activities.push(input);
        return { activityId: 'actv_test', createdAt: '2026-05-26T12:00:00.000Z', ...input };
      },
    } as never,
    agentService: fakeAgentService({
      displayName: 'Scout',
      id: 'scout',
      owner: { displayName: 'Dana', handle: 'dana', slackUserId: 'U_OWNER' },
      role: 'Full-stack engineer',
    }),
    now: () => new Date('2026-05-26T12:10:00.000Z'),
    runtimeService: {
      getStatus: async () => ({
        agentId: 'scout',
        currentItemId: 'item-123',
        currentItemStartedAt: '2026-05-26T12:00:00.000Z',
        itemCount: 3,
        queueDepth: 2,
      }),
    },
  });

  await service.handleShortcut({
    agentId: 'scout',
    body: { callback_id: 'anima.home', trigger_id: 'trigger-1', user: { id: 'U1' } },
    client: client.client,
  });

  assert.equal(client.opened.length, 1);
  const modal = openedModal(client);
  assert.equal(modal.title.text, 'Scout');
  // Anyone in the workspace can open Home, so it must not offer Stop.
  assert.equal(modal.callback_id, undefined);
  assert.equal(modal.submit, undefined);
  assert.equal(modal.close?.text, 'Close');
  const text = modalText(modal);
  assert.match(text, /Full-stack engineer {2}· {2}Owner: <@U_OWNER>/);
  assert.match(text, /\*Working\* {2}· {2}10m {2}· {2}2 more waiting/);
  assert.doesNotMatch(text, /Reminders|Stop/);
  assert.deepEqual(activities, []);
});

test('home shortcut shows a bare Idle line for an idle agent without role or owner', async () => {
  const client = fakeWebClient();
  const service = new SlackShortcutService({
    agentService: fakeAgentService({ id: 'scout', displayName: 'Scout' }),
    runtimeService: {
      getStatus: async () => ({ agentId: 'scout', itemCount: 3, queueDepth: 0 }),
    },
  });

  await service.handleShortcut({
    agentId: 'scout',
    body: { callback_id: 'anima.home', trigger_id: 'trigger-1', user: { id: 'U1' } },
    client: client.client,
  });

  const modal = openedModal(client);
  assert.equal(modal.submit, undefined);
  assert.deepEqual(modal.blocks, [
    { type: 'section', text: { type: 'mrkdwn', text: ':white_check_mark:  *Idle*' } },
  ]);
});

test('home shortcut leads with a health problem instead of reading as Idle', async () => {
  const client = fakeWebClient();
  const service = new SlackShortcutService({
    agentService: fakeAgentService({ id: 'scout', displayName: 'Scout' }),
    now: () => new Date('2026-05-26T12:10:00.000Z'),
    runtimeService: {
      getStatus: async () => ({
        agentId: 'scout',
        // A leftover rate-limit deferral must not turn into a resume promise
        // while the sign-in itself is broken.
        deferredWakes: [{ id: 'w1', kind: 'slack', notBefore: '2026-05-26T12:40:00.000Z', retryable: true }],
        health: { reason: 'provider_auth_failed', state: 'unhealthy', updatedAt: '2026-05-26T12:09:00.000Z' },
        itemCount: 1,
        queueDepth: 1,
      }),
    },
  });

  await service.handleShortcut({
    agentId: 'scout',
    body: { callback_id: 'anima.home', trigger_id: 'trigger-1', user: { id: 'U1' } },
    client: client.client,
  });

  const text = modalText(openedModal(client));
  assert.match(text, /^:warning: {2}\*Needs attention\* {2}· {2}1 waiting\nIt can't reach its model\. Its owner needs to check the model sign-in\.$/);
  assert.doesNotMatch(text, /Idle|Picks back up/);
});

test('home shortcut does not show green Idle when health is explicitly unknown', async () => {
  const client = fakeWebClient();
  const service = new SlackShortcutService({
    agentService: fakeAgentService({ id: 'scout', displayName: 'Scout' }),
    runtimeService: {
      getStatus: async () => ({
        agentId: 'scout',
        health: { state: 'unknown', updatedAt: '2026-05-26T12:09:00.000Z' },
        itemCount: 0,
        queueDepth: 0,
      }),
    },
  });

  await service.handleShortcut({
    agentId: 'scout',
    body: { callback_id: 'anima.home', trigger_id: 'trigger-1', user: { id: 'U1' } },
    client: client.client,
  });

  const text = modalText(openedModal(client));
  assert.equal(text, ":grey_question:  *Status unknown*\nAnima can't confirm right now whether it's able to work.");
  assert.doesNotMatch(text, /Idle|white_check_mark/);
});

test('home shortcut says when rate-limited work picks back up, in the viewer time zone', async () => {
  const client = fakeWebClient();
  const service = new SlackShortcutService({
    agentService: fakeAgentService({ id: 'scout', displayName: 'Scout' }),
    now: () => new Date('2026-05-26T12:10:00.000Z'),
    runtimeService: {
      getStatus: async () => ({
        agentId: 'scout',
        deferredWakes: [
          { id: 'w-past', kind: 'slack', notBefore: '2026-05-26T12:05:00.000Z', retryable: true },
          { id: 'w-late', kind: 'slack', notBefore: '2026-05-26T13:00:00.000Z', retryable: true },
          { id: 'w-next', kind: 'reminder', notBefore: '2026-05-26T12:40:00.000Z', retryable: false },
        ],
        itemCount: 3,
        queueDepth: 3,
      }),
    },
  });

  await service.handleShortcut({
    agentId: 'scout',
    body: { callback_id: 'anima.home', trigger_id: 'trigger-1', user: { id: 'U1' } },
    client: client.client,
  });

  const nextSeconds = Date.parse('2026-05-26T12:40:00.000Z') / 1000;
  assert.equal(
    modalText(openedModal(client)),
    `:double_vertical_bar:  *Rate-limited*  ·  3 waiting\n`
      + `Picks back up <!date^${nextSeconds}^{date_short_pretty} at {time}|2026-05-26 12:40 UTC>.`,
  );
});

test('home shortcut keeps a long agent name inside the Slack title limit', async () => {
  const client = fakeWebClient();
  const service = new SlackShortcutService({
    agentService: fakeAgentService({ id: 'scout', displayName: 'Scout the Extremely Thorough Reviewer' }),
    runtimeService: {
      getStatus: async () => ({ agentId: 'scout', itemCount: 0, queueDepth: 0 }),
    },
  });

  await service.handleShortcut({
    agentId: 'scout',
    body: { callback_id: 'anima.home', trigger_id: 'trigger-1', user: { id: 'U1' } },
    client: client.client,
  });

  const title = openedModal(client).title.text;
  assert.equal(Array.from(title).length, 24);
  assert.equal(title, 'Scout the Extremely Tho…');
});

test('message shortcut hands the source message to the agent thread and responds ephemerally', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-shortcuts-'));
  await writeMinimalAgentConfig(stateDir, 'scout');
  const fetchCalls: Array<{ body: unknown; url: string }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ body: init?.body, url: String(url) });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    await withAnimaHome(stateDir, async () => {
      const service = new SlackShortcutService({
        activityRecorder: {
          record: async (_agentId: string, input: { payload?: Record<string, unknown>; type: string }) => (
            { activityId: 'actv_test', createdAt: '2026-05-26T12:00:00.000Z', ...input }
          ),
        } as never,
        handoffService: slackShortcutHandoffServiceForAgent('scout'),
      });
      await service.handMessageToAgent({
        agentId: 'scout',
        body: {
          callback_id: 'anima.hand_to_agent',
          channel: { id: 'C1', name: 'course-team' },
          message: { text: 'Please turn this into a task.', ts: '1779790000.123456', user: 'U_SOURCE' },
          response_url: 'https://hooks.slack.test/shortcut-response',
          team: { id: 'T1' },
          user: { id: 'U_HANDOFF' },
        },
      });

      const item = await new WakeQueueService('scout').find('slack-shortcut-handoff:T1:C1:1779790000.123456');
      assert.ok(item);
      assert.equal(item.kind, 'slack');
      assert.equal(item.channelId, 'C1');
      assert.equal(item.threadTs, '1779790000.123456');
      assert.equal(item.messageTs, '1779790000.123456');
      assert.equal(item.actor?.userId, 'U_SOURCE');
      assert.match(item.text, /<@U_HANDOFF> used the Slack message shortcut/);
      assert.match(item.text, /Please turn this into a task\./);

      // Producer journals before enqueue (cursor-delivery trigger observation).
      const store = new ObservedConversationStore('scout');
      const surfaceId = surfaceIdForObservation({
        channelId: 'C1',
        messageTs: '1779790000.123456',
        teamId: 'T1',
        threadTs: '1779790000.123456',
      });
      const rows = await store.readJournal(surfaceId, { limit: 10 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.userId, 'U_SOURCE');
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]?.url, 'https://hooks.slack.test/shortcut-response');
  assert.match(String(fetchCalls[0]?.body), /Handed to the agent/);
});

test('message shortcut without message.user falls back to invoker actor and still journals', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-shortcuts-actorless-'));
  await writeMinimalAgentConfig(stateDir, 'scout');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  try {
    await withAnimaHome(stateDir, async () => {
      const service = new SlackShortcutService({
        activityRecorder: {
          record: async (_agentId: string, input: { payload?: Record<string, unknown>; type: string }) => (
            { activityId: 'actv_test', createdAt: '2026-05-26T12:00:00.000Z', ...input }
          ),
        } as never,
        handoffService: slackShortcutHandoffServiceForAgent('scout'),
      });
      await service.handMessageToAgent({
        agentId: 'scout',
        body: {
          callback_id: 'anima.hand_to_agent',
          channel: { id: 'C1', name: 'course-team' },
          // Legal: source message omits user.
          message: { text: 'No author field', ts: '1779790003.000000' },
          response_url: 'https://hooks.slack.test/shortcut-response',
          team: { id: 'T1' },
          user: { id: 'U_HANDOFF' },
        },
      });

      const item = await new WakeQueueService('scout').find('slack-shortcut-handoff:T1:C1:1779790003.000000');
      assert.ok(item);
      assert.equal(item.kind, 'slack');
      if (item.kind !== 'slack') return;
      assert.equal(item.actor?.userId, 'U_HANDOFF');
      const store = new ObservedConversationStore('scout');
      const surfaceId = surfaceIdForObservation({
        channelId: 'C1',
        messageTs: '1779790003.000000',
        teamId: 'T1',
        threadTs: '1779790003.000000',
      });
      const rows = await store.readJournal(surfaceId, { limit: 10 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.userId, 'U_HANDOFF');
    });
  } finally {
    globalThis.fetch = previousFetch;
    await rm(stateDir, { force: true, recursive: true });
  }
});

function fakeWebClient(): { client: WebClient; opened: unknown[] } {
  const opened: unknown[] = [];
  return {
    client: {
      views: {
        open: async (input: unknown) => {
          opened.push(input);
          return { ok: true };
        },
      },
    } as unknown as WebClient,
    opened,
  };
}

function openedModal(client: { opened: unknown[] }): ShortcutModalView {
  const modal = (client.opened[0] as { view: ShortcutModalView } | undefined)?.view;
  assert.ok(modal);
  return modal;
}

function modalText(modal: ShortcutModalView): string {
  return modal.blocks
    .map((block) => {
      if (block.type === 'section') return block.text.text;
      if (block.type === 'context') return block.elements.map((element) => element.text).join(' ');
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function fakeAgentService(input: {
  displayName: string;
  id: string;
  owner?: { displayName: string; handle?: string; slackUserId: string };
  role?: string;
}) {
  return {
    serviceFor: () => ({
      getConfig: async () => ({
        enabled: true,
        id: input.id,
        ...(input.owner ? { owner: input.owner } : {}),
        profile: { displayName: input.displayName, role: input.role ?? '' },
        provider: { kind: 'claude-code', model: 'sonnet' },
        slack: { appToken: 'xapp-test', botToken: 'xoxb-test', connected: true, teamId: 'T1' },
        homePath: `/tmp/${input.id}`,
      }),
    }),
  } as never;
}

async function writeMinimalAgentConfig(stateDir: string, agentId: string): Promise<void> {
  await mkdir(join(stateDir, 'agents', agentId), { recursive: true });
  await writeFile(join(stateDir, 'config.json'), '{}\n', 'utf8');
  await writeFile(join(stateDir, 'agents', agentId, 'config.json'), JSON.stringify({
    id: agentId,
    profile: { displayName: 'Scout', role: '' },
    provider: { kind: 'claude-code', model: 'sonnet' },
    slack: { appToken: 'xapp-test', botToken: 'xoxb-test', teamId: 'T1' },
  }, null, 2), 'utf8');
}
