import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFeishuAgentConfig } from './helpers/harness.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feishuReactionEventFromData, feishuReceiveMessageEventFromData, normalizeFeishuMessage, normalizeFeishuReaction, shouldWakeFeishuRuntime } from '../feishu/events.js';
import { FeishuDirectoryService } from '../feishu/directory.service.js';
import { muteSubscriptionForAgent } from '../inbox/subscription.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { FeishuMessageTransport } from '../transports/feishu-message-transport.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { feishuChatAttentionNote } from '../runtime/delivery-notes.js';
import { messageFromInboxItem } from '../messages/message.projection.js';
import { feishuTranscriptOutput } from '../tools/feishu-transcript.js';
import { withAnimaHome } from './anima-home.js';
import { allActivities, loadState } from './helpers/state.js';
import { makeFeishuEvent, testFeishuMessageClient, feishuTransportConfig, handleFeishuReactionForTest, handleFeishuReceiveForTest } from './helpers/feishu.js';

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

test('normalizes Feishu rich text posts into inbox items', () => {
  const item = normalizeFeishuMessage({
    event: makeFeishuEvent({
      message: {
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                { tag: 'text', text: 'hello ' },
                { href: 'https://example.com', tag: 'a', text: 'link' },
              ],
              [
                { tag: 'at', user_id: 'ou_bob', user_name: 'Bob' },
                { tag: 'text', text: ' please review' },
              ],
              [{ image_key: 'img_v3', tag: 'img' }],
            ],
            title: 'Project update',
          },
        }),
        message_id: 'om_post_message',
        message_type: 'post',
      },
    }),
  });

  assert.ok(item);
  assert.equal(
    item.text,
    [
      'Project update',
      'hello link (https://example.com)',
      '@Bob please review',
      '[image]',
    ].join('\n'),
  );

  const prompt = buildCodeAgentDeliveryPrompt(item);
  assert.match(prompt, /^New Feishu message:/);
  assert.match(prompt, /ou_alice: Project update\nhello link \(https:\/\/example\.com\)\n@Bob please review\n\[image\]/);
});

test('normalizes Feishu file messages into prompt attachments', () => {
  const item = normalizeFeishuMessage({
    event: makeFeishuEvent({
      message: {
        content: JSON.stringify({
          file_key: 'file_key_report',
          file_name: 'report.pdf',
          file_size: '42',
        }),
        message_id: 'om_file_message',
        message_type: 'file',
      },
    }),
  });

  assert.ok(item);
  assert.equal(item.text, '[file] report.pdf');
  assert.deepEqual(item.files, [{
    id: 'feishu:message:om_file_message:file:file_key_report',
    mimetype: 'application/octet-stream',
    name: 'report.pdf',
    sizeBytes: 42,
  }]);

  const prompt = buildCodeAgentDeliveryPrompt(item);
  assert.match(prompt, /^New Feishu message:/);
  assert.match(prompt, /ou_alice: \[file\] report\.pdf/);
  assert.match(prompt, /<attached_files>/);
  assert.match(prompt, /<file id="feishu:message:om_file_message:file:file_key_report" name="report\.pdf" mimetype="application\/octet-stream" size_bytes="42" \/>/);
  assert.doesNotMatch(prompt, /Reply target:|Feishu API access:/);

  const message = messageFromInboxItem(item);
  assert.deepEqual(message?.files, [{
    filename: 'report.pdf',
    fileId: 'feishu:message:om_file_message:file:file_key_report',
    mimetype: 'application/octet-stream',
    sizeBytes: 42,
  }]);
});

