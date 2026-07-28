import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeReminderInboxItem } from './helpers/inbox.js';
import type { InboxItem } from '../inbox/wake-queue.service.js';
import {
  buildProviderCrashRetryDeliveryPrompt,
  buildRuntimeRestartContinuationDeliveryPrompt,
  buildCodeAgentDeliveryPrompt,
} from '../runtime/delivery-prompt.js';
import {
  feishuChatAttentionNote,
  providerCrashRetryNote,
  RUNTIME_RESTART_CONTINUATION_NOTE,
  slackChannelAttentionNote,
  slackThreadAttentionNote,
} from '../runtime/delivery-notes.js';
import { resolveAnimaReferencePathsFromRoots } from '../runtime/anima-reference.js';
import { AgentRuntimeBridge, runtimeEnv } from '../runtime/runtime-bridge.js';
import { buildAnimaRuntimeProfile } from '../runtime/standing-prompt.js';
import { makeSlackEvent } from './helpers/slack.js';
import { ControlledRuntime } from './helpers/runtime-worker.js';
import type { InboxFileMeta } from '../../shared/inbox.js';
import type { Session } from '../storage/schema/session.store.js';

function buildInput(opts: {
  channelId?: string;
  channelName?: string;
  files?: InboxFileMeta[];
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

test('runtime bridge preserves the complete mid-turn message in a follow-up prompt', async () => {
  const activeEvent = makeSlackEvent({
    channelId: 'C-team',
    eventId: 'evt-active',
    teamId: 'T-demo',
    text: 'active task',
    threadTs: '1770000020.000001',
    ts: '1770000010.000001',
    userId: 'U1',
  });
  const followupEvent = makeSlackEvent({
    channelId: 'C-team',
    eventId: 'evt-followup',
    teamId: 'T-demo',
    text: 'mid-turn body sentinel',
    threadTs: '1770000020.000001',
    ts: '1770000011.000001',
    userId: 'U2',
  });
  const followup = await new AgentRuntimeBridge(new ControlledRuntime()).followupInput({
    activeContext: buildContext(activeEvent),
    context: buildContext(followupEvent),
  });
  const expectedDeliveryPrompt = buildCodeAgentDeliveryPrompt(followupEvent);

  assert.ok(followup.prompt.includes(expectedDeliveryPrompt));
  assert.match(
    followup.prompt,
    /\[channel=C-team thread_ts=1770000020\.000001 message_ts=1770000011\.000001 time=[^ \]]+ user_id=U2\]/,
  );
  assert.match(followup.prompt, /mid-turn body sentinel/);
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

  assert.equal(text, buildRuntimeRestartContinuationDeliveryPrompt({
    itemId: event.id,
    time: event.receivedAt,
  }));
  assert.doesNotMatch(text, /New Slack message/);
  assert.doesNotMatch(text, /do the expensive thing/);
});

test('delivery prompt module exposes named provider-facing Anima builders', () => {
  assert.equal(RUNTIME_RESTART_CONTINUATION_NOTE, [
    'Anima note: the runtime restarted while this task was in progress.',
    'Continue the same task from the current session; do not repeat completed external side effects.',
    'Check `anima outbox` for what you already sent and `anima inbox` for what arrived before re-sending anything.',
  ].join('\n'));
  assert.equal(providerCrashRetryNote(), [
    'Anima note: the previous provider process crashed before completing this same item.',
    'Continue the original task from the current files, conversation, and connected chat state.',
    'Do not repeat completed external side effects such as chat messages, file sends, or file edits; check `anima outbox` for what already went out, and inspect files/state, before redoing anything.',
  ].join('\n'));
  assert.equal(
    slackChannelAttentionNote('C123'),
    'Anima note: you\'ve been reading channel C123 without posting. If it is not relevant, mute it with `anima subscription mute --channel C123`.',
  );
  assert.equal(
    slackThreadAttentionNote('C123', '1770000010.000001'),
    'Anima note: you\'ve been reading thread 1770000010.000001 in C123 without posting. If it is not relevant, mute it with `anima subscription mute --channel C123 --thread-ts 1770000010.000001`.',
  );
  assert.equal(
    feishuChatAttentionNote('oc_test_chat'),
    'Anima note: you\'ve been reading Feishu chat oc_test_chat without posting. If it is not relevant, mute it with `anima subscription mute --chat-id oc_test_chat`.',
  );
  assert.match(buildRuntimeRestartContinuationDeliveryPrompt({
    itemId: 'msg-test',
    time: '2026-01-01T00:00:00.000Z',
  }), /runtime restarted/);
  assert.equal(buildProviderCrashRetryDeliveryPrompt({
    attempt: 2,
    itemId: 'msg-test',
    maxRetries: 3,
    previousError: 'boom',
    time: '2026-01-01T00:00:00.000Z',
  }), [
    'Provider crash retry:',
    '',
    '[item=msg-test retry=2/3 time=2026-01-01T00:00:00Z]',
    '',
    'Previous error: boom',
    '',
    'Anima note: the previous provider process crashed before completing this same item.',
    'Continue the original task from the current files, conversation, and connected chat state.',
    'Do not repeat completed external side effects such as chat messages, file sends, or file edits; check `anima outbox` for what already went out, and inspect files/state, before redoing anything.',
  ].join('\n'));
  assert.equal(buildProviderCrashRetryDeliveryPrompt({
    attempt: 2,
    maxRetries: 3,
    previousError: 'boom',
    time: '2026-01-01T00:00:00.000Z',
  }).split('\n')[2], '[retry=2/3 time=2026-01-01T00:00:00Z]');
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

// An agent has no timezone, and the envelope should not claim one. Slack still
// reports a `tz` on bot accounts (inherited from the workspace), so the actor
// carries it and the envelope declines to render it - the assertions below must
// therefore start from an actor that HAS a timezone, or they pin nothing.
const shanghai = {
  label: 'China Standard Time',
  name: 'Asia/Shanghai',
  offsetSeconds: 28800,
};

function envelopeForActor(actorPatch: Record<string, unknown>): string {
  const event = makeSlackEvent({
    channelId: 'D-user',
    teamId: 'T-demo',
    text: 'good morning',
    timestamp: '2026-05-19T23:59:30.000Z',
    ts: '1779235170.792609',
    userId: 'U1',
  });
  event.actor = { ...event.actor, ...actorPatch };
  return buildCodeAgentDeliveryPrompt(event);
}

test('buildCodeAgentDeliveryPrompt omits user_local_time and user_tz for bot senders', () => {
  const text = envelopeForActor({ isBot: true, timezone: shanghai });

  assert.doesNotMatch(text, /user_local_time=/);
  assert.doesNotMatch(text, /user_tz=/);
  // The UTC clock is never dropped: it is what any recipient should reason from.
  assert.match(text, /time=2026-05-19T23:59:30Z/);
  assert.match(text, /user_id=U1/);
});

test('buildCodeAgentDeliveryPrompt keeps user_local_time and user_tz for human senders', () => {
  const text = envelopeForActor({ timezone: shanghai });

  assert.match(text, /user_local_time=2026-05-20T07:59:30\+08:00 user_tz=Asia\/Shanghai/);
});

test('buildCodeAgentDeliveryPrompt treats an actor persisted before isBot existed as human', () => {
  // Old ledger rows have no `isBot` field at all. They must keep the timezone
  // they already rendered, not silently lose it on upgrade.
  const text = envelopeForActor({ timezone: shanghai });

  assert.match(text, /user_tz=Asia\/Shanghai/);
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

  assert.match(text, /^Scheduled reminder:\n\n\[reminder_id=reminder-test time=2026-05-18T17:00:00Z scheduled=2026-05-18T17:00:00Z\] Follow up on deploy/);
  assert.match(text, /Instructions:\nCheck whether the deploy finished\./);
  assert.doesNotMatch(text, /Reply command|Recovery context/);
});

test('buildCodeAgentDeliveryPrompt renders reminder scheduled time separately from delivery time', () => {
  const event = makeReminderInboxItem({
      reminderId: 'reminder-test',
      // The poll tick noticed the due reminder 45 seconds late...
      timestamp: '2026-05-18T17:00:45.000Z',
      // ...but scheduled= carries the intended fire moment.
      scheduledAt: '2026-05-18T17:00:00.000Z',
  });
  event.handling = {
    ...event.handling,
    startedAt: '2026-05-18T17:12:30.000Z',
    status: 'running',
    updatedAt: '2026-05-18T17:12:30.000Z',
    workerId: 'worker-reminder',
  };

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

  assert.match(text, /\[reminder_id=reminder-test time=2026-05-18T17:12:30Z scheduled=2026-05-18T17:00:00Z\]/);
});

test('buildCodeAgentDeliveryPrompt falls back to fired time for legacy reminder items without scheduledAt', () => {
  const event = makeReminderInboxItem({
      reminderId: 'reminder-test',
      timestamp: '2026-05-18T17:00:45.000Z',
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

  assert.match(text, /scheduled=2026-05-18T17:00:45Z/);
});

test('buildCodeAgentDeliveryPrompt renders reminder provenance as an origin envelope, not JSON', () => {
  const event = makeReminderInboxItem({
      reminderId: 'reminder-test',
      timestamp: '2026-05-18T17:00:00.000Z',
  });
  const text = buildCodeAgentDeliveryPrompt(event, {
    reminder: {
      createdAt: '2026-05-18T16:00:00.000Z',
      firedCount: 0,
      instructions: 'Check whether the deploy finished.',
      provenance: {
        channelId: 'C-team',
        messageTs: '1770000010.000001',
        threadTs: '1770000020.000001',
      },
      reminderId: 'reminder-test',
      schedule: { kind: 'once' },
      status: 'scheduled',
      title: 'Follow up on deploy',
      updatedAt: '2026-05-18T16:00:00.000Z',
    },
  });

  assert.match(text, /Scheduled from: \[channel_id=C-team thread_ts=1770000020\.000001 message_ts=1770000010\.000001\]/);
  assert.doesNotMatch(text, /Provenance:|"channelId"/);
});

test('buildCodeAgentDeliveryPrompt renders wake reason in the envelope when present', () => {
  const { event } = buildInput({ channelId: 'D-user' });
  const text = buildCodeAgentDeliveryPrompt({ ...event, wakeReason: 'dm' });
  assert.match(text, /message_ts=1770000010\.000001 wake=dm time=/);
});

test('buildCodeAgentDeliveryPrompt rejects reminders without reminder context', () => {
  assert.throws(
    () => buildCodeAgentDeliveryPrompt(makeReminderInboxItem({ reminderId: 'missing' })),
    /Reminder context not found: missing/,
  );
});

test('buildCodeAgentDeliveryPrompt renders onboarding as an onboarding wake, not a Slack DM', () => {
  const text = buildCodeAgentDeliveryPrompt({
    channelId: 'D-owner',
    handling: {
      createdAt: '2026-01-01T00:00:00.000Z',
      queuedAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    id: 'agent-onboarding:anima:U-owner',
    kind: 'onboarding',
    operator: {
      displayName: 'Iris',
      handle: 'iris',
      slackUserId: 'U-owner',
    },
    receivedAt: '2026-01-01T00:00:00.000Z',
    teamId: 'T-demo',
    text: 'Iris (<@U-owner>) just set you up here.',
  });

  assert.match(text, /^Agent onboarding:/);
  assert.match(text, /\[platform=slack channel=D-owner time=2026-01-01T00:00:00Z user_id=U-owner\]/);
  assert.doesNotMatch(text, /Reply target:|Use `anima message send/);
  assert.doesNotMatch(text, /^New Slack message:/);
});

test('buildCodeAgentDeliveryPrompt treats Slack-shaped agent-onboarding ids as ordinary Slack messages', () => {
  const event = makeSlackEvent({
    channelId: 'D-owner',
    eventId: 'agent-onboarding:anima:U-owner',
    teamId: 'T-demo',
    text: 'Iris (<@U-owner>) just set you up here.',
    userId: 'U-owner',
  });
  const text = buildCodeAgentDeliveryPrompt(event);

  assert.match(text, /^New Slack message:/);
  assert.doesNotMatch(text, /^Agent onboarding:/);
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

test('buildCodeAgentDeliveryPrompt includes Slack message previews carried by unfurls', () => {
  const event = makeSlackEvent({
    channelId: 'D-user',
    previews: [{
      authorName: 'Iris',
      channelId: 'D-private',
      files: [{
        id: 'F-unfurled-html',
        mimetype: 'text/html',
        name: 'curriculum.html',
        permalink: 'https://example.slack.com/files/U-author/F-unfurled-html/curriculum.html',
        sizeBytes: 35578,
      }],
      fromUrl: 'https://example.slack.com/archives/D-private/p1770000100000001',
      isPrivate: true,
      messageTs: '1770000100.000001',
      text: 'Preview delivered by Slack',
    }],
    teamId: 'T-demo',
    text: 'can you see this?',
    ts: '1770000200.000001',
    userId: 'U1',
  });

  const text = buildCodeAgentDeliveryPrompt(event);

  assert.match(text, /<slack_message_previews>/);
  assert.match(text, /source="slack_unfurl" private_preview="true" author="Iris" channel_id="D-private"/);
  assert.match(text, /Preview delivered by Slack/);
  assert.match(text, /<file id="F-unfurled-html" name="curriculum\.html" mimetype="text\/html"/);
  assert.match(text, /permalink="https:\/\/example\.slack\.com\/files\/U-author\/F-unfurled-html\/curriculum\.html"/);
  assert.doesNotMatch(text, /url_private|files\.slack\.com\/private/);
});

test('buildAnimaRuntimeProfile renders the concise Slack and Anima tool contract', () => {
  const text = buildAnimaRuntimeProfile({
    displayName: 'Iris',
    referencePaths: {
      docsPath: '/opt/anima/docs',
      sourcePath: '/work/anima',
    },
    role: 'Product PM for prioritization.',
    transports: { feishu: false, slack: true },
  });
  const prose = text.replace(/\s+/g, ' ');
  assert.doesNotMatch(prose, /\{\{name\}\}|\{\{role\}\}/);
  assert.match(prose, /Use the envelope's `channel=` when replying/);
  assert.match(prose, /In a DM, reply on the main timeline unless the envelope already has `thread_ts=`; then keep that thread/);
  assert.match(prose, /In a channel, keep an existing `thread_ts=`, or use a top-level message's `message_ts=` as `--thread-ts` to start a focused thread/);
  assert.match(prose, /Post another top-level channel message only when the whole channel needs a separate announcement/);
  assert.match(prose, /A DM or direct @mention always reaches you/);
  assert.match(prose, /Human-authored messages also wake you through channel\/thread follows/);
  assert.match(prose, /Bot\/app channel and thread posts wake you only through a direct @mention/);
  assert.match(prose, /`@here`, `@channel`, and `@everyone` do not count/);
  assert.match(prose, /Your own Slack posts carry a bot identity/);
  assert.match(prose, /a plain channel message wakes no agent/);
  assert.doesNotMatch(prose, /new messages there wake you/);
  assert.doesNotMatch(prose, /not in that channel or thread/);
  assert.match(prose, /Mute only when the conversation is done with you and still noisy/);
  assert.match(prose, /Slack blocks bot-to-bot DMs/);
  assert.doesNotMatch(prose, /You are \*\*@/);
  assert.match(prose, /anima reminder/);
  assert.match(prose, /anima message send <target flags> \[--thread-ts <thread_or_topic_id>\]/);
  assert.match(prose, /Read the local agent guide, reference, or recipes before unfamiliar operations/);
  assert.match(prose, /`\/opt\/anima\/docs\/agent\/`/);
  assert.match(prose, /Treat Anima source as reference unless asked to modify it/);
  assert.match(prose, /Use `anima <command> --help` for exact flags/);
  assert.match(prose, /\$SLACK_BOT_TOKEN/);
  assert.doesNotMatch(prose, /### Feishu|FEISHU_APP_SECRET/);
  assert.doesNotMatch(prose, /ANIMA_FEATURES/);
  assert.doesNotMatch(prose, /guide\/agent-features\.md/);
  assert.doesNotMatch(prose, /\$ANIMA_CHANNEL|\$ANIMA_THREAD/);
  assert.doesNotMatch(prose, /\/work\/anima/);
});

test('buildAnimaRuntimeProfile treats attention as shared cost and gives explicit stop conditions', () => {
  const text = buildAnimaRuntimeProfile({
    displayName: 'Iris',
    role: 'Product PM for prioritization.',
    transports: { feishu: false, slack: true },
  });

  const prose = text.replace(/\s+/g, ' ');
  assert.match(prose, /Your job is to move shared work forward, not to narrate every observation/);
  assert.match(prose, /Attention is shared and expensive/);
  assert.match(prose, /A message may wake teammates and consume time and tokens/);
  assert.match(prose, /Silence is a complete response/);
  assert.match(prose, /Do not send acknowledgements, repeated conclusions, or filler status/);
  assert.match(prose, /Once a decision and owner are clear, stop/);
  assert.match(prose, /Do not continue with agreement, post-mortems, process commentary, or cross-corrections unless they change the decision or prevent a concrete error/);
  assert.match(prose, /When one owner is assigned to monitor or report a task, everyone else stops parallel monitoring and status updates/);
  assert.match(prose, /Address the next owner explicitly in every handoff/);
  assert.match(prose, /Do not infer authority for destructive or external actions/);
  assert.match(prose, /If you reply, use an Anima action, send it to the conversation in the delivery envelope, and verify that it succeeded/);
  assert.doesNotMatch(prose, /Before you end a turn that a message prompted, verify your response actually went out/);
  assert.doesNotMatch(prose, /working directory is your seat/i);
});

test('buildAnimaRuntimeProfile tells the agent its own Slack identity when provided', () => {
  const text = buildAnimaRuntimeProfile({
    displayName: 'Iris',
    referencePaths: { docsPath: '/opt/anima/docs' },
    role: 'Product PM.',
    slackIdentity: { handle: '@iris', userId: 'U-iris' },
    transports: { feishu: false, slack: true },
  });
  const prose = text.replace(/\s+/g, ' ');
  assert.match(prose, /You are \*\*@iris\*\* \(user id `U-iris`\)/);
  assert.match(prose, /`<@U-iris>` addresses you/);
});

test('buildAnimaRuntimeProfile separates Feishu-only transport instructions', () => {
  const text = buildAnimaRuntimeProfile({
    displayName: 'Feishu Scout',
    referencePaths: {
      docsPath: '/opt/anima/docs',
    },
    role: 'Feishu test agent.',
    transports: { feishu: true, slack: false },
  });

  const prose = text.replace(/\s+/g, ' ');
  assert.match(prose, /Use the envelope's `chat_id=` when replying/);
  assert.match(prose, /use `thread_id=` when present, otherwise `message_id=`, as `--thread-ts`/);
  assert.match(prose, /<mention open_id="ou_\.\.\.">/);
  assert.match(prose, /FEISHU_TENANT_ACCESS_TOKEN/);
  assert.match(prose, /Before direct Feishu API work, read `\/opt\/anima\/docs\/agent\/feishu\.md`/);
  assert.doesNotMatch(prose, /### Slack|Slack API|SLACK_BOT_TOKEN|FEISHU_APP_SECRET|FEISHU_API_BASE_URL/);
});

test('buildAnimaRuntimeProfile includes both transport sections for mixed agents', () => {
  const text = buildAnimaRuntimeProfile({
    displayName: 'Bridge',
    role: 'Mixed transport agent.',
    transports: { feishu: true, slack: true },
  });

  assert.match(text, /### Slack/);
  assert.match(text, /### Feishu/);
});

test('buildAnimaRuntimeProfile falls back cleanly when bundled docs are unavailable', () => {
  const text = buildAnimaRuntimeProfile({
    displayName: 'Iris',
    referencePaths: {},
    role: 'Product PM for prioritization.',
    transports: { feishu: false, slack: true },
  });
  assert.match(text, /<https:\/\/github\.com\/MeetQuinn\/anima\/tree\/main\/docs\/agent>/);
  assert.doesNotMatch(text, /\/opt\/anima\/docs/);
});

test('resolveAnimaReferencePathsFromRoots finds bundled docs and source checkout roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anima-reference-root-'));
  mkdirSync(join(root, 'docs', 'agent'), { recursive: true });
  mkdirSync(join(root, 'docs', 'guide'), { recursive: true });
  mkdirSync(join(root, 'docs', 'architecture'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'server'), { recursive: true });
  mkdirSync(join(root, 'shared'), { recursive: true });
  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@meetquinn/anima' }));
  writeFileSync(join(root, 'docs', 'agent', 'guide.md'), '# Agent guide\n');
  writeFileSync(join(root, 'docs', 'agent', 'reference.md'), '# Agent reference\n');
  writeFileSync(join(root, 'docs', 'guide', 'how-an-agent-works.md'), '# Agent\n');
  writeFileSync(join(root, 'docs', 'guide', 'working-with-your-agent.md'), '# Working\n');
  writeFileSync(join(root, 'docs', 'guide', 'using-the-dashboard.md'), '# Dashboard\n');
  writeFileSync(join(root, 'docs', 'architecture', 'overview.md'), '# Architecture\n');
  writeFileSync(join(root, 'docs', 'runtime-providers.md'), '# Providers\n');

  assert.deepEqual(resolveAnimaReferencePathsFromRoots([join(root, 'missing'), root]), {
    docsPath: join(root, 'docs'),
    sourcePath: root,
  });
});

test('buildAnimaRuntimeProfile keeps memory recovery guidance concise', () => {
  const text = buildAnimaRuntimeProfile({
    displayName: 'Iris',
    role: 'Product PM for prioritization.',
    transports: { feishu: false, slack: true },
  });
  const prose = text.replace(/\s+/g, ' ');
  assert.match(prose, /`MEMORY\.md` is authoritative across compaction and restart/);
  assert.match(prose, /Read it after recovery, not on every message/);
  assert.match(prose, /Keep `Active Context` current with work, obligations, and costly decisions/);
  assert.match(prose, /Keep the file lean; move closed history and durable detail into `notes\/`/);
  assert.doesNotMatch(text, /an index, not a corpus/);
  assert.doesNotMatch(text, /section grows past a short paragraph/);
  assert.doesNotMatch(text, /working directory is your seat/i);
});

test('buildAnimaRuntimeProfile injects agent name and role into the opening identity line', () => {
  const withRole = buildAnimaRuntimeProfile({
    displayName: 'Iris',
    role: 'Product PM for prioritization.',
    transports: { feishu: false, slack: true },
  });
  assert.match(withRole, /You are Iris, Product PM for prioritization\./);

  const noRole = buildAnimaRuntimeProfile({
    displayName: 'Anima',
    transports: { feishu: false, slack: true },
  });
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
