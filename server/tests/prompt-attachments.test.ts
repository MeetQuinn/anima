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
import { resolveAnimaReferencePathsFromRoots } from '../runtime/anima-reference.js';
import { runtimeEnv } from '../runtime/runtime-bridge.js';
import { buildAnimaRuntimeProfile } from '../runtime/standing-prompt.js';
import { makeSlackEvent } from './helpers/slack.js';
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

  assert.equal(text, buildRuntimeRestartContinuationDeliveryPrompt());
  assert.doesNotMatch(text, /New Slack message/);
  assert.doesNotMatch(text, /do the expensive thing/);
});

test('delivery prompt module exposes named provider-facing Anima builders', () => {
  assert.match(buildRuntimeRestartContinuationDeliveryPrompt(), /runtime restarted/);
  assert.equal(buildProviderCrashRetryDeliveryPrompt({
    attempt: 2,
    maxRetries: 3,
    previousError: 'boom',
  }), [
    'Anima system note: the previous provider process crashed before completing this same item.',
    'This is retry 2/3.',
    'Previous error: boom',
    'Continue the original task from the current files, conversation, and connected chat state.',
    'Do not repeat completed external side effects such as chat messages, file sends, or file edits; check `anima outbox` for what already went out, and inspect files/state, before redoing anything.',
  ].join('\n'));
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

  assert.match(text, /^Scheduled reminder:\n\n\[reminder_id=reminder-test time=2026-05-18T17:00:00\.000Z\] Follow up on deploy/);
  assert.match(text, /Instructions:\nCheck whether the deploy finished\./);
  assert.doesNotMatch(text, /Reply command|Recovery context/);
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
  assert.match(text, /\[owner=Iris \(@iris, <@U-owner>\) channel=D-owner time=2026-01-01T00:00:00\.000Z\]/);
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
});

