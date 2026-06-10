import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { FeishuInboxItem, InboxItem } from '../../shared/inbox.js';
import {
  clearActiveRuntimeItem,
  findActiveRuntimeItem,
  findToolAuditRuntimeItem,
  setActiveRuntimeItem,
  type ActiveRuntimeItemQueue,
} from '../runtime/active-item.js';
import { resolveToolItemId } from '../tools/tool-context.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { withAnimaHome } from './anima-home.js';

test('active runtime helpers accept an injected wake queue', async () => {
  const createdAt = new Date().toISOString();
  const running = {
    ...makeFeishuItem({
      chatId: 'oc_group',
      chatType: 'group',
      createdAt,
      messageId: 'om_running',
    }),
    handling: {
      createdAt,
      queuedAt: createdAt,
      startedAt: createdAt,
      status: 'running' as const,
      updatedAt: createdAt,
      workerId: 'worker-running',
    },
  } satisfies InboxItem;
  const calls: string[] = [];
  const queue: ActiveRuntimeItemQueue = {
    async list() {
      calls.push('list');
      return [running];
    },
    async markRunning(input) {
      calls.push(`running:${input.itemId}:${input.workerId}`);
      return running;
    },
    async markSettled(input) {
      calls.push(`settled:${input.itemId}:${input.workerId}`);
      return running;
    },
  };

  await setActiveRuntimeItem({ agentId: 'scout', itemId: running.id, workerId: 'worker-running' }, queue);
  assert.equal((await findActiveRuntimeItem('scout', queue))?.itemId, running.id);
  await clearActiveRuntimeItem({ agentId: 'scout', itemId: running.id, workerId: 'worker-running' }, queue);

  assert.deepEqual(calls, [
    `running:${running.id}:worker-running`,
    'list',
    `settled:${running.id}:worker-running`,
  ]);
});

test('tool audit item resolution prefers running group over newer settled p2p', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-active-item-running-group-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const running = await seedRunningAndSettledFeishuItems({
        agentId: 'scout',
        runningChatId: 'oc_group',
        runningChatType: 'group',
        runningMessageId: 'om_group',
        settledChatId: 'oc_p2p',
        settledChatType: 'p2p',
        settledMessageId: 'om_p2p',
      });

      assert.equal((await findToolAuditRuntimeItem('scout'))?.itemId, running.itemId);
      await withProcessEnv({
        ANIMA_AGENT_ID: 'scout',
        ANIMA_INBOX_ITEM_ID: running.settledItemId,
      }, async () => {
        assert.equal(await resolveToolItemId({}), running.itemId);
      });
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('tool audit item resolution prefers running p2p over newer settled group', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-active-item-running-p2p-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const running = await seedRunningAndSettledFeishuItems({
        agentId: 'scout',
        runningChatId: 'oc_p2p',
        runningChatType: 'p2p',
        runningMessageId: 'om_p2p',
        settledChatId: 'oc_group',
        settledChatType: 'group',
        settledMessageId: 'om_group',
      });

      assert.equal((await findToolAuditRuntimeItem('scout'))?.itemId, running.itemId);
      await withProcessEnv({
        ANIMA_AGENT_ID: 'scout',
        ANIMA_INBOX_ITEM_ID: running.settledItemId,
      }, async () => {
        assert.equal(await resolveToolItemId({}), running.itemId);
      });
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

async function seedRunningAndSettledFeishuItems(input: {
  agentId: string;
  runningChatId: string;
  runningChatType: string;
  runningMessageId: string;
  settledChatId: string;
  settledChatType: string;
  settledMessageId: string;
}): Promise<{ itemId: string; settledItemId: string }> {
  const queue = new WakeQueueService(input.agentId);
  const now = Date.now();
  const runningCreatedAt = new Date(now - 10_000).toISOString();
  const runningStartedAt = new Date(now - 9_000).toISOString();
  const settledCreatedAt = new Date(now - 8_000).toISOString();
  const settledStartedAt = new Date(now - 7_000).toISOString();
  const settledAt = new Date(now + 1_000).toISOString();
  const running = makeFeishuItem({
    chatId: input.runningChatId,
    chatType: input.runningChatType,
    createdAt: runningCreatedAt,
    messageId: input.runningMessageId,
  });
  const settled = makeFeishuItem({
    chatId: input.settledChatId,
    chatType: input.settledChatType,
    createdAt: settledCreatedAt,
    messageId: input.settledMessageId,
  });

  await mkdir(join(process.env.ANIMA_HOME ?? '', 'agents', input.agentId), { recursive: true });
  await queue.enqueue(running);
  await queue.enqueue(settled);
  await queue.replaceItem({
    ...running,
    handling: {
      ...running.handling,
      startedAt: runningStartedAt,
      status: 'running',
      updatedAt: runningStartedAt,
      workerId: 'worker-running',
    },
  });
  await queue.replaceItem({
    ...settled,
    handling: {
      ...settled.handling,
      completedAt: settledAt,
      settledAt,
      startedAt: settledStartedAt,
      status: 'completed',
      updatedAt: settledAt,
      workerId: 'worker-settled',
    },
  });
  return { itemId: running.id, settledItemId: settled.id };
}

function makeFeishuItem(input: {
  chatId: string;
  chatType: string;
  createdAt: string;
  messageId: string;
}): FeishuInboxItem {
  return {
    chatId: input.chatId,
    chatType: input.chatType,
    handling: {
      createdAt: input.createdAt,
      queuedAt: input.createdAt,
      status: 'queued',
      updatedAt: input.createdAt,
    },
    id: `feishu:tenant_test:${input.chatId}:${input.messageId}`,
    kind: 'feishu',
    messageId: input.messageId,
    receivedAt: input.createdAt,
    tenantKey: 'tenant_test',
    text: 'Feishu test message.',
  };
}

async function withProcessEnv<T>(
  values: Record<string, string | undefined>,
  body: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
