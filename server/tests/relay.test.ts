import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { runRelaySend } from '../tools/relay.js';
import type { AgentMessageInboxItem } from '../../shared/inbox.js';
import { withAnimaHome } from './anima-home.js';

async function withTwoAgents(
  body: (ids: { milo: string; nora: string }) => Promise<void>,
): Promise<void> {
  const configDir = await mkdtemp(join(tmpdir(), 'anima-relay-config-'));
  const miloHome = await mkdtemp(join(tmpdir(), 'anima-relay-milo-'));
  const noraHome = await mkdtemp(join(tmpdir(), 'anima-relay-nora-'));
  try {
    await withAnimaHome(configDir, async () => {
      await defaultAgentRegistryService.createAgent({
        name: 'Milo',
        homePath: miloHome,
        role: 'Lead engineer.',
        provider: { kind: 'claude-code', model: 'opus' },
      });
      await defaultAgentRegistryService.createAgent({
        name: 'Nora',
        homePath: noraHome,
        role: 'Reviewer.',
        provider: { kind: 'claude-code', model: 'opus' },
      });
      await body({ milo: 'milo', nora: 'nora' });
    });
  } finally {
    await rm(configDir, { force: true, recursive: true });
    await rm(miloHome, { force: true, recursive: true });
    await rm(noraHome, { force: true, recursive: true });
  }
}

test('relay send writes an identified agent_message into the target inbox', async () => {
  await withTwoAgents(async ({ milo, nora }) => {
    await runRelaySend({ agent: milo, to: nora, text: 'can you review PR #128?' });

    const items = await new WakeQueueService(nora).list();
    const relayItems = items.filter((item): item is AgentMessageInboxItem => item.kind === 'agent_message');
    assert.equal(relayItems.length, 1);
    const item = relayItems[0]!;
    assert.equal(item.fromAgentId, milo);
    assert.equal(item.fromName, 'Milo');
    assert.equal(item.text, 'can you review PR #128?');
    assert.equal(item.handling.status, 'queued');
    assert.match(item.id, /^agent_msg:milo:nora:/);

    // The sender records a local audit/activity row (shown in its dashboard log).
    const activities = await activityServiceForAgent(milo).readAll();
    const sent = activities.find((a) => a.payload?.['effect'] === 'agent.relay.send' && a.payload?.['status'] === 'completed');
    assert.ok(sent, 'sender should record an agent.relay.send completed activity');
    assert.equal(sent!.payload?.['toAgentId'], nora);
    assert.equal(sent!.payload?.['text'], 'can you review PR #128?');
  });
});

test('relay send carries reply-to threading', async () => {
  await withTwoAgents(async ({ milo, nora }) => {
    await runRelaySend({ agent: milo, to: nora, text: 'done', replyTo: 'agent_msg:nora:milo:m_root' });
    const items = await new WakeQueueService(nora).list();
    const item = items.find((i): i is AgentMessageInboxItem => i.kind === 'agent_message');
    assert.equal(item?.replyTo, 'agent_msg:nora:milo:m_root');
  });
});

test('relay send rejects unknown and self targets', async () => {
  await withTwoAgents(async ({ milo, nora }) => {
    await assert.rejects(
      () => runRelaySend({ agent: milo, to: 'ghost', text: 'hi' }),
      /Unknown target agent: ghost/,
    );
    await assert.rejects(
      () => runRelaySend({ agent: milo, to: milo, text: 'hi' }),
      /Cannot relay a message to yourself/,
    );
    // Neither should have written anything to a real inbox.
    const items = await new WakeQueueService(nora).list();
    assert.equal(items.filter((i) => i.kind === 'agent_message').length, 0);
  });
});

test('relay send projects into both agents’ Messages ledgers', async () => {
  await withTwoAgents(async ({ milo, nora }) => {
    await runRelaySend({ agent: milo, to: nora, text: 'can you review PR #128?' });

    // Recipient sees an inbound local message identified by sender.
    const inbound = (await messageServiceForAgent(nora).list()).entries
      .find((m) => m.platform === 'local');
    assert.ok(inbound, 'recipient ledger should hold the inbound relay message');
    assert.equal(inbound!.direction, 'in');
    assert.equal(inbound!.actor, 'Milo');
    assert.equal(inbound!.actorUserId, milo);
    assert.equal(inbound!.text, 'can you review PR #128?');

    // Sender sees the outbound counterpart addressed to the recipient.
    const outbound = (await messageServiceForAgent(milo).list()).entries
      .find((m) => m.platform === 'local');
    assert.ok(outbound, 'sender ledger should hold the outbound relay message');
    assert.equal(outbound!.direction, 'out');
    assert.equal(outbound!.dmHandle, 'Nora');
    assert.equal(outbound!.text, 'can you review PR #128?');
  });
});

test('agent_message delivery prompt carries sender identity and reply target', () => {
  const event: AgentMessageInboxItem = {
    fromAgentId: 'milo',
    fromName: 'Milo',
    handling: { createdAt: '2026-06-03T10:00:00.000Z', queuedAt: '2026-06-03T10:00:00.000Z', status: 'queued', updatedAt: '2026-06-03T10:00:00.000Z' },
    id: 'agent_msg:milo:nora:m_abc',
    kind: 'agent_message',
    receivedAt: '2026-06-03T10:00:00.000Z',
    replyTo: 'agent_msg:nora:milo:m_root',
    text: 'ping',
  };
  const prompt = buildCodeAgentDeliveryPrompt(event);
  assert.match(prompt, /New local agent message:/);
  assert.match(prompt, /from=milo name=Milo/);
  assert.match(prompt, /message_id=agent_msg:milo:nora:m_abc/);
  assert.match(prompt, /reply_to=agent_msg:nora:milo:m_root/);
  assert.match(prompt, /anima relay send --to milo --reply-to agent_msg:milo:nora:m_abc/);
  assert.match(prompt, /not.*sent on any chat platform/i);
});