test('buildAnimaRuntimeProfile tells agents to use message envelopes for Slack targets', () => {
  const text = buildAnimaRuntimeProfile({
    displayName: 'Iris',
    referencePaths: {
      docsPath: '/opt/anima/docs',
      sourcePath: '/work/anima',
    },
    role: 'Product PM for prioritization.',
    transports: { feishu: false, slack: true },
  });
  assert.doesNotMatch(text, /\{\{name\}\}|\{\{role\}\}/);
  assert.match(text, /Reply target comes from the delivery envelope/);
  assert.match(text, /pass the envelope's `channel=` as `--channel` and `thread_ts=` as `--thread-ts`/);
  assert.match(text, /Slack messages can arrive from DMs, threads, channel messages, and group conversations/);
  assert.match(text, /A DM or an @mention always reaches you/);
  assert.match(text, /Only mute \(`anima subscription mute`\) a thread\/channel when it's clearly done with you AND still noisy/);
  assert.match(text, /Slack blocks bot-to-bot DMs/);
  assert.doesNotMatch(text, /In Slack you are/);
  assert.match(text, /anima reminder/);
  assert.match(text, /anima message send <target flags> \[--thread-ts <thread_or_topic_id>\]/);
  assert.match(text, /Agent platform guide: `\/opt\/anima\/docs\/agent\/guide\.md`/);
  assert.match(text, /Read it for Anima's mental model/);
  assert.match(text, /Agent command reference: `\/opt\/anima\/docs\/agent\/reference\.md`/);
  assert.match(text, /Read it before using an unfamiliar `anima` command/);
  assert.doesNotMatch(text, /Feishu runbook/);
  assert.match(text, /General Anima docs: <https:\/\/github\.com\/MeetQuinn\/anima\/tree\/main\/docs>/);
  assert.match(text, /local docs root: `\/opt\/anima\/docs`/);
  assert.match(text, /Anima source: <https:\/\/github\.com\/MeetQuinn\/anima>/);
  assert.match(text, /local checkout: `\/work\/anima`/);
  assert.match(text, /Treat source as reference unless asked to modify Anima/);
  assert.match(text, /For exact CLI flags: `anima <command> --help`/);
  assert.match(text, /\$SLACK_BOT_TOKEN/);
  assert.doesNotMatch(text, /Feishu messages can arrive|FEISHU_APP_SECRET/);
  assert.doesNotMatch(text, /ANIMA_FEATURES/);
  assert.doesNotMatch(text, /guide\/agent-features\.md/);
  assert.doesNotMatch(text, /\$ANIMA_CHANNEL|\$ANIMA_THREAD/);
});

test('buildAnimaRuntimeProfile tells the agent its own Slack identity when provided', () => {
  const text = buildAnimaRuntimeProfile({
    displayName: 'Iris',
    referencePaths: { docsPath: '/opt/anima/docs' },
    role: 'Product PM.',
    slackIdentity: { handle: '@iris', userId: 'U-iris' },
    transports: { feishu: false, slack: true },
  });
  assert.match(text, /In Slack you are \*\*@iris\*\* \(user id `U-iris`\)/);
  assert.match(text, /`<@U-iris>` means someone is addressing you/);
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

  assert.match(text, /Feishu messages can arrive from chats, DMs, and message topics/);
  assert.match(text, /anima message send --chat-id <chat_id>/);
  assert.match(text, /anima message read --chat-id <chat_id> --thread-ts <message_or_thread_id>/);
  assert.match(text, /<mention open_id="ou_\.\.\.">/);
  assert.match(text, /FEISHU_TENANT_ACCESS_TOKEN/);
  assert.match(text, /https:\/\/open\.feishu\.cn\/open-apis/);
  assert.match(text, /Feishu runbook: `\/opt\/anima\/docs\/agent\/feishu\.md`/);
  assert.match(text, /Read it before direct Feishu API work/);
  assert.doesNotMatch(text, /Slack messages can arrive|Slack API|SLACK_BOT_TOKEN|FEISHU_APP_SECRET|FEISHU_API_BASE_URL/);
});

test('buildAnimaRuntimeProfile includes both transport sections for mixed agents', () => {
  const text = buildAnimaRuntimeProfile({
    displayName: 'Bridge',
    role: 'Mixed transport agent.',
    transports: { feishu: true, slack: true },
  });

  assert.match(text, /Slack messages can arrive/);
  assert.match(text, /Feishu messages can arrive/);
});

test('buildAnimaRuntimeProfile falls back cleanly when bundled docs are unavailable', () => {
  const text = buildAnimaRuntimeProfile({
    displayName: 'Iris',
    referencePaths: {},
    role: 'Product PM for prioritization.',
    transports: { feishu: false, slack: true },
  });
  assert.match(text, /Agent platform guide: <https:\/\/github\.com\/MeetQuinn\/anima\/tree\/main\/docs\/agent\/guide\.md>/);
  assert.match(text, /Agent command reference: <https:\/\/github\.com\/MeetQuinn\/anima\/tree\/main\/docs\/agent\/reference\.md>/);
  assert.match(text, /General Anima docs: <https:\/\/github\.com\/MeetQuinn\/anima\/tree\/main\/docs>/);
  assert.doesNotMatch(text, /local docs root:/);
  assert.match(text, /Anima source: <https:\/\/github\.com\/MeetQuinn\/anima>/);
  assert.doesNotMatch(text, /local checkout:/);
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

test('buildAnimaRuntimeProfile keeps live memory guidance focused on cheap recovery capture', () => {
  const text = buildAnimaRuntimeProfile({
    displayName: 'Iris',
    role: 'Product PM for prioritization.',
    transports: { feishu: false, slack: true },
  });
  assert.match(text, /Keep `Active Context` current/);
  assert.match(text, /decisions that would be costly to lose if the context reset/);
  assert.match(text, /Do not turn live work into a memory-cleanup project/);
  assert.match(text, /periodic Dream\/consolidation pass/);
  assert.match(text, /demotes durable detail to `notes\/`/);
  assert.doesNotMatch(text, /an index, not a corpus/);
  assert.doesNotMatch(text, /section grows past a short paragraph/);
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
