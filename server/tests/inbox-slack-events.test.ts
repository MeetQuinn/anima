import test from 'node:test';
import assert from 'node:assert/strict';

import { isRoutableSlackMessage, isUserAuthoredSlackMessage, normalizeSlackMessage } from '../inbox/slack-events.js';
import { slackSurfaceForEvent } from '../inbox/slack-events.js';

test('normalizes Slack DM messages into private primary-session events', () => {
  const event = normalizeSlackMessage({
    envelope: { event_id: 'Ev123', team_id: 'T123' },
    event: {
      channel: 'D123',
      channel_type: 'im',
      text: 'Can you remember this privately?',
      ts: '1770000010.000001',
      type: 'message',
      user: 'U123',
    },
  });

  const surface = slackSurfaceForEvent(event);
  assert.equal(event.id, 'slack:T123:D123:1770000010.000001');
  assert.equal(surface.id, 'slack:T123:D123');
  assert.equal(surface.teamId, 'T123');
  assert.equal(surface.channelId, 'D123');
  assert.equal(surface.kind, 'dm');
  assert.equal(surface.visibility, 'private');
  assert.equal(event.messageTs, '1770000010.000001');
});

test('normalizes Slack thread messages with reply routing metadata', () => {
  const event = normalizeSlackMessage({
    envelope: { event_id: 'Ev456', team_id: 'T123' },
    channelName: 'product',
    event: {
      channel: 'C123',
      channel_type: 'channel',
      text: 'Can you summarize here?',
      thread_ts: '1770000000.000001',
      ts: '1770000020.000001',
      type: 'message',
      user: 'U123',
    },
  });

  const surface = slackSurfaceForEvent(event);
  assert.equal(surface.kind, 'thread');
  assert.equal(surface.channelName, 'product');
  assert.equal(surface.threadTs, '1770000000.000001');
  assert.equal(surface.visibility, 'public');
});

test('normalizes Slack app mention events as addressed channel messages', () => {
  const event = normalizeSlackMessage({
    envelope: { event_id: 'Ev789', team_id: 'T123' },
    event: {
      channel: 'C123',
      text: '<@U999> can you help here?',
      ts: '1770000030.000001',
      type: 'app_mention',
      user: 'U123',
    },
  });

  const surface = slackSurfaceForEvent(event);
  assert.equal(event.id, 'slack:T123:C123:1770000030.000001');
  assert.equal(surface.kind, 'channel');
  assert.equal(surface.visibility, 'public');
  assert.equal(surface.id, 'slack:T123:C123');
});

test('normalizes resolved Slack mention text', () => {
  const event = normalizeSlackMessage({
    envelope: { event_id: 'EvMentionText', team_id: 'T123' },
    event: {
      channel: 'C123',
      text: '<@U999> please ask <@U123> in <#C456|product>',
      ts: '1770000031.000001',
      type: 'app_mention',
      user: 'U123',
    },
    text: '@anima please ask @alice in #product',
  });

  assert.equal(event.text, '@anima please ask @alice in #product');
});

test('uses Slack message ts as the stable event id across message and app_mention deliveries', () => {
  const message = normalizeSlackMessage({
    envelope: { event_id: 'EvMessage', team_id: 'T123' },
    event: {
      channel: 'C123',
      channel_type: 'channel',
      text: '<@U999> can you help here?',
      ts: '1770000030.000001',
      type: 'message',
      user: 'U123',
    },
  });
  const mention = normalizeSlackMessage({
    envelope: { event_id: 'EvMention', team_id: 'T123' },
    event: {
      channel: 'C123',
      text: '<@U999> can you help here?',
      ts: '1770000030.000001',
      type: 'app_mention',
      user: 'U123',
    },
  });

  assert.equal(message.id, mention.id);
  assert.equal(message.id, 'slack:T123:C123:1770000030.000001');
});

test('normalizes optional Slack user profile metadata into actor context', () => {
  const event = normalizeSlackMessage({
    envelope: { event_id: 'EvProfile', team_id: 'T123' },
    event: {
      channel: 'D123',
      channel_type: 'im',
      text: 'Do you know my name?',
      ts: '1770000040.000001',
      type: 'message',
      user: 'U123',
    },
    userProfile: {
      displayName: 'Alice',
      handle: 'alice',
      realName: 'Alice Lee',
    },
  });

  assert.equal(event.actor?.userId, 'U123');
  assert.equal(event.actor?.displayName, 'Alice');
  assert.equal(event.actor?.handle, 'alice');
  assert.equal(event.actor?.realName, 'Alice Lee');
});

