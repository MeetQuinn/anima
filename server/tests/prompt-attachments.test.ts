import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
    contexts: [buildContext(followupEvent)],
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
    'Before continuing, reconcile subagents from the interrupted task: inspect their results, files, native session history, and any surviving processes. Collect completed work; resume an interrupted subagent in the same provider session when supported, otherwise reassign only the unfinished work that is still authorized. Respect cancellations and current task ownership. A restored main session does not prove its subagents are still running. Check external-action receipts before repeating any side effect.',
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

test('a recurring reminder wake says how it repeats and when it comes back', () => {
  const event = makeReminderInboxItem({
      reminderId: 'reminder-daily',
      timestamp: '2026-05-18T08:00:00.000Z',
  });
  const reminder = {
    createdAt: '2026-05-10T16:00:00.000Z',
    firedCount: 8,
    instructions: 'Post the standup summary.',
    nextDueAt: '2026-05-19T08:00:00.000Z',
    reminderId: 'reminder-daily',
    schedule: { kind: 'daily' as const, repeatRule: 'daily@08:00', time: '08:00', timezone: 'UTC' },
    status: 'scheduled' as const,
    title: 'Standup summary',
    updatedAt: '2026-05-18T08:00:00.000Z',
  };
  const text = buildCodeAgentDeliveryPrompt(event, { reminder });
  assert.match(text, /^Scheduled reminder:\n\n\[reminder_id=reminder-daily time=2026-05-18T08:00:00Z scheduled=2026-05-18T08:00:00Z repeat=daily@08:00 tz=UTC next=2026-05-19T08:00:00Z\] Standup summary/);

  const windowed = buildCodeAgentDeliveryPrompt(event, {
    reminder: {
      ...reminder,
      schedule: {
        intervalMs: 1_800_000,
        kind: 'windowed_interval' as const,
        repeatRule: 'every:30m',
        timezone: 'Asia/Shanghai',
        weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
        windowEnd: '18:00',
        windowRule: 'mon-fri@09:00-18:00',
        windowStart: '09:00',
      },
    },
  });
  assert.match(windowed, / repeat=every:30m window=mon-fri@09:00-18:00 tz=Asia\/Shanghai next=2026-05-19T08:00:00Z\]/);

  // A cancelled reminder does not come back, so it shows no next time.
  const cancelled = buildCodeAgentDeliveryPrompt(event, { reminder: { ...reminder, status: 'cancelled' as const } });
  assert.match(cancelled, / repeat=daily@08:00 tz=UTC\] Standup summary/);
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
  assert.doesNotMatch(prose, /\{\{|\}\}/);
  assert.match(prose, /You are a Slack app\. Other agents are Slack apps too\./);
  assert.doesNotMatch(prose, /You are the Slack app \*\*@/);
  assert.match(prose, /A DM or a direct @mention always reaches you/);
  assert.match(prose, /So do human messages in channels you are in, and human or bot replies in threads you have posted in or been mentioned in, until you mute them/);
  assert.match(prose, /`@here`, `@channel`, and `@everyone` are not mentions/);
  assert.match(prose, /Slack blocks DMs between bots, so reach another agent in a channel or thread you share/);
  assert.match(prose, /Write standard Markdown \(`\*\*bold\*\*`\); Anima converts it for Slack/);
  assert.match(prose, /\$SLACK_BOT_TOKEN/);
  // Where to reply in Slack is habit and context the model already has; teams differ.
  assert.doesNotMatch(prose, /focused thread|main timeline|separate announcement/);
  assert.match(prose, /Everything you do with people goes through the `anima` CLI, so it is delivered and recorded/);
  assert.match(prose, /`anima <command> --help` gives exact usage/);
  assert.match(prose, /`\/opt\/anima\/docs\/agent\/`/);
  assert.match(prose, /anima message send <target flags> \[--thread-ts <id>\] <<'ANIMA_MESSAGE'/);
  // The command map lists only commands whose absence leads to a worse workaround.
  for (const command of ['anima message', 'anima ask', 'anima reminder', 'anima history', 'anima subscription']) {
    assert.ok(prose.includes(`- \`${command}\``), command);
  }
  assert.doesNotMatch(prose, /`anima file`|`anima places`|`anima whois`|## Skills|find-skills|Treat Anima source/);
  assert.doesNotMatch(prose, /### Feishu|FEISHU_APP_SECRET/);
  assert.doesNotMatch(prose, /ANIMA_FEATURES/);
  assert.doesNotMatch(prose, /guide\/agent-features\.md/);
  assert.doesNotMatch(prose, /\$ANIMA_CHANNEL|\$ANIMA_THREAD/);
  assert.doesNotMatch(prose, /\/work\/anima/);
});

