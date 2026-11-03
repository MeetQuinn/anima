import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { LinearInboxItem, LinearNotificationInboxItem } from '../../shared/inbox.js';
import { parseLinearReplyTarget } from '../linear/reply-target.js';
import { verifyLinearWebhook, type LinearWebhook } from '../linear/webhook.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { buildAnimaRuntimeProfile } from '../runtime/standing-prompt.js';
import { linearIssueKey } from '../linear/delivery-text.js';
import { startRunningAgent } from '../runtime/agent-runner.js';
import { TeamRunLimiter } from '../runtime/team-run-limiter.js';
import type { AgentRuntimeInput } from '../providers/contract.js';
import { withTempAnimaHome, waitFor } from './helpers/harness.js';
import { created, prompted, install, seedLinear, sessionId } from './helpers/linear.js';
import { makeSlackEvent } from './helpers/slack.js';

function verified<T extends LinearWebhook>(event: T): T {
  const raw = Buffer.from(JSON.stringify(event));
  return verifyLinearWebhook(raw, createHmac('sha256', install.signingSecret).update(raw).digest('hex'), install) as T;
}

test('a follow-up identifies its actual author and source time instead of attributing it to the session creator', async () => withTempAnimaHome(async (home) => {
  const { service } = await seedLinear(home);
  const first = created(); first.promptContext = 'Initial task context';
  await service.receive(verified(first), install);
  const event = prompted();
  event.agentSession.creator = { name: 'Original requester' };
  event.agentActivity!.userId = randomUUID();
  event.agentActivity!.user = { id: event.agentActivity!.userId, name: 'Follow-up author' };
  event.agentActivity!.createdAt = '2026-10-03T01:02:03.456Z';
  event.agentActivity!.content!.body = 'Use the second option.';
  const parsed = verified(event);
  await service.receive(parsed, install);
  const item = (await new WakeQueueService('scout').list()).find((i) => i.kind === 'linear' && i.activityId === event.agentActivity!.id)!;
  item.handling.startedAt = '2026-10-04T05:06:07.890Z';
  const prompt = buildCodeAgentDeliveryPrompt(item);
  assert.match(prompt, /wake=followup/);
  assert.match(prompt, new RegExp(`reply_to=session:${sessionId}`));
  assert.match(prompt, new RegExp(`\\[activity_id=${event.agentActivity!.id} time=`));
  assert.doesNotMatch(prompt, /session_id=|user_id=|received_at=/);
  assert.match(prompt, /time=2026-10-03T01:02:03Z/);
  assert.match(prompt, /claimed_at=2026-10-04T05:06:07Z/);
  assert.match(prompt, /Follow-up author: Use the second option\./);
  assert.doesNotMatch(prompt, /Original requester|Initial task context|anima linear|--kind/);
  event.agentActivity!.user!.id = randomUUID();
  assert.throws(() => verified(event), /author mismatch/);
}));

for (const promptContext of [undefined, '', ' \n\t']) test(`missing or blank initial context keeps prior thread meaning: ${JSON.stringify(promptContext)}`, async () => withTempAnimaHome(async (home) => {
  const { service } = await seedLinear(home);
  const event = created(); event.promptContext = promptContext;
  const commentId = randomUUID(), authorId = randomUUID(), issueId = randomUUID();
  event.agentSession.issueId = issueId;
  event.agentSession.issue = { id: issueId, title: 'Choose an approach', description: 'Preserve existing data.' };
  event.agentSession.commentId = commentId;
  event.agentSession.comment = { id: commentId, body: 'Compare two approaches.' };
  event.previousComments = [event.agentSession.comment, { id: randomUUID(), body: 'Option two changes only the copy.', userId: authorId }];
  event.guidance = [{ body: 'Keep the public API stable.' }];
  await service.receive(verified(event), install);
  const [item] = await new WakeQueueService('scout').list();
  const prompt = buildCodeAgentDeliveryPrompt(item!);
  // The session's thread root has no author, as Linear writes it for a delegation.
  assert.match(prompt, /^Linear conversation update:\n\nSynthetic requester delegated an issue to you:\nChoose an approach\n/);
  assert.match(prompt, /wake=delegated /); assert.doesNotMatch(prompt, /context=|Partial initial context|requester_id=/);
  assert.match(prompt, /Preserve existing data/); assert.match(prompt, /Option two changes only the copy/);
  assert.match(prompt, new RegExp(`user_id=${authorId}`));
  assert.match(prompt, /Keep the public API stable/);
  assert.equal(prompt.split('Compare two approaches.').length - 1, 1, 'The root comment also present in previousComments is shown once');
}));