test('routes non-self bot-authored channel messages for subscription-window checks', () => {
  assert.equal(
    isUserAuthoredSlackMessage({
      bot_id: 'B123',
      channel: 'C123',
      channel_type: 'channel',
      text: 'bot text',
      ts: '1770000020.000001',
      type: 'message',
      user: 'U123',
    }),
    false,
  );
  assert.equal(
    isRoutableSlackMessage(
      {
        bot_id: 'B123',
        channel: 'C123',
        channel_type: 'channel',
        text: 'bot text',
        ts: '1770000020.000001',
        type: 'message',
        user: 'U123',
      },
    ),
    true,
  );
  assert.equal(
    isRoutableSlackMessage(
      {
        bot_id: 'B999',
        channel: 'C123',
        channel_type: 'channel',
        text: 'self echo',
        ts: '1770000021.000001',
        type: 'message',
        user: 'U999',
      },
    ),
    true,
  );
});

test('filters unsupported subtype messages before runtime ingestion', () => {
  assert.equal(
    isUserAuthoredSlackMessage({
      channel: 'C123',
      channel_type: 'channel',
      subtype: 'message_changed',
      text: 'edited text',
      ts: '1770000020.000001',
      type: 'message',
      user: 'U123',
    }),
    false,
  );
  assert.equal(
    isRoutableSlackMessage(
      {
        channel: 'C123',
        channel_type: 'channel',
        subtype: 'message_changed',
        text: 'edited text',
        ts: '1770000020.000001',
        type: 'message',
        user: 'U123',
      },
    ),
    false,
  );
});

test('routes bot-authored messages that explicitly mention this bot', () => {
  assert.equal(
    isRoutableSlackMessage(
      {
        bot_id: 'B123',
        channel: 'C123',
        channel_type: 'channel',
        text: '<@U999> can you review this?',
        thread_ts: '1770000010.000001',
        ts: '1770000020.000001',
        type: 'message',
        user: 'U123',
      },
    ),
    true,
  );
  assert.equal(
    isRoutableSlackMessage(
      {
        bot_id: 'B999',
        channel: 'C123',
        channel_type: 'channel',
        text: '<@U999> self echo',
        thread_ts: '1770000010.000001',
        ts: '1770000021.000001',
        type: 'message',
        user: 'U999',
      },
    ),
    true,
  );
});

test('routes file-only messages (empty text, files present) and normalizes file metadata', () => {
  const rawEvent = {
    channel: 'D123',
    channel_type: 'im',
    files: [
      {
        id: 'F-screenshot',
        mimetype: 'image/png',
        name: 'screenshot.png',
        size: 2048,
        url_private: 'https://files.slack.com/private',
        url_private_download: 'https://files.slack.com/download',
      },
    ],
    subtype: 'file_share',
    text: '',
    ts: '1770000050.000001',
    type: 'message',
    user: 'U123',
  };
  assert.equal(isUserAuthoredSlackMessage(rawEvent), true);
  assert.equal(isRoutableSlackMessage(rawEvent), true);

  const event = normalizeSlackMessage({
    envelope: { event_id: 'EvFile', team_id: 'T123' },
    event: rawEvent,
  });
  assert.equal(slackSurfaceForEvent(event).kind, 'dm');
  assert.equal(event.files?.length, 1);
  assert.equal(event.files?.[0]?.id, 'F-screenshot');
  assert.equal(event.files?.[0]?.mimetype, 'image/png');
  assert.equal(event.files?.[0]?.sizeBytes, 2048);
});

test('normalizeSlackMessage prefers explicitly enriched files over raw event files', () => {
  const event = normalizeSlackMessage({
    envelope: { event_id: 'EvFileEnriched', team_id: 'T123' },
    event: {
      channel: 'C123',
      channel_type: 'channel',
      files: [{ id: 'F-raw', mimetype: 'image/png', name: 'raw.png', size: 1 }],
      text: 'see attached',
      ts: '1770000060.000001',
      type: 'message',
      user: 'U123',
    },
    files: [{
      id: 'F-enriched',
      mimetype: 'image/png',
      name: 'enriched.png',
      sizeBytes: 4096,
    }],
  });
  assert.equal(event.files?.length, 1);
  assert.equal(event.files?.[0]?.id, 'F-enriched');
  assert.equal(Object.hasOwn(event.files?.[0] ?? {}, 'localPath'), false);
});

test('routes non-self bot-authored thread messages for subscription-window checks', () => {
  assert.equal(
    isRoutableSlackMessage(
      {
        bot_id: 'B123',
        channel: 'C123',
        channel_type: 'channel',
        text: 'continuing in the active thread',
        thread_ts: '1770000010.000001',
        ts: '1770000020.000001',
        type: 'message',
        user: 'U123',
      },
    ),
    true,
  );
  assert.equal(
    isRoutableSlackMessage(
      {
        bot_id: 'B999',
        channel: 'C123',
        channel_type: 'channel',
        text: 'self echo in thread',
        thread_ts: '1770000010.000001',
        ts: '1770000021.000001',
        type: 'message',
        user: 'U999',
      },
    ),
    true,
  );
});
