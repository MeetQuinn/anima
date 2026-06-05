import test from 'node:test';
import assert from 'node:assert/strict';

import { FeishuConfig } from '../../shared/agent-config.js';
import type { FeishuInboxItem, SlackInboxItem } from '../../shared/inbox.js';
import type { FeishuMessageClient } from '../feishu/client.js';
import {
  addFeishuProcessingReaction,
  feishuProcessingReactionClient,
  removeFeishuProcessingReaction,
} from '../runtime/processing-reactions.js';

const FEISHU_CONFIG = FeishuConfig.parse({ appId: 'cli_test', appSecret: 'secret' });

function feishuItem(messageId: string): FeishuInboxItem {
  const at = '2026-06-02T00:00:00.000Z';
  return {
    chatId: 'oc_test',
    chatType: 'group',
    handling: { createdAt: at, status: 'running', updatedAt: at },
    id: `feishu:tenant:oc_test:${messageId}`,
    kind: 'feishu',
    messageId,
    receivedAt: at,
    text: 'hi',
  };
}

function fakeFeishuClient() {
  const calls: { add: string[]; remove: Array<{ messageId: string; reactionId: string }> } = {
    add: [],
    remove: [],
  };
  let counter = 0;
  const client: FeishuMessageClient = {
    async addReaction(input) {
      calls.add.push(input.messageId);
      counter += 1;
      return { reactionId: `r${counter}:${input.emojiType}` };
    },
    async downloadMessageResource() {
      return { bytes: Buffer.from('') };
    },
    async listMessages() {
      return { hasMore: false, messages: [] };
    },
    async removeReaction(input) {
      calls.remove.push(input);
    },
    async replyText() {
      return {};
    },
    async sendUploadedFile() {
      return {};
    },
    async sendText() {
      return {};
    },
    async uploadFile() {
      return { fileKey: 'file_key', kind: 'file' };
    },
  };
  return { calls, client };
}

test('feishu processing reaction adds OneSecond on start and removes the tracked reaction on settle', async () => {
  const { calls, client } = fakeFeishuClient();
  const feishuClient = feishuProcessingReactionClient(FEISHU_CONFIG, { client });
  const context = { item: feishuItem('om_1') };

  await addFeishuProcessingReaction({ context, feishuClient });
  await removeFeishuProcessingReaction({ context, feishuClient });

  assert.deepEqual(calls.add, ['om_1']);
  assert.deepEqual(calls.remove, [{ messageId: 'om_1', reactionId: 'r1:OneSecond' }]);
});

test('feishu processing reaction add is idempotent per message id', async () => {
  const { calls, client } = fakeFeishuClient();
  const feishuClient = feishuProcessingReactionClient(FEISHU_CONFIG, { client });
  const context = { item: feishuItem('om_dup') };

  await addFeishuProcessingReaction({ context, feishuClient });
  await addFeishuProcessingReaction({ context, feishuClient });

  assert.deepEqual(calls.add, ['om_dup']);
});

test('feishu processing reaction remove without a prior add is a no-op', async () => {
  const { calls, client } = fakeFeishuClient();
  const feishuClient = feishuProcessingReactionClient(FEISHU_CONFIG, { client });

  await removeFeishuProcessingReaction({ context: { item: feishuItem('om_missing') }, feishuClient });

  assert.deepEqual(calls.remove, []);
});

test('feishu processing reaction ignores non-feishu items', async () => {
  const { calls, client } = fakeFeishuClient();
  const feishuClient = feishuProcessingReactionClient(FEISHU_CONFIG, { client });
  const slackItem = {
    channelId: 'C1',
    handling: { createdAt: 'x', status: 'running', updatedAt: 'x' },
    id: 'slack:1',
    kind: 'slack',
    messageTs: '1.0',
    receivedAt: 'x',
    teamId: 'T1',
    text: 'hi',
  } as SlackInboxItem;

  await addFeishuProcessingReaction({ context: { item: slackItem }, feishuClient });

  assert.deepEqual(calls.add, []);
});

test('feishu processing reaction add swallows client errors', async () => {
  const errors: string[] = [];
  const client: FeishuMessageClient = {
    async addReaction() {
      throw new Error('boom');
    },
    async downloadMessageResource() {
      return { bytes: Buffer.from('') };
    },
    async listMessages() {
      return { hasMore: false, messages: [] };
    },
    async removeReaction() {},
    async replyText() {
      return {};
    },
    async sendUploadedFile() {
      return {};
    },
    async sendText() {
      return {};
    },
    async uploadFile() {
      return { fileKey: 'file_key', kind: 'file' };
    },
  };
  const feishuClient = feishuProcessingReactionClient(FEISHU_CONFIG, { client });

  await addFeishuProcessingReaction({
    context: { item: feishuItem('om_err') },
    feishuClient,
    logger: { error: (message: string) => errors.push(message) },
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /boom/);
});
