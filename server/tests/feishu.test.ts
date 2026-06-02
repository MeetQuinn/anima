import test from 'node:test';
import assert from 'node:assert/strict';

import {
  feishuReceiveMessageEventFromData,
  normalizeFeishuMessage,
  shouldWakeFeishuRuntime,
  type FeishuReceiveMessageEvent,
} from '../feishu/events.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { messageFromInboxItem } from '../messages/message.projection.js';

function makeFeishuEvent(overrides: Omit<Partial<FeishuReceiveMessageEvent>, 'message' | 'sender'> & {
  message?: Partial<FeishuReceiveMessageEvent['message']>;
  sender?: Partial<FeishuReceiveMessageEvent['sender']> & {
    sender_id?: Partial<NonNullable<FeishuReceiveMessageEvent['sender']['sender_id']>>;
  };
} = {}): FeishuReceiveMessageEvent {
  const { message, sender, ...rest } = overrides;
  return {
    app_id: 'cli_test',
    create_time: '1780410000000',
    event_id: 'evt-feishu-1',
    tenant_key: 'tenant_test',
    ...rest,
    message: {
      chat_id: 'oc_test_chat',
      chat_type: 'p2p',
      content: JSON.stringify({ text: 'hello from Feishu' }),
      create_time: '1780410000000',
      message_id: 'om_test_message',
      message_type: 'text',
      ...message,
    },
    sender: {
      ...sender,
      sender_id: {
        open_id: 'ou_alice',
        union_id: 'on_alice',
        user_id: 'user_alice',
        ...sender?.sender_id,
      },
      sender_type: sender?.sender_type ?? 'user',
      tenant_key: sender?.tenant_key ?? 'tenant_test',
    },
  };
}

test('normalizes Feishu text DMs into inbox items', () => {
  const item = normalizeFeishuMessage({ event: makeFeishuEvent() });

  assert.equal(item?.kind, 'feishu');
  assert.equal(item?.id, 'feishu:tenant_test:oc_test_chat:om_test_message');
  assert.equal(item?.chatId, 'oc_test_chat');
  assert.equal(item?.chatType, 'p2p');
  assert.equal(item?.messageId, 'om_test_message');
  assert.equal(item?.receivedAt, '2026-06-02T14:20:00.000Z');
  assert.equal(item?.actor?.openId, 'ou_alice');
  assert.equal(item?.text, 'hello from Feishu');
});

test('Feishu group wake policy requires the configured bot mention', () => {
  const event = makeFeishuEvent({
    message: {
      chat_type: 'group',
      mentions: [{
        id: { open_id: 'ou_other_bot' },
        key: '@_user_1',
        mentioned_type: 'app',
        name: 'OtherBot',
      }],
    },
  });

  assert.equal(shouldWakeFeishuRuntime(event, 'ou_anima_bot'), false);

  event.message.mentions = [{
    id: { open_id: 'ou_anima_bot' },
    key: '@_user_1',
    mentioned_type: 'app',
    name: 'Anima',
  }];
  assert.equal(shouldWakeFeishuRuntime(event, 'ou_anima_bot'), true);
});

test('normalizes Feishu mention keys to readable labels', () => {
  const item = normalizeFeishuMessage({
    botOpenId: 'ou_anima_bot',
    event: makeFeishuEvent({
      message: {
        chat_type: 'group',
        content: JSON.stringify({ text: '@_user_1 please check' }),
        mentions: [{
          id: { open_id: 'ou_anima_bot' },
          key: '@_user_1',
          mentioned_type: 'app',
          name: 'Anima',
        }],
      },
    }),
  });

  assert.equal(item?.text, '@Anima please check');
});

test('accepts SDK direct events and wrapped raw Feishu events', () => {
  const event = makeFeishuEvent();

  assert.equal(feishuReceiveMessageEventFromData(event)?.message.message_id, 'om_test_message');
  assert.equal(feishuReceiveMessageEventFromData({ event })?.message.message_id, 'om_test_message');
  assert.equal(feishuReceiveMessageEventFromData({ event: { message: null } }), undefined);
});

test('Feishu delivery prompt is platform-aware', () => {
  const item = normalizeFeishuMessage({ event: makeFeishuEvent() });
  assert.ok(item);

  assert.equal(
    buildCodeAgentDeliveryPrompt(item),
    [
      'New Feishu message:\n\n[platform=feishu chat=p2p chat_id=oc_test_chat message_id=om_test_message time=2026-06-02T14:20:00.000Z user_id=ou_alice] ou_alice: hello from Feishu',
      'Reply target:\nUse `anima message send` without Slack `--channel` flags to reply to this Feishu message.',
    ].join('\n\n'),
  );
});

test('Feishu inbox messages project into the message ledger', () => {
  const item = normalizeFeishuMessage({ event: makeFeishuEvent() });
  assert.ok(item);

  const message = messageFromInboxItem(item);
  assert.equal(message?.platform, 'feishu');
  assert.equal(message?.actor, 'ou_alice');
  assert.equal(message?.channelId, 'oc_test_chat');
  assert.equal(message?.channelDisplayName, 'Feishu DM');
  assert.equal(message?.messageTs, 'om_test_message');
});