test('Feishu delivery prompt includes attention suggestions', () => {
  const item = normalizeFeishuMessage({ event: makeFeishuEvent() });
  assert.ok(item);
  const prompt = buildCodeAgentDeliveryPrompt({
    ...item,
    attentionSuggestion: feishuChatAttentionNote('oc_test_chat'),
  });

  assert.match(prompt, /Anima note: you've been reading Feishu chat oc_test_chat without posting\. If it is not relevant, mute it with `anima subscription mute --chat-id oc_test_chat`\./);
});

test('normalizes Feishu image messages into fetchable prompt attachments', () => {
  const item = normalizeFeishuMessage({
    event: makeFeishuEvent({
      message: {
        content: JSON.stringify({ image_key: 'image_key_photo' }),
        message_id: 'om_image_message',
        message_type: 'image',
      },
    }),
  });

  assert.ok(item);
  assert.equal(item.text, '[image] image-om_image_message');
  assert.deepEqual(item.files, [{
    id: 'feishu:message:om_image_message:image:image_key_photo',
    mimetype: 'image/*',
    name: 'image-om_image_message',
    sizeBytes: 0,
  }]);

  const prompt = buildCodeAgentDeliveryPrompt(item);
  assert.match(prompt, /<file id="feishu:message:om_image_message:image:image_key_photo" name="image-om_image_message" mimetype="image\/\*" size_bytes="0" \/>/);
});

test('ignores truly unsupported Feishu message types that produce no text or files', () => {
  // interactive card with no recognizable content
  const item = normalizeFeishuMessage({
    event: makeFeishuEvent({
      message: {
        content: JSON.stringify({ header: { title: { content: 'card' } } }),
        message_id: 'om_interactive_message',
        message_type: 'interactive',
      },
    }),
  });
  assert.equal(item, undefined);
});

test('normalizes Feishu sticker messages to recognizable text', () => {
  const item = normalizeFeishuMessage({
    event: makeFeishuEvent({
      message: {
        content: JSON.stringify({ sticker_id: 'sticker_abc123' }),
        message_id: 'om_sticker_message',
        message_type: 'sticker',
      },
    }),
  });

  assert.ok(item);
  assert.equal(item.text, '[sticker sticker_id=sticker_abc123]');
  assert.equal(item.files, undefined);
});

test('normalizes Feishu sticker with image_key into a fetchable attachment', () => {
  const item = normalizeFeishuMessage({
    event: makeFeishuEvent({
      message: {
        content: JSON.stringify({ image_key: 'img_sticker_key', sticker_id: 'sticker_abc123' }),
        message_id: 'om_sticker_img_message',
        message_type: 'sticker',
      },
    }),
  });

  assert.ok(item);
  assert.equal(item.text, '[sticker sticker_id=sticker_abc123]');
  assert.deepEqual(item.files, [{
    id: 'feishu:message:om_sticker_img_message:image:img_sticker_key',
    mimetype: 'image/*',
    name: 'image-om_sticker_img_message',
    sizeBytes: 0,
  }]);
});

test('parses and normalizes Feishu reaction events', () => {
  const rawData = {
    action_time: '1780410000000',
    message_id: 'om_reacted_message',
    operator_id: { open_id: 'ou_alice', union_id: 'on_alice', user_id: 'user_alice' },
    operator_type: 'user',
    reaction_type: { emoji_type: 'THUMBSUP' },
    tenant_key: 'tenant_test',
  };

  const event = feishuReactionEventFromData(rawData);
  assert.ok(event);
  assert.equal(event.message_id, 'om_reacted_message');
  assert.equal(event.reaction_type.emoji_type, 'THUMBSUP');

  const item = normalizeFeishuReaction({
    appId: 'cli_test',
    chatId: 'oc_test_chat',
    chatType: 'group',
    event,
    tenantKey: 'tenant_test',
  });

  assert.equal(item.kind, 'feishu');
  assert.equal(item.chatId, 'oc_test_chat');
  assert.equal(item.messageId, 'om_reacted_message');
  assert.equal(item.text, '[reaction:THUMBSUP] on om_reacted_message');
  assert.equal(item.actor?.openId, 'ou_alice');
  assert.match(item.id, /reaction:om_reacted_message:THUMBSUP:ou_alice/);

  const prompt = buildCodeAgentDeliveryPrompt(item);
  assert.match(prompt, /\[reaction:THUMBSUP\] on om_reacted_message/);
  assert.match(prompt, /ou_alice:/);
});

test('feishuReactionEventFromData handles SDK-wrapped event envelope', () => {
  const wrapped = {
    event: {
      action_time: '1780410000000',
      message_id: 'om_wrapped',
      operator_type: 'user',
      reaction_type: { emoji_type: 'LIKE' },
    },
  };

  const event = feishuReactionEventFromData(wrapped);
  assert.ok(event);
  assert.equal(event.message_id, 'om_wrapped');
});

test('Feishu reaction transport enqueues human reactions to bot messages', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-reaction-transport-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const queue = new WakeQueueService('scout');
      const transport = new FeishuMessageTransport(
        {
          agentRuntimeKind: 'kimi-cli',
          config: feishuTransportConfig(),
          queue,
        },
        {
          createMessageClient: () => testFeishuMessageClient({
            async getMessage(input) {
              assert.deepEqual(input, { messageId: 'om_bot_message' });
              return {
                chatId: 'oc_test_chat',
                chatType: 'group',
                messageId: 'om_bot_message',
                sender: { id: 'cli_test', idType: 'app_id', senderType: 'app' },
              };
            },
          }),
        },
      );

      await handleFeishuReactionForTest(transport, {
        action_time: '1780410000000',
        event_id: 'evt_reaction_created_1',
        message_id: 'om_bot_message',
        operator_id: { open_id: 'ou_alice', user_id: 'user_alice' },
        operator_type: 'user',
        reaction_type: { emoji_type: 'THUMBSUP' },
        tenant_key: 'tenant_test',
      });

      const items = await queue.list();
      assert.equal(items.length, 1);
      const item = items[0];
      assert.equal(item?.kind, 'feishu');
      assert.equal(item?.id, 'feishu:tenant_test:oc_test_chat:reaction:evt_reaction_created_1');
      assert.equal(item?.chatId, 'oc_test_chat');
      assert.equal(item?.chatType, 'group');
      assert.equal(item?.text, '[reaction:THUMBSUP] on om_bot_message');
      assert.equal(item?.actor?.openId, 'ou_alice');
      assert.equal(item?.actor?.senderType, 'user');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu reaction transport ignores non-user operators and non-bot messages', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-reaction-ignore-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const queue = new WakeQueueService('scout');
      const getMessageCalls: string[] = [];
      const transport = new FeishuMessageTransport(
        {
          agentRuntimeKind: 'kimi-cli',
          config: feishuTransportConfig(),
          queue,
        },
        {
          createMessageClient: () => testFeishuMessageClient({
            async getMessage(input) {
              getMessageCalls.push(input.messageId);
              return {
                chatId: 'oc_test_chat',
                chatType: 'group',
                messageId: input.messageId,
                sender: { id: 'ou_bob', idType: 'open_id', senderType: 'user' },
              };
            },
          }),
        },
      );
      const base = {
        action_time: '1780410000000',
        message_id: 'om_message',
        operator_id: { open_id: 'ou_alice' },
        reaction_type: { emoji_type: 'THUMBSUP' },
        tenant_key: 'tenant_test',
      };

      await handleFeishuReactionForTest(transport, { ...base, event_id: 'evt_bot', operator_type: 'bot' });
      await handleFeishuReactionForTest(transport, { ...base, event_id: 'evt_app', operator_type: 'app' });
      await handleFeishuReactionForTest(transport, { ...base, event_id: 'evt_unknown' });
      await handleFeishuReactionForTest(transport, { ...base, event_id: 'evt_user_on_user', operator_type: 'user' });

      assert.deepEqual(getMessageCalls, ['om_message']);
      assert.deepEqual(await queue.list(), []);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu reaction transport deduplicates by event id when present', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-reaction-dedupe-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const queue = new WakeQueueService('scout');
      const transport = new FeishuMessageTransport(
        {
          agentRuntimeKind: 'kimi-cli',
          config: feishuTransportConfig(),
          queue,
        },
        {
          createMessageClient: () => testFeishuMessageClient({
            async getMessage(input) {
              return {
                chatId: 'oc_test_chat',
                chatType: 'group',
                messageId: input.messageId,
                sender: { id: 'cli_test', idType: 'app_id', senderType: 'app' },
              };
            },
          }),
        },
      );
      const base = {
        action_time: '1780410000000',
        message_id: 'om_bot_message',
        operator_id: { open_id: 'ou_alice' },
        operator_type: 'user',
        reaction_type: { emoji_type: 'THUMBSUP' },
        tenant_key: 'tenant_test',
      };

      await handleFeishuReactionForTest(transport, { ...base, event_id: 'evt_reaction_1' });
      await handleFeishuReactionForTest(transport, { ...base, event_id: 'evt_reaction_1' });
      await handleFeishuReactionForTest(transport, { ...base, event_id: 'evt_reaction_2' });

      assert.deepEqual(
        (await queue.list()).map((item) => item.id).sort(),
        [
          'feishu:tenant_test:oc_test_chat:reaction:evt_reaction_1',
          'feishu:tenant_test:oc_test_chat:reaction:evt_reaction_2',
        ],
      );
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('normalizes Feishu audio messages into fetchable attachments', () => {
  const item = normalizeFeishuMessage({
    event: makeFeishuEvent({
      message: {
        content: JSON.stringify({ duration: 12000, file_key: 'audio_key_abc' }),
        message_id: 'om_audio_message',
        message_type: 'audio',
      },
    }),
  });

  assert.ok(item);
  assert.equal(item.text, '[audio] audio-om_audio_message.opus');
  assert.deepEqual(item.files, [{
    id: 'feishu:message:om_audio_message:audio:audio_key_abc',
    mimetype: 'audio/opus',
    name: 'audio-om_audio_message.opus',
    sizeBytes: 0,
  }]);

  const prompt = buildCodeAgentDeliveryPrompt(item);
  assert.match(prompt, /<file id="feishu:message:om_audio_message:audio:audio_key_abc" name="audio-om_audio_message\.opus" mimetype="audio\/opus" size_bytes="0" \/>/);
});

test('normalizes Feishu media (video) messages into fetchable attachments', () => {
  const item = normalizeFeishuMessage({
    event: makeFeishuEvent({
      message: {
        content: JSON.stringify({
          file_key: 'video_key_abc',
          height: 720,
          image_key: 'thumb_key_abc',
          video_duration: 15000,
          width: 480,
        }),
        message_id: 'om_media_message',
        message_type: 'media',
      },
    }),
  });

  assert.ok(item);
  assert.equal(item.text, '[2 attachments]');
  assert.equal(item.files?.length, 2);
  assert.equal(item.files?.[0]?.id, 'feishu:message:om_media_message:file:video_key_abc');
  assert.equal(item.files?.[0]?.mimetype, 'video/mp4');
  assert.equal(item.files?.[1]?.id, 'feishu:message:om_media_message:image:thumb_key_abc');
  assert.equal(item.files?.[1]?.mimetype, 'image/*');
});

test('message read renders Feishu audio transcript with duration', () => {
  const output = feishuTranscriptOutput(
    [{
      bodyContent: JSON.stringify({ duration: 8000, file_key: 'audio_key_abc' }),
      chatId: 'oc_target_chat',
      createTime: '1780410000000',
      messageId: 'om_audio_transcript',
      messageType: 'audio',
      sender: { id: 'ou_alice', idType: 'open_id', senderName: 'Alice', senderType: 'user' },
    }],
    { chatId: 'oc_target_chat', limit: 1 },
    { hasMore: false, nextCursor: '' },
  );

  assert.match(output, /Alice: \[audio\] duration=8s/);
  assert.match(output, /attached: id=feishu:message:om_audio_transcript:audio:audio_key_abc/);
  assert.match(output, /anima file fetch feishu:message:om_audio_transcript:audio:audio_key_abc/);
});

test('message read renders Feishu media transcript with duration and resolution', () => {
  const output = feishuTranscriptOutput(
    [{
      bodyContent: JSON.stringify({ file_key: 'video_key_abc', height: 720, image_key: 'thumb_key_abc', video_duration: 15000, width: 1280 }),
      chatId: 'oc_target_chat',
      createTime: '1780410000000',
      messageId: 'om_media_transcript',
      messageType: 'media',
      sender: { id: 'ou_alice', idType: 'open_id', senderName: 'Alice', senderType: 'user' },
    }],
    { chatId: 'oc_target_chat', limit: 1 },
    { hasMore: false, nextCursor: '' },
  );

  assert.match(output, /Alice: \[media\] duration=15s 1280x720/);
  assert.match(output, /attached: id=feishu:message:om_media_transcript:file:video_key_abc/);
});

test('normalizes Feishu rich text post with inline images into attachments', () => {
  const item = normalizeFeishuMessage({
    event: makeFeishuEvent({
      message: {
        content: JSON.stringify({
          zh_cn: {
            content: [
              [{ tag: 'text', text: 'check out this screenshot' }],
              [{ image_key: 'img_inline_key', tag: 'img' }],
            ],
            title: 'Design update',
          },
        }),
        message_id: 'om_post_with_image',
        message_type: 'post',
      },
    }),
  });

  assert.ok(item);
  assert.match(item.text, /Design update/);
  assert.match(item.text, /\[image\]/);
  assert.ok(item.files?.some((f) => f.id === 'feishu:message:om_post_with_image:image:img_inline_key'));
  assert.ok(item.files?.some((f) => f.mimetype === 'image/*'));
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

test('normalizes Feishu group messages even when they are not direct mentions', () => {
  const item = normalizeFeishuMessage({
    botOpenId: 'ou_anima_bot',
    event: makeFeishuEvent({
      message: {
        chat_type: 'group',
        content: JSON.stringify({ text: 'background group message' }),
        mentions: [],
      },
    }),
  });

  assert.equal(item?.kind, 'feishu');
  assert.equal(item?.chatType, 'group');
  assert.equal(item?.text, 'background group message');
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

  assert.equal(item?.text, '<mention open_id="ou_anima_bot" mentioned_type="app">Anima</mention> please check');
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
    'New Feishu message:\n\n[platform=feishu chat=p2p chat_id=oc_test_chat message_id=om_test_message time=2026-06-02T14:20:00Z user_id=ou_alice] ou_alice: hello from Feishu',
  );
});

test('Feishu transport stamps accepted wake reason before queueing', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-wake-reason-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir, { botProfileSyncedAt: '2099-01-01T00:00:00.000Z' });
      const queue = new WakeQueueService('scout');
      const transport = new FeishuMessageTransport(
        {
          agentRuntimeKind: 'kimi-cli',
          config: feishuTransportConfig({ appId: '' }),
          queue,
        },
        { createMessageClient: () => testFeishuMessageClient() },
      );

      await handleFeishuReceiveForTest(transport, makeFeishuEvent());

      const item = (await queue.list()).find((queued) => queued.kind === 'feishu');
      assert.equal(item?.kind, 'feishu');
      assert.equal(item?.kind === 'feishu' ? item.wakeReason : undefined, 'dm');
      assert.match(
        item?.kind === 'feishu' ? buildCodeAgentDeliveryPrompt(item) : '',
        /message_id=om_test_message wake=dm time=/,
      );
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu transport records an activity trace when an attention suggestion attaches', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-attention-trace-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir, { botProfileSyncedAt: '2099-01-01T00:00:00.000Z' });
      const queue = new WakeQueueService('scout');
      const transport = new FeishuMessageTransport(
        {
          agentRuntimeKind: 'kimi-cli',
          config: feishuTransportConfig({ appId: '' }),
          queue,
        },
        { createMessageClient: () => testFeishuMessageClient() },
      );

      for (let i = 0; i < 6; i += 1) {
        await handleFeishuReceiveForTest(transport, makeFeishuEvent({
          event_id: `evt-feishu-nudge-${i}`,
          message: {
            chat_id: 'oc_group',
            chat_type: 'group',
            content: JSON.stringify({ text: `wake ${i}` }),
            message_id: `om_nudge_${i}`,
          },
        }));
      }

      const queued = await queue.list();
      const last = queued.at(-1);
      assert.equal(last?.kind, 'feishu');
      const suggestion = last?.kind === 'feishu' ? last.attentionSuggestion : undefined;
      assert.match(suggestion ?? '', /anima subscription mute --chat-id oc_group/);

      const traces = allActivities(await loadState()).filter((activity) => activity.type === 'anima.attention.suggestion');
      assert.equal(traces.length, 1);
      const trace = traces[0];
      assert.ok(trace);
      assert.deepEqual(trace.payload, {
        channelId: 'oc_group',
        channelKind: 'group',
        platform: 'feishu',
        suggestion,
      });
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu delivery prompt includes resolved quoted message content', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-quoted-message-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir, { botProfileSyncedAt: '2099-01-01T00:00:00.000Z' });
      const queue = new WakeQueueService('scout');
      const reads: string[] = [];
      const transport = new FeishuMessageTransport(
        {
          agentRuntimeKind: 'kimi-cli',
          config: {
            appId: 'cli_test',
            appSecret: 'secret',
            connected: true,
            encryptKey: '',
            verificationToken: '',
          },
          queue,
        },
        {
          createMessageClient: () => testFeishuMessageClient({
            async getMessage(input) {
              reads.push(input.messageId);
              if (input.messageId === 'om_reply_message') {
                return {
                  chatId: 'oc_test_chat',
                  messageId: 'om_reply_message',
                  sender: { id: 'ou_alice', idType: 'open_id', senderName: 'Alice', senderType: 'user' },
                };
              }
              if (input.messageId === 'om_parent_message') {
                return {
                  bodyContent: JSON.stringify({ text: 'quoted first line\nquoted second line' }),
                  chatId: 'oc_test_chat',
                  messageId: 'om_parent_message',
                  messageType: 'text',
                  sender: { id: 'ou_bob', idType: 'open_id', senderName: 'Bob', senderType: 'user' },
                };
              }
              throw new Error(`unexpected message read: ${input.messageId}`);
            },
          }),
        },
      );

      await handleFeishuReceiveForTest(transport, makeFeishuEvent({
        message: {
          content: JSON.stringify({ text: 'current reply' }),
          message_id: 'om_reply_message',
          parent_id: 'om_parent_message',
        },
      }));

      assert.deepEqual(reads, ['om_reply_message', 'om_parent_message']);
      const item = (await queue.list()).find((queued) => queued.kind === 'feishu');
      assert.equal(item?.kind, 'feishu');
      assert.deepEqual(item?.kind === 'feishu' ? item.quotedMessage : undefined, {
        actorLabel: 'Bob',
        text: 'quoted first line\nquoted second line',
      });
      assert.equal(
        item?.kind === 'feishu' ? buildCodeAgentDeliveryPrompt(item) : '',
        'New Feishu message:\n\n[platform=feishu chat=p2p chat_id=oc_test_chat message_id=om_reply_message wake=dm time=2026-06-02T14:20:00Z user_id=ou_alice] Alice:\n> (quoted) Bob: quoted first line\n> (quoted) Bob: quoted second line\ncurrent reply',
      );
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu quoted message lookup failure does not drop delivery', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-quoted-message-failure-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir, { botProfileSyncedAt: '2099-01-01T00:00:00.000Z' });
      const queue = new WakeQueueService('scout');
      const transport = new FeishuMessageTransport(
        {
          agentRuntimeKind: 'kimi-cli',
          config: {
            appId: 'cli_test',
            appSecret: 'secret',
            connected: true,
            encryptKey: '',
            verificationToken: '',
          },
          queue,
        },
        {
          createMessageClient: () => testFeishuMessageClient({
            async getMessage() {
              throw new Error('Feishu getMessage unavailable');
            },
          }),
        },
      );

      await handleFeishuReceiveForTest(transport, makeFeishuEvent({
        message: {
          content: JSON.stringify({ text: 'current reply' }),
          message_id: 'om_reply_message',
          parent_id: 'om_parent_message',
        },
      }));

      const item = (await queue.list()).find((queued) => queued.kind === 'feishu');
      assert.equal(item?.kind, 'feishu');
      assert.equal(item?.kind === 'feishu' ? item.quotedMessage : undefined, undefined);
      assert.equal(item?.kind === 'feishu' ? item.text : undefined, 'current reply');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu transport decides before API enrichment and reuses one message client', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-decide-before-enrich-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir, {
        botOpenId: 'ou_anima_bot',
        botProfileSyncedAt: '2099-01-01T00:00:00.000Z',
      });
      await muteSubscriptionForAgent({
        agentId: 'scout',
        channelId: 'oc_ignored_group',
        nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
      });

      const calls: string[] = [];
      let clientCreates = 0;
      const queue = new WakeQueueService('scout');
      const transport = new FeishuMessageTransport(
        {
          agentRuntimeKind: 'kimi-cli',
          config: feishuTransportConfig({ appId: 'cli_test', botOpenId: 'ou_anima_bot' }),
          queue,
        },
        {
          createMessageClient: () => {
            clientCreates += 1;
            return testFeishuMessageClient({
              async getChat(input) {
                calls.push(`getChat:${input.chatId}`);
                return { chatId: input.chatId, chatName: '产品群', chatType: 'group' };
              },
              async getMessage(input) {
                calls.push(`getMessage:${input.messageId}`);
                if (input.messageId === 'om_addressed') {
                  return {
                    chatId: 'oc_addressed_group',
                    messageId: 'om_addressed',
                    sender: { id: 'ou_alice', idType: 'open_id', senderName: 'Alice', senderType: 'user' },
                  };
                }
                if (input.messageId === 'om_parent') {
                  return {
                    bodyContent: JSON.stringify({ text: 'quoted parent' }),
                    chatId: 'oc_addressed_group',
                    messageId: 'om_parent',
                    messageType: 'text',
                    sender: { id: 'ou_bob', idType: 'open_id', senderName: 'Bob', senderType: 'user' },
                  };
                }
                throw new Error(`unexpected message read: ${input.messageId}`);
              },
            });
          },
        },
      );

      assert.equal(clientCreates, 1);
      await handleFeishuReceiveForTest(transport, makeFeishuEvent({
        event_id: 'evt-ignored',
        message: {
          chat_id: 'oc_ignored_group',
          chat_type: 'group',
          content: JSON.stringify({ text: 'muted chatter' }),
          message_id: 'om_ignored',
        },
      }));
      assert.deepEqual(calls, []);

      await handleFeishuReceiveForTest(transport, makeFeishuEvent({
        event_id: 'evt-addressed',
        message: {
          chat_id: 'oc_addressed_group',
          chat_type: 'group',
          content: JSON.stringify({ text: '@_user_1 please check' }),
          mentions: [{
            id: { open_id: 'ou_anima_bot' },
            key: '@_user_1',
            mentioned_type: 'app',
            name: 'Anima',
          }],
          message_id: 'om_addressed',
          parent_id: 'om_parent',
        },
      }));

      assert.equal(clientCreates, 1);
      assert.deepEqual(calls, [
        'getMessage:om_addressed',
        'getChat:oc_addressed_group',
        'getMessage:om_parent',
      ]);
      const item = (await queue.list()).find((queued) => queued.kind === 'feishu' && queued.messageId === 'om_addressed');
      assert.equal(item?.kind, 'feishu');
      assert.equal(item?.kind === 'feishu' ? item.chatName : undefined, '产品群');
      assert.deepEqual(item?.kind === 'feishu' ? item.quotedMessage : undefined, {
        actorLabel: 'Bob',
        text: 'quoted parent',
      });
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu directory enriches live delivery prompt with actor and chat names', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-directory-prompt-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const receiveEvent = makeFeishuEvent({
        message: {
          chat_type: 'group',
          mentions: [{
            id: { open_id: 'ou_bob' },
            key: '@_user_1',
            mentioned_type: 'user',
            name: 'Bob',
          }],
        },
      });
      const item = normalizeFeishuMessage({ event: receiveEvent });
      assert.ok(item);

      const service = new FeishuDirectoryService({
        directoryId: 'tenant_test',
        now: () => '2026-06-07T00:00:00.000Z',
      });
      const enriched = await service.enrichInboxItem({
        client: testFeishuMessageClient({
          async getChat(input) {
            assert.deepEqual(input, { chatId: 'oc_test_chat' });
            return { chatId: 'oc_test_chat', chatName: '产品群', chatType: 'group' };
          },
          async getMessage(input) {
            assert.deepEqual(input, { messageId: 'om_test_message' });
            return {
              chatId: 'oc_test_chat',
              messageId: 'om_test_message',
              sender: {
                id: 'ou_alice',
                idType: 'open_id',
                senderName: 'Alice',
                senderType: 'user',
              },
            };
          },
        }),
        item,
        receiveEvent,
      });

      assert.equal(enriched.actor?.displayName, 'Alice');
      assert.equal(enriched.chatName, '产品群');
      assert.equal((await service.getCachedUser('ou_bob'))?.displayName, 'Bob');
      assert.equal((await service.getCachedChat('oc_test_chat'))?.chatName, '产品群');
      assert.equal(
        buildCodeAgentDeliveryPrompt(enriched),
        'New Feishu message:\n\n[platform=feishu chat=group chat_id=oc_test_chat chat_name="产品群" message_id=om_test_message time=2026-06-02T14:20:00Z user_id=ou_alice] Alice: hello from Feishu',
      );
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});
