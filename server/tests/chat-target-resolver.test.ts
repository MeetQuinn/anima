import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveChatTarget } from '../tools/chat-target-resolver.js';
import type { FeishuInboxItem, FeishuOnboardingInboxItem, SlackInboxItem } from '../../shared/inbox.js';

test('resolveChatTarget resolves Feishu and Slack chat targets', () => {
  const feishuItem = makeFeishuItem({
    chatId: 'oc_current',
    chatName: 'Current Chat',
    chatType: 'group',
  });
  const slackItem = makeSlackItem();
  const onboardingItem = makeFeishuOnboardingItem();

  assert.deepEqual(resolveChatTarget('oc_current', feishuItem), {
    displayName: 'Current Chat',
    platform: 'feishu',
    receiveId: 'oc_current',
    receiveIdType: 'chat_id',
    surfaceKind: 'group',
  });
  assert.deepEqual(resolveChatTarget('oc_other', feishuItem), {
    displayName: 'Feishu chat',
    platform: 'feishu',
    receiveId: 'oc_other',
    receiveIdType: 'chat_id',
  });
  assert.deepEqual(resolveChatTarget('ou_owner', onboardingItem), {
    displayName: 'Feishu owner',
    platform: 'feishu',
    receiveId: 'ou_owner',
    receiveIdType: 'open_id',
    surfaceKind: 'open_id',
  });
  assert.deepEqual(resolveChatTarget('C123', feishuItem), { platform: 'slack' });
  assert.deepEqual(resolveChatTarget(undefined, feishuItem), { platform: 'slack' });
  assert.deepEqual(resolveChatTarget(undefined, onboardingItem), { platform: 'slack' });
  assert.deepEqual(resolveChatTarget(undefined, slackItem), { platform: 'slack' });
});

test('resolveChatTarget leaves Feishu connection fall-through to callers', () => {
  assert.deepEqual(resolveChatTarget('oc_disconnected'), {
    displayName: 'Feishu chat',
    platform: 'feishu',
    receiveId: 'oc_disconnected',
    receiveIdType: 'chat_id',
  });
});

function makeFeishuItem(input: {
  chatId: string;
  chatName?: string;
  chatType: string;
}): FeishuInboxItem {
  return {
    chatId: input.chatId,
    ...(input.chatName ? { chatName: input.chatName } : {}),
    chatType: input.chatType,
    handling: {
      createdAt: '2026-01-01T00:00:00.000Z',
      queuedAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    id: `feishu:tenant:${input.chatId}:om_current`,
    kind: 'feishu',
    messageId: 'om_current',
    receivedAt: '2026-01-01T00:00:00.000Z',
    text: 'hello',
  };
}

function makeFeishuOnboardingItem(): FeishuOnboardingInboxItem {
  return {
    handling: {
      createdAt: '2026-01-01T00:00:00.000Z',
      queuedAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    id: 'feishu-onboarding:scout:ou_owner',
    kind: 'feishu_onboarding',
    owner: { openId: 'ou_owner' },
    receivedAt: '2026-01-01T00:00:00.000Z',
    target: {
      platform: 'feishu',
      receiveId: 'ou_owner',
      receiveIdType: 'open_id',
    },
    text: 'hello owner',
  };
}

function makeSlackItem(): SlackInboxItem {
  return {
    channelId: 'C123',
    handling: {
      createdAt: '2026-01-01T00:00:00.000Z',
      queuedAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    id: 'slack:T123:C123:1770000000.000001',
    kind: 'slack',
    messageTs: '1770000000.000001',
    receivedAt: '2026-01-01T00:00:00.000Z',
    teamId: 'T123',
    text: 'hello',
  };
}
