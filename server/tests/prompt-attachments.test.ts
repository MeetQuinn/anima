import test from 'node:test';
import assert from 'node:assert/strict';

import { makeReminderInboxItem } from './helpers/inbox.js';
import type { InboxItem } from '../inbox/wake-queue.service.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { runtimeEnv } from '../runtime/runtime-bridge.js';
import { buildAnimaRuntimeProfile } from '../runtime/standing-prompt.js';
import { makeSlackEvent } from './helpers/slack.js';
import type { SlackFile } from '../inbox/slack-events.js';
import type { Session } from '../storage/schema/session.store.js';

function buildInput(opts: {
  channelId?: string;
  channelName?: string;
  files?: SlackFile[];
  threadTs?: string;
}) {
  const event = makeSlackEvent({
    channelId: opts.channelId ?? 'D-user',
    ...(opts.channelName ? { channelName: opts.channelName } : {}),
    teamId: 'T-demo',
    text: 'check this out',
    ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
    ts: '1770000010.000001',
    userId: 'U1',
    ...(opts.files ? { files: opts.files } : {}),
  });
  return { event, context: buildContext(event) };
}

function buildContext(event: InboxItem) {
  const item: InboxItem = {
    ...event,
    handling: {
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  const session: Session = {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    agentId: 'anima',
    item,
    session,
    stateDir: '/tmp',
    homePath: '/tmp/agents/anima',
  };
}

test('buildCodeAgentDeliveryPrompt includes the Slack message envelope for threads', () => {
  const text = buildCodeAgentDeliveryPrompt(
    buildInput({
      channelId: 'C-team',
      channelName: 'team',
      threadTs: '1770000020.000001',
    }).event,
  );

  assert.match(text, /New Slack message:/);
  assert.match(text, /\[channel=#team channel_id=C-team thread_ts=1770000020\.000001 message_ts=1770000010\.000001 time=[^ \]]+ user_id=U1\]/);
  assert.doesNotMatch(text, /Reply command/);
});

test('buildCodeAgentDeliveryPrompt renders restart resumes as a short system continuation', () => {
  const event = makeSlackEvent({
    channelId: 'D-user',
    eventId: 'evt-restart-resume-prompt',
    handling: {
      createdAt: '2026-01-01T00:00:00.000Z',
      resumeReason: 'runtime_restart',
      status: 'queued',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    teamId: 'T-demo',
    text: 'do the expensive thing',
    ts: '1770000010.000001',
    userId: 'U1',
  });

  const text = buildCodeAgentDeliveryPrompt(event);

  assert.equal(text, [
    'Anima system message: runtime restarted while this task was in progress.',
    'Continue the same task from the current session; do not repeat completed external side effects.',
  ].join('\n'));
  assert.doesNotMatch(text, /New Slack message/);
  assert.doesNotMatch(text, /do the expensive thing/);
});

test('buildCodeAgentDeliveryPrompt omits channel_id for DMs (channel= already shows the raw id) and still emits user_id', () => {
  const text = buildCodeAgentDeliveryPrompt(buildInput({ channelId: 'D-user' }).event);
  assert.match(text, /\[channel=D-user message_ts=1770000010\.000001 time=[^ \]]+ user_id=U1\]/);
  assert.doesNotMatch(text, /channel_id=/);
});

test('buildCodeAgentDeliveryPrompt includes triggering user local time when timezone is known', () => {
  const event = makeSlackEvent({
    channelId: 'D-user',
    teamId: 'T-demo',
    text: 'good morning',
    timestamp: '2026-05-19T23:59:30.000Z',
    ts: '1779235170.792609',
    userId: 'U1',
  });
  event.actor = {
    ...event.actor,
    timezone: {
    label: 'China Standard Time',
    name: 'Asia/Shanghai',
    offsetSeconds: 28800,
    },
  };

  const text = buildCodeAgentDeliveryPrompt(event);

  assert.match(text, /user_local_time=2026-05-20T07:59:30\+08:00 user_tz=Asia\/Shanghai/);
});

test('buildCodeAgentDeliveryPrompt renders scheduled reminders as the current event', () => {
  const event = makeReminderInboxItem({
      reminderId: 'reminder-test',
      timestamp: '2026-05-18T17:00:00.000Z',
  });
  const text = buildCodeAgentDeliveryPrompt(event, {
    reminder: {
      createdAt: '2026-05-18T16:00:00.000Z',
      firedCount: 0,
      instructions: 'Check whether the deploy finished.',
      reminderId: 'reminder-test',
      schedule: { kind: 'once' },
      status: 'scheduled',
      title: 'Follow up on deploy',
      updatedAt: '2026-05-18T16:00:00.000Z',
    },
  });

  assert.match(text, /^Scheduled reminder:\n\n\[reminder_id=reminder-test time=2026-05-18T17:00:00\.000Z\] Scheduled wake: Follow up on deploy/);
  assert.match(text, /Instructions:\nCheck whether the deploy finished\./);
  assert.doesNotMatch(text, /Reply command|Recovery context/);
});

test('buildCodeAgentDeliveryPrompt renders onboarding as an onboarding wake, not a Slack DM', () => {
  const text = buildCodeAgentDeliveryPrompt({
    channelId: 'D-operator',
    handling: {
      createdAt: '2026-01-01T00:00:00.000Z',
      queuedAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    id: 'agent-onboarding:anima:U-operator',
    kind: 'onboarding',
    operator: {
      displayName: 'Iris',
      handle: 'iris',
      slackUserId: 'U-operator',
    },
    receivedAt: '2026-01-01T00:00:00.000Z',
    teamId: 'T-demo',
    text: 'Iris (<@U-operator>) just set you up here.',
  });

  assert.match(text, /^Agent onboarding:/);
  assert.match(text, /\[operator=Iris \(@iris, <@U-operator>\) channel=D-operator time=2026-01-01T00:00:00\.000Z\]/);
  assert.match(text, /Use `anima message send --channel D-operator` to reply to Iris/);
  assert.doesNotMatch(text, /^New Slack message:/);
});

test('buildCodeAgentDeliveryPrompt treats legacy Slack-shaped onboarding as onboarding', () => {
  const event = makeSlackEvent({
    channelId: 'D-operator',
    eventId: 'agent-onboarding:anima:U-operator',
    teamId: 'T-demo',
    text: 'Iris (<@U-operator>) just set you up here.',
    userId: 'U-operator',
  });
  const text = buildCodeAgentDeliveryPrompt(event);

  assert.match(text, /^Agent onboarding:/);
  assert.match(text, /\[operator=<@U-operator> channel=D-operator time=/);
  assert.doesNotMatch(text, /^New Slack message:/);
});

test('buildCodeAgentDeliveryPrompt emits <attached_files> metadata and omits block when no files', () => {
  const text = buildCodeAgentDeliveryPrompt(
    buildInput({
      files: [
        {
          id: 'F-img',
          mimetype: 'image/png',
          name: 'screenshot.png',
          sizeBytes: 4096,
        },
      ],
    }).event,
  );
  assert.match(text, /<attached_files>/);
  assert.match(text, /name="screenshot\.png"/);
  assert.match(text, /mimetype="image\/png"/);
  assert.doesNotMatch(text, /path=/);
  assert.match(text, /size_bytes="4096"/);
  assert.doesNotMatch(buildCodeAgentDeliveryPrompt(buildInput({}).event), /<attached_files>/);
});

test('buildAnimaRuntimeProfile tells agents to use message envelopes for Slack targets', () => {
  const text = buildAnimaRuntimeProfile({ displayName: 'Iris', role: 'Product PM for prioritization.' });
  assert.doesNotMatch(text, /\{\{name\}\}|\{\{role\}\}/);
  assert.match(text, /Reply target comes from the delivery envelope/);
  assert.match(text, /pass its `channel=` \/ `thread_ts=` to `--channel` \/ `--thread-ts` literally/);
  assert.match(text, /You always receive DMs and any message that @mentions you/);
  assert.match(text, /Only `mute` a thread\/channel when it's clearly done with you AND still noisy/);
  assert.match(text, /anima reminder/);
  assert.match(text, /anima message send --channel <id-or-name> \[--thread-ts <thread_ts>\]/);
  assert.doesNotMatch(text, /\$ANIMA_CHANNEL|\$ANIMA_THREAD/);
});

test('buildAnimaRuntimeProfile keeps MEMORY.md as a short recovery index', () => {
  const text = buildAnimaRuntimeProfile({ displayName: 'Iris', role: 'Product PM for prioritization.' });
  assert.match(text, /an index, not a corpus/);
  assert.match(text, /roughly one screen/);
  assert.match(text, /notes\/<topic>\.md/);
  assert.match(text, /Keep `Active Context` current/);
  assert.match(text, /section grows past a short paragraph/);
});

test('buildAnimaRuntimeProfile injects agent name and role into the opening identity line', () => {
  const withRole = buildAnimaRuntimeProfile({ displayName: 'Iris', role: 'Product PM for prioritization.' });
  assert.match(withRole, /You are Iris, Product PM for prioritization\./);

  const noRole = buildAnimaRuntimeProfile({ displayName: 'Anima' });
  assert.match(noRole, /You are Anima, general-purpose Anima agent\./);
});

test('runtimeEnv exposes the current inbox item identity', () => {
  const { context } = buildInput({ channelId: 'C-team' });
  const env = runtimeEnv(context, {
    ANIMA_AGENT_ID: 'wrong-agent',
    ANIMA_INBOX_ITEM_ID: 'wrong-item',
    PATH: '/tmp/bin',
  });

  assert.equal(env.ANIMA_AGENT_ID, 'anima');
  assert.equal(env.ANIMA_HOME, '/tmp');
  assert.equal(env.ANIMA_INBOX_ITEM_ID, context.item.id);
  assert.match(env.PATH ?? '', /^.*\/bin:\/tmp\/bin$/);
});


test('buildCodeAgentDeliveryPrompt renders text files as self-closing metadata references', () => {
  const text = buildCodeAgentDeliveryPrompt(
    buildInput({
      files: [
        {
          id: 'F-text',
          mimetype: 'text/plain',
          name: 'note.txt',
          sizeBytes: 12,
        },
      ],
    }).event,
  );
  assert.match(text, /<file id="F-text"/);
  assert.match(text, /name="note\.txt"/);
  assert.doesNotMatch(text, /path=/);
  assert.match(text, /\/>/);
  // No inlined content; agent uses Read tool.
  assert.doesNotMatch(text, /hello prompt|truncated|<\/file>/);
});

test('buildCodeAgentDeliveryPrompt omits path for files deferred to manual fetch', () => {
  const text = buildCodeAgentDeliveryPrompt(
    buildInput({
      files: [
        {
          id: 'F-big',
          mimetype: 'application/octet-stream',
          name: 'recording.mov',
          sizeBytes: 50 * 1024 * 1024,
        },
      ],
    }).event,
  );
  assert.match(text, /id="F-big"/);
  assert.match(text, /name="recording\.mov"/);
  assert.doesNotMatch(text, /path=/);
  assert.doesNotMatch(text, /error=/);
});

test('buildCodeAgentDeliveryPrompt renders download errors as a self-closing file tag', () => {
  const text = buildCodeAgentDeliveryPrompt(
    buildInput({
      files: [
        {
          id: 'F-failed',
          mimetype: 'image/png',
          name: 'broken.png',
          sizeBytes: 0,
          downloadError: 'HTTP 403 Forbidden',
        },
      ],
    }).event,
  );
  assert.match(text, /name="broken\.png"/);
  assert.match(text, /error="HTTP 403 Forbidden"/);
  assert.match(text, /\/>/);
});