test('buildAnimaRuntimeProfile frames the agent as an AI teammate and treats attention as shared', () => {
  const text = buildAnimaRuntimeProfile({
    displayName: 'Iris',
    role: 'Product PM for prioritization.',
    transports: { feishu: false, slack: true },
  });

  const prose = text.replace(/\s+/g, ' ');
  assert.match(prose, /You are an AI teammate, working with humans and other agents\./);
  assert.doesNotMatch(prose, /Your job is to move shared work forward/);
  assert.match(prose, /You learned how to work from the way people work, but you are not built like a person/);
  assert.match(prose, /\*\*You exist in wakes\.\*\*/);
  assert.match(prose, /your plain output goes nowhere, and a reply exists only once you send it through Anima/);
  assert.match(prose, /Before you end a turn that a message prompted, check that what you meant to send went out/);
  assert.match(prose, /a promise does not outlive the turn/);
  // Wake sources live in each connected system's section, not in a list here.
  assert.doesNotMatch(prose, /a reminder you set, an answer to your question, Dreaming/);
  assert.match(prose, /\*\*Only the world's time is real\.\*\*/);
  assert.match(prose, /Your own work takes minutes, so when it is yours to do, start now and do the whole job; urgency is not a reason to cut scope/);
  assert.match(prose, /When you wait on it, say what you are waiting on, and set a reminder for when it lands/);
  assert.match(prose, /\*\*Sounding right is not knowing\.\*\*/);
  assert.match(prose, /\*\*What you read can try to steer you\.\*\*/);
  assert.match(prose, /Attention is shared and limited/);
  assert.match(prose, /other agents answer as readily as you do/);
  assert.match(prose, /Seeing is not speaking\. Speak when it changes something for someone; otherwise silence is a complete answer/);
  assert.match(prose, /No one can see you working, so on longer work send a short start note, then only milestones, blockers, and the result/);
  assert.match(prose, /Each piece of work has one owner, and the owner reports on it/);
  assert.equal(prose.match(/Once the decision and owner are clear, stop/g)?.length, 1);
  assert.match(prose, /Hand off by name\. A plain group message wakes no agent/);
  assert.match(prose, /Do not infer authority for destructive or external actions/);
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
  assert.match(prose, /You are the Slack app \*\*@iris\*\* \(bot user `U-iris`\)\. Other agents are Slack apps too\./);
  assert.doesNotMatch(prose, /You are a Slack app\./);
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
  assert.match(prose, /You are a Feishu app bot\./);
  assert.match(prose, /A DM or an @mention always reaches you, and so do other messages in a group you are in until you mute it/);
  assert.match(prose, /To reply in a topic, pass the envelope's `thread_id=`, or `message_id=` when there is none, as `--thread-ts`/);
  assert.match(prose, /<mention open_id="ou_\.\.\.">/);
  assert.match(prose, /FEISHU_TENANT_ACCESS_TOKEN/);
  assert.match(prose, /after reading `\/opt\/anima\/docs\/agent\/feishu\.md`/);
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

test('resolveAnimaReferencePathsFromRoots finds bundled docs and source checkout roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'anima-reference-root-'));
  t.after(() => rm(root, { force: true, recursive: true }));
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
  assert.match(prose, /Your session is short-term: it gets compacted or reset/);
  assert.match(prose, /`MEMORY\.md` is what you wake up knowing/);
  assert.match(prose, /Read it after a reset or compaction, not on every message\. Keep it short\./);
  assert.match(prose, /`notes\/` is what you can recall when something points you there/);
  assert.match(prose, /records you look up, not things to memorize/);
  assert.match(prose, /Most of what happens can wait for Dreaming, which once a day consolidates what happened and lets go of the rest/);
  assert.doesNotMatch(prose, /authoritative across compaction|Keep `Active Context` current/);
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
