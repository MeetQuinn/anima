import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebClient } from '@slack/web-api';

import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { SlackShortcutService, type ShortcutModalView } from '../slack/shortcut.service.js';
import {
  SLACK_SHORTCUTS,
  SLACK_STOP_CONFIRM_VIEW_CALLBACK_ID,
  ensureSlackShortcutManifest,
  hasCommandsScope,
  inspectSlackShortcutManifest,
  parseOauthScopesHeader,
  slackShortcutManifestUpdateYaml,
} from '../slack/shortcuts.js';
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
    missingShortcutCallbackIds: SLACK_SHORTCUTS.map((shortcut) => shortcut.callback_id),
    ready: false,
  });

  const first = ensureSlackShortcutManifest(manifest);
  assert.equal(first.updated, true);
  assert.deepEqual(first.status, {
    commandsScope: true,
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
  assert.deepEqual(scopes, ['chat:write', 'commands', 'users:read']);

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
  assert.match(yaml, /callback_id: anima.home/);
  assert.match(yaml, /callback_id: anima.hand_to_agent/);
  assert.doesNotMatch(yaml, /callback_id: anima.reminders/);
  assert.doesNotMatch(yaml, /callback_id: anima.status/);
  assert.doesNotMatch(yaml, /callback_id: anima.stop/);
  assert.doesNotMatch(yaml, /callback_id: anima.toggle_enabled/);
});

test('home shortcut opens the agent home modal without queueing agent work', async () => {
  const client = fakeWebClient();
  const activities: Array<{ agentId: string; input: { payload?: Record<string, unknown>; type: string } }> = [];
  const stopped: string[] = [];
  const service = new SlackShortcutService({
    activityRecorder: {
      record: async (agentId: string, input: { payload?: Record<string, unknown>; type: string }) => {
        activities.push({ agentId, input });
        return { activityId: 'actv_test', createdAt: '2026-05-26T12:00:00.000Z', ...input };
      },
    } as never,
    agentService: fakeAgentService({ id: 'scout', displayName: 'Scout' }),
    now: () => new Date('2026-05-26T12:10:00.000Z'),
    reminderServiceForAgent: fakeReminderService([
      {
        nextDueAt: '2026-05-26T13:00:00.000Z',
        reminderId: 'reminder-1',
        title: 'Check build',
      },
    ]),
    runtimeService: {
      getStatus: async () => ({
        agentId: 'scout',
        currentItemId: 'item-123',
        currentItemStartedAt: '2026-05-26T12:00:00.000Z',
        itemCount: 3,
        queueDepth: 2,
      }),
      stopCurrentItem: async (agentId: string) => {
        stopped.push(agentId);
      },
    },
  });

  await service.handleShortcut({
    agentId: 'scout',
    body: { callback_id: 'anima.home', trigger_id: 'trigger-1', user: { id: 'U1' } },
    client: client.client,
  });

  assert.equal(client.opened.length, 1);
  const modal = (client.opened[0] as { view: ShortcutModalView } | undefined)?.view;
  assert.ok(modal);
  assert.equal(modal.title.text, 'Home');
  assert.equal(modal.callback_id, SLACK_STOP_CONFIRM_VIEW_CALLBACK_ID);
  assert.equal(modal.submit?.text, 'Stop');
  const modalText = modal.blocks.map((block) => 'text' in block ? block.text.text : '').join('\n');
  assert.match(modalText, /\*Scout\*/);
  assert.match(modalText, /\*Working\*/);
  assert.match(modalText, /10m/);
  assert.match(modalText, /Reminders/);
  assert.match(modalText, /Check build/);

  const resultView = await service.confirmStop({
    agentId: 'scout',
    userId: 'U1',
    view: { private_metadata: modal.private_metadata },
  });
  assert.deepEqual(stopped, ['scout']);
  assert.equal(resultView.title.text, 'Stop requested');
  assert.deepEqual(activities.map((activity) => activity.input), [
    {
      payload: { itemId: 'item-123', outcome: 'stop_requested', userId: 'U1' },
      type: 'anima.shortcut.stop',
    },
  ]);
});

test('home shortcut omits Stop when the agent is idle', async () => {
  const client = fakeWebClient();
  const service = new SlackShortcutService({
    agentService: fakeAgentService({ id: 'scout', displayName: 'Scout' }),
    reminderServiceForAgent: fakeReminderService([]),
    runtimeService: {
      getStatus: async () => ({
        agentId: 'scout',
        itemCount: 3,
        queueDepth: 0,
      }),
      stopCurrentItem: async () => undefined,
    },
  });

  await service.handleShortcut({
    agentId: 'scout',
    body: { callback_id: 'anima.home', trigger_id: 'trigger-1', user: { id: 'U1' } },
    client: client.client,
  });

  const modal = (client.opened[0] as { view: ShortcutModalView } | undefined)?.view;
  assert.ok(modal);
  assert.equal(modal.title.text, 'Home');
  assert.equal(modal.callback_id, undefined);
  assert.equal(modal.submit, undefined);
  const modalText = modal.blocks.map((block) => 'text' in block ? block.text.text : '').join('\n');
  assert.match(modalText, /\*Scout\*/);
  assert.match(modalText, /\*Idle\*/);
  assert.match(modalText, /None scheduled/);
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
      assert.match(item.text, /<@U_HANDOFF> used the Slack message shortcut/);
      assert.match(item.text, /Please turn this into a task\./);
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]?.url, 'https://hooks.slack.test/shortcut-response');
  assert.match(String(fetchCalls[0]?.body), /Handed to the agent/);
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

function fakeAgentService(input: { displayName: string; id: string }) {
  return {
    serviceFor: () => ({
      getConfig: async () => ({
        enabled: true,
        id: input.id,
        profile: { displayName: input.displayName, role: '' },
        provider: { kind: 'claude-code', model: 'sonnet' },
        slack: { appToken: 'xapp-test', botToken: 'xoxb-test', connected: true, teamId: 'T1' },
        homePath: `/tmp/${input.id}`,
      }),
    }),
  } as never;
}

function fakeReminderService(
  reminders: Array<{ nextDueAt?: string; reminderId: string; title: string }>,
) {
  return () => ({
    listReminders: async () => reminders.map((reminder) => ({
      createdAt: '2026-05-26T12:00:00.000Z',
      firedCount: 0,
      instructions: '',
      schedule: { kind: 'once' },
      status: 'scheduled',
      updatedAt: '2026-05-26T12:00:00.000Z',
      ...reminder,
    })),
  }) as never;
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