test('partial context keeps earlier thread comments before the triggering reply', async () => withTempAnimaHome(async (home) => {
  const { service } = await seedLinear(home);
  const event = created(); event.promptContext = undefined;
  const root = { id: randomUUID(), body: 'FIRST: compare the options.' };
  const reply = { id: randomUUID(), body: 'SECOND: option two changes the copy.' };
  event.previousComments = [root, reply, root];
  event.agentSession.comment = { id: randomUUID(), body: 'THIRD: use option two.' };
  event.agentSession.commentId = event.agentSession.comment.id;
  await service.receive(verified(event), install);
  const [item] = await new WakeQueueService('scout').list();
  const prompt = buildCodeAgentDeliveryPrompt(item!);
  assert.ok(prompt.indexOf('FIRST:') < prompt.indexOf('SECOND:'));
  assert.ok(prompt.indexOf('SECOND:') < prompt.indexOf('THIRD:'));
  assert.equal(prompt.split('FIRST:').length - 1, 1);
}));

test('a supplied full context stays intact and old queued inputs recover their event type without borrowing the requester as speaker', async () => withTempAnimaHome(async (home) => {
  const { service } = await seedLinear(home);
  const event = created(); event.promptContext = '  Full supplied context\nwith its original indentation.';
  await service.receive(verified(event), install);
  const [item] = await new WakeQueueService('scout').list();
  assert.match(buildCodeAgentDeliveryPrompt(item!), /  Full supplied context\nwith its original indentation\./);
  assert.doesNotMatch(buildCodeAgentDeliveryPrompt(item!), /Partial initial context/);
  const old = LinearInboxItem.parse({ id: `linear:${install.id}:prompted:${randomUUID()}`, kind: 'linear', installationId: install.id, organizationId: install.organizationId,
    sessionId, humanRequested: true, actorName: 'Legacy requester', text: 'Legacy request', receivedAt: '2026-10-03T01:02:03Z',
    handling: { status: 'queued', createdAt: '2026-10-03T01:02:03Z', updatedAt: '2026-10-03T01:02:03Z' } });
  assert.equal('humanRequested' in old, false, 'Legacy inputs still parse after the unused origin flag is removed');
  const rendered = buildCodeAgentDeliveryPrompt(old);
  assert.match(rendered, /wake=followup/); assert.match(rendered, /Unknown author: Legacy request/);
  assert.doesNotMatch(rendered, /Legacy requester|Requested by|context=snapshot|user_id=|\stime=/);
  old.handling.resumeReason = 'runtime_restart';
  assert.match(buildCodeAgentDeliveryPrompt(old), /Legacy request/);
  assert.match(buildCodeAgentDeliveryPrompt(old), new RegExp(`reply_to=session:${sessionId} wake=followup `));
  old.handling.resumeReason = undefined;
  // A created session from before origins were stored counts as a delegation; its key comes from the URL.
  old.id = `linear:${install.id}:created:${sessionId}`;
  old.issueUrl = 'https://linear.app/synthetic/issue/SYN-7/legacy-title';
  assert.match(buildCodeAgentDeliveryPrompt(old), /^Linear conversation update:\n\n\[issue=SYN-7\] Legacy requester delegated SYN-7 to you:\nLegacy request\n\n/);
  assert.match(buildCodeAgentDeliveryPrompt(old), /issue=SYN-7 wake=delegated /);
  assert.doesNotMatch(buildCodeAgentDeliveryPrompt(old), /Issue: |https:/);
  old.id = 'unclassified-legacy-item';
  assert.match(buildCodeAgentDeliveryPrompt(old), /wake=followup /);
  assert.doesNotMatch(buildCodeAgentDeliveryPrompt(old), /Requested by|delegated|context=snapshot|Legacy requester/);
}));

test('every Linear envelope names one reply target: the session, the thread root, or the issue', () => {
  const at = '2026-10-03T01:02:03Z', issueId = randomUUID(), root = randomUUID(), reply = randomUUID();
  const render = (extra: Record<string, unknown>) => buildCodeAgentDeliveryPrompt(LinearNotificationInboxItem.parse({
    id: `linear-notification:${randomUUID()}`, kind: 'linear_notification', installationId: install.id, organizationId: install.organizationId,
    notificationType: 'issueNewComment', text: 'Context', receivedAt: at, handling: { status: 'queued', createdAt: at, updatedAt: at }, ...extra }));
  const target = (prompt: string) => parseLinearReplyTarget(/reply_to=(\S+)/.exec(prompt)![1]!);
  // A reply inside a thread is answered in that thread, at its root.
  assert.deepEqual(target(render({ issueId, commentId: reply, parentCommentId: root })), { kind: 'comment', id: root });
  assert.deepEqual(target(render({ issueId, commentId: root, notificationType: 'issueCommentMention' })), { kind: 'comment', id: root });
  assert.deepEqual(target(render({ issueId, notificationType: 'issueStatusChanged' })), { kind: 'issue', id: issueId });
  assert.doesNotMatch(render({ notificationType: 'permissionChange' }), /reply_to=/);
});

test('reply targets parse only in the envelope form', () => {
  const id = randomUUID();
  assert.deepEqual(parseLinearReplyTarget(`session:${id}`), { kind: 'session', id });
  assert.deepEqual(parseLinearReplyTarget(' issue:SYN-1 '), { kind: 'issue', id: 'SYN-1' });
  for (const bad of [id, `session:SYN-1`, `comment:${id}x`, `thread:${id}`, `reply_to=session:${id}`, 'issue:', '']) {
    assert.throws(() => parseLinearReplyTarget(bad), /reply_to value from the Linear envelope/, bad);
  }
});

test('a follow-up with no author never inherits the responsible human from its session', async () => withTempAnimaHome(async (home) => {
  const { service } = await seedLinear(home);
  const event = prompted(); event.agentSession.creator = { name: 'Not the known speaker' };
  await service.receive(verified(event), install);
  const [item] = await new WakeQueueService('scout').list();
  const prompt = buildCodeAgentDeliveryPrompt(item!);
  assert.match(prompt, /Unknown author/); assert.doesNotMatch(prompt, /Not the known speaker|user_id=/);
}));


for (const connected of [undefined, false, true]) test(`runtime injects the Linear capability only for an installed identity: ${connected}`, async (t) => withTempAnimaHome(async (home) => {
  const { fake, agentStore } = await seedLinear(home); t.mock.method(globalThis, 'fetch', fake.fetch);
  await agentStore.update((agent) => ({ ...agent, linear: connected === undefined ? undefined : { ...agent.linear!, connected } }));
  const calls: AgentRuntimeInput[] = [];
  const runtime = { kind: 'synthetic', async run(input: AgentRuntimeInput) { calls.push(input); return { text: 'Done' }; },
    async appendToActiveRun() { return { accepted: false }; }, async close() {} };
  const runner = await startRunningAgent({ agentId: 'scout', agentRuntime: runtime, animaHome: home, stateDir: home,
    homePath: (await agentStore.read()).homePath!, runtimeEnv: {}, runLimiter: new TeamRunLimiter(1) });
  try {
    const queue = new WakeQueueService('scout');
    await queue.enqueue(makeSlackEvent({ channelId: 'D-synthetic', teamId: 'T-synthetic', userId: 'U-synthetic', text: 'A Slack message' }));
    await waitFor(() => calls.length === 1); await waitFor(async () => (await queue.list()).length === 0);
    const standing = calls[0]!.systemPrompt;
    assert.ok(standing);
    assert.equal(standing.includes('### Linear'), connected === true);
    assert.equal(standing.includes('anima linear'), connected === true);
    assert.doesNotMatch(standing, /LINEAR_ACCESS_TOKEN|linear respond|linear comment|linear start/);
    assert.equal(standing.includes('anima linear reply --to <reply_to>'), connected === true);
    // This installation predates recorded names, so only the app user id is known.
    assert.equal(standing.includes(`- You are app user \`${install.appUserId}\` in Linear.`), connected === true);
  } finally { await runner.stop(); }
}));

test('the short capability entry has a usable docs link without local bundled docs', () => {
  const text = buildAnimaRuntimeProfile({ displayName: 'Synthetic', referencePaths: {}, transports: { linear: true, slack: false, feishu: false } });
  assert.match(text, /https:\/\/github\.com\/MeetQuinn\/anima\/tree\/main\/docs\/agent\/linear\.md/);
  assert.doesNotMatch(text, /\{\{|\/agent\/linear\.md`/);
});

test('the runtime names the agent in Linear from its installation', async (t) => withTempAnimaHome(async (home) => {
  const { fake, agentStore, store } = await seedLinear(home); t.mock.method(globalThis, 'fetch', fake.fetch);
  await store.update((file) => ({ ...file, installation: { ...file.installation!, appName: 'Scout' } }));
  const calls: AgentRuntimeInput[] = [];
  const runtime = { kind: 'synthetic', async run(input: AgentRuntimeInput) { calls.push(input); return { text: 'Done' }; },
    async appendToActiveRun() { return { accepted: false }; }, async close() {} };
  const runner = await startRunningAgent({ agentId: 'scout', agentRuntime: runtime, animaHome: home, stateDir: home,
    homePath: (await agentStore.read()).homePath!, runtimeEnv: {}, runLimiter: new TeamRunLimiter(1) });
  try {
    const queue = new WakeQueueService('scout');
    await queue.enqueue(makeSlackEvent({ channelId: 'D-synthetic', teamId: 'T-synthetic', userId: 'U-synthetic', text: 'A Slack message' }));
    await waitFor(() => calls.length === 1);
    assert.match(calls[0]!.systemPrompt!, new RegExp(`\\n- You are \\*\\*Scout\\*\\* in Linear \\(app user \`${install.appUserId}\`\\)\\. Comments and\\n  activities from that id are your own\\.\\n`));
  } finally { await runner.stop(); }
}));

test('the standing Linear section renders with a named identity, an id only, no identity, or without Linear', () => {
  const render = (extra: Partial<Parameters<typeof buildAnimaRuntimeProfile>[0]>, linear = true) => buildAnimaRuntimeProfile({ displayName: 'Synthetic',
    referencePaths: { docsPath: '/synthetic-docs' }, transports: { linear, slack: false, feishu: false }, ...extra });
  const section = (text: string) => text.slice(text.indexOf('### Linear'), text.indexOf('## Memory and recovery'));
  const named = section(render({ linearIdentity: { appUserId: 'app-user-sentinel', name: 'Synthetic app' } }));
  assert.match(named, /^### Linear\n\n+- You are \*\*Synthetic app\*\* in Linear \(app user `app-user-sentinel`\)\. Comments and\n  activities from that id are your own\.\n- A delegation, an @mention/);
  assert.match(named, /\n- For anything else use `anima linear api` \(GraphQL\); see\n  `\/synthetic-docs\/agent\/linear\.md`\.\n+$/);
  for (const line of ['Anima never changes issue status.', 'send progress as `--kind thought`', 'delegate the issue to its Linear app user']) assert.ok(named.includes(line), line);
  const idOnly = section(render({ linearIdentity: { appUserId: 'app-user-sentinel' } }));
  assert.match(idOnly, /^### Linear\n\n- You are app user `app-user-sentinel` in Linear\. Comments and activities from that\n  id are your own\.\n- A delegation/);
  const anonymous = section(render({}));
  assert.match(anonymous, /^### Linear\n\n- A delegation/);
  const off = render({ linearIdentity: { appUserId: 'app-user-sentinel', name: 'Synthetic app' } }, false);
  assert.doesNotMatch(off, /### Linear|app-user-sentinel|Synthetic app|anima linear/);
  for (const text of [named, idOnly, anonymous, off]) assert.doesNotMatch(text, /\{\{|\}\}/);
});

// Created sessions: Linear writes the root comment of a delegated session's thread itself.
for (const [origin, creator, wake, line] of [
  ['delegation', true, 'delegated', 'Synthetic requester delegated SYN-12 to you:'],
  ['delegation', false, 'delegated', 'SYN-12 was delegated to you:'],
  ['mention', true, 'mention', 'Synthetic requester mentioned you on SYN-12:'],
  ['mention', false, 'mention', 'You were mentioned on SYN-12:'],
] as const) test(`a created session (${origin}, creator=${creator}) opens with who asked, then Linear's context unchanged`, async () => withTempAnimaHome(async (home) => {
  const { service } = await seedLinear(home);
  const event = created(), issueId = randomUUID(), rootId = randomUUID();
  event.agentSession.createdAt = '2026-11-03T17:02:58.123Z';
  event.agentSession.issueId = issueId;
  event.agentSession.issue = { id: issueId, identifier: 'SYN-12', title: 'Synthetic', url: 'https://linear.app/synthetic/issue/SYN-12/synthetic' };
  event.agentSession.commentId = rootId;
  event.agentSession.comment = origin === 'mention' ? { id: rootId, body: '@scout please look', userId: randomUUID() }
    : { id: rootId, body: 'This thread is for an agent session with scout.', userId: null };
  if (!creator) { event.agentSession.creatorId = null; event.agentSession.creator = null; }
  event.promptContext = '  <issue identifier="SYN-12">\n<title>Synthetic</title>\n</issue>';
  await service.receive(verified(event), install);
  const [item] = await new WakeQueueService('scout').list();
  assert.ok(item?.kind === 'linear');
  assert.equal(item.origin, origin); assert.equal(item.issueKey, 'SYN-12');
  item.handling.queuedAt = '2026-11-03T17:03:00.000Z';
  assert.equal(buildCodeAgentDeliveryPrompt(item), `Linear conversation update:\n\n[issue=SYN-12 time=2026-11-03T17:02:58Z] ${line}\n`
    + `  <issue identifier="SYN-12">\n<title>Synthetic</title>\n</issue>\n\n`
    + `Wake trigger:\n[platform=linear reply_to=session:${sessionId} issue=SYN-12 wake=${wake} queued_at=2026-11-03T17:03:00Z]`);
}));

test('a follow-up names its issue and author so it reads on its own', async () => withTempAnimaHome(async (home) => {
  const { service } = await seedLinear(home);
  const event = prompted(), issueId = randomUUID(), authorId = randomUUID();
  event.agentSession.issueId = issueId;
  event.agentSession.issue = { id: issueId, identifier: 'SYN-12', title: 'Synthetic', url: 'https://linear.app/synthetic/issue/SYN-12/synthetic' };
  event.agentActivity!.createdAt = '2026-11-03T18:10:00.000Z';
  event.agentActivity!.userId = authorId; event.agentActivity!.user = { id: authorId, name: 'Synthetic teammate' };
  event.agentActivity!.content!.body = '@scout can you take a look?';
  await service.receive(verified(event), install);
  const [item] = await new WakeQueueService('scout').list();
  assert.ok(item?.kind === 'linear');
  item.handling.queuedAt = '2026-11-03T18:10:01.000Z'; item.handling.startedAt = '2026-11-03T18:10:02.000Z';
  assert.equal(buildCodeAgentDeliveryPrompt(item), `Linear conversation update:\n\n`
    + `[issue=SYN-12 activity_id=${event.agentActivity!.id} time=2026-11-03T18:10:00Z] Synthetic teammate: @scout can you take a look?\n\n`
    + `Wake trigger:\n[platform=linear reply_to=session:${sessionId} issue=SYN-12 wake=followup queued_at=2026-11-03T18:10:01Z claimed_at=2026-11-03T18:10:02Z]`);
}));

test('an identifier that is not an issue key falls back to the issue URL and never rejects the event', async () => withTempAnimaHome(async (home) => {
  const { service } = await seedLinear(home);
  const event = created(), issueId = randomUUID();
  event.agentSession.issueId = issueId;
  event.agentSession.issue = { id: issueId, identifier: 42 as unknown as string, title: 'Synthetic', url: 'https://linear.app/synthetic/issue/SYN-9/synthetic' };
  await service.receive(verified(event), install);
  const [item] = await new WakeQueueService('scout').list();
  assert.ok(item?.kind === 'linear'); assert.equal(item.issueKey, 'SYN-9');
  assert.equal(linearIssueKey('syn-9', 'https://linear.app/synthetic/issue/SYN-9/x'), 'SYN-9');
  assert.equal(linearIssueKey('SYN-10', 'https://linear.app/synthetic/issue/SYN-9/x'), 'SYN-10');
  for (const url of ['https://linear.app/synthetic/project/SYN-9', 'https://linear.app/issue/SYN-9', 'not a url', 'https://linear.app/synthetic/issue/syn-9']) {
    assert.equal(linearIssueKey(undefined, url), undefined, url);
  }
}));
