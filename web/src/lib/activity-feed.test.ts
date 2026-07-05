import { describe, expect, it } from 'vitest';

import { buildActivityFeed, buildMessageFeed } from './activity-feed';
import type { AgentActivityFeedPage } from '@shared/activity';
import type { AgentMessageHistoryPage, AgentMessageRecord } from '@shared/messages';

function activityEvent(
  activityId: string,
  type: string,
  payload: Record<string, unknown>,
  createdAt = '2026-07-04T14:00:00.000Z',
): AgentActivityFeedPage['events'][number] {
  return { activityId, createdAt, payload, type };
}

describe('buildActivityFeed', () => {
  it('renders attention suggestion traces as centered system events', () => {
    const page: AgentActivityFeedPage = {
      events: [{
        activityId: 'actv_attention_1',
        createdAt: '2026-07-04T14:00:00.000Z',
        payload: {
          channelId: 'C123',
          channelName: 'build',
          platform: 'slack',
          suggestion: 'Attention suggestion: run `anima subscription mute --channel C123`.',
          threadTs: '1770000010.000001',
        },
        type: 'anima.attention.suggestion',
      }],
      nextCursor: null,
    };

    const [item] = buildActivityFeed(page);

    expect(item?.kind).toBe('system-event');
    if (item?.kind !== 'system-event') throw new Error('expected system event');
    expect(item.eventKind).toBe('attention');
    expect(item.label).toBe('Attention');
    expect(item.body).toBe('#build · thread suggestion attached');
    expect(item.meta).toBe('Attention suggestion: run `anima subscription mute --channel C123`.');
    expect(item.timestamp).toBe('2026-07-04T14:00:00.000Z');
  });

  // Drift fix: feishu.message.update / feishu.reaction / feishu.file.send are
  // real emitted effects but the old inline string sets only recognized them
  // via the `tool` field — an effect-only payload was silently dropped. The
  // shared classifier recognizes them by effect.
  it('classifies effect-only feishu update/reaction/file effects (drift fix)', () => {
    const page: AgentActivityFeedPage = {
      events: [
        activityEvent('actv_f_update', 'external.effect.completed', {
          channel: 'oc_123',
          channelKind: 'group',
          effect: 'feishu.message.update',
          platform: 'feishu',
          text: 'edited body',
        }, '2026-07-04T14:00:01.000Z'),
        activityEvent('actv_f_react', 'external.effect.completed', {
          action: 'added',
          channel: 'oc_123',
          channelKind: 'group',
          effect: 'feishu.reaction',
          name: 'THUMBSUP',
          platform: 'feishu',
        }, '2026-07-04T14:00:02.000Z'),
        activityEvent('actv_f_file', 'external.effect.completed', {
          caption: 'the report',
          channel: 'oc_123',
          channelKind: 'group',
          effect: 'feishu.file.send',
          platform: 'feishu',
          uploads: [{ fileId: 'f1', filename: 'report.pdf', mimetype: 'application/pdf', sizeBytes: 10 }],
        }, '2026-07-04T14:00:03.000Z'),
      ],
      nextCursor: null,
    };

    const items = buildActivityFeed(page);

    expect(items.map((i) => i.kind)).toEqual(['message-out', 'reaction-out', 'file-out']);
    const [update, reaction, file] = items;
    if (update?.kind !== 'message-out') throw new Error('expected message-out');
    expect(update.isEdit).toBe(true);
    expect(update.text).toBe('edited body');
    expect(update.surface).toEqual({ kind: 'channel', label: 'Feishu group' });
    if (reaction?.kind !== 'reaction-out') throw new Error('expected reaction-out');
    expect(reaction.action).toBe('added');
    expect(reaction.emoji).toBe('THUMBSUP');
    if (file?.kind !== 'file-out') throw new Error('expected file-out');
    expect(file.caption).toBe('the report');
    expect(file.files).toEqual([
      { fileId: 'f1', filename: 'report.pdf', mimetype: 'application/pdf', sizeBytes: 10 },
    ]);
  });

  it('suppresses anima.reminder.fire completions', () => {
    const page: AgentActivityFeedPage = {
      events: [
        activityEvent('actv_rem', 'tool.call.completed', { tool: 'anima.reminder.fire' }),
      ],
      nextCursor: null,
    };
    expect(buildActivityFeed(page)).toEqual([]);
  });
});

describe('buildMessageFeed', () => {
  it('inbound items carry the ledger record fields the Slack timeline reads', () => {
    const message: AgentMessageRecord = {
      actorAvatarUrl: 'https://avatars.example/ada_72.png',
      actorDisplayName: 'Ada',
      actorHandle: '@ada',
      actorUserId: 'U123',
      channelId: 'C123',
      channelName: 'build',
      direction: 'in',
      files: [{ fileId: 'F1', filename: 'spec.pdf', mimetype: 'application/pdf', sizeBytes: 42 }],
      kind: 'message',
      messageId: 'msg_1',
      messageTs: '1770000010.000100',
      platform: 'slack',
      previews: [{ platform: 'slack', text: 'quoted message', type: 'message_unfurl' }],
      source: { id: 'ib_1', kind: 'inbox' },
      text: 'hello there',
      threadTs: '1770000010.000001',
      timestamp: '2026-07-04T14:00:00.000Z',
    };
    const page: AgentMessageHistoryPage = { entries: [message] };

    const [item] = buildMessageFeed(page);

    expect(item?.kind).toBe('message-in');
    if (item?.kind !== 'message-in') throw new Error('expected message-in');
    // The record rides along whole — author identity, body, attachments,
    // previews all come straight off it in SlackTimeline.
    expect(item.message).toBe(message);
    expect(item.message.actorDisplayName).toBe('Ada');
    expect(item.message.actorHandle).toBe('@ada');
    expect(item.message.actorUserId).toBe('U123');
    expect(item.message.text).toBe('hello there');
    expect(item.message.files).toHaveLength(1);
    expect(item.message.previews).toHaveLength(1);
    expect(item.avatarUrl).toBe('https://avatars.example/ada_72.png');
    expect(item.timestamp).toBe('2026-07-04T14:00:00.000Z');
    expect(item.surface).toEqual({
      channelId: 'C123',
      kind: 'thread',
      label: '#build · thread',
    });
  });

  it('maps reminder and onboarding wakes to system-event rows', () => {
    const base = {
      direction: 'in' as const,
      messageId: 'msg_r',
      platform: 'slack',
      text: '',
      timestamp: '2026-07-04T15:00:00.000Z',
    };
    const page: AgentMessageHistoryPage = {
      entries: [
        {
          ...base,
          kind: 'reminder',
          reminderId: 'rem_1',
          reminderTitle: 'Ship the report',
          source: { id: 'ib_r', kind: 'inbox' },
        },
        {
          ...base,
          kind: 'onboarding',
          messageId: 'msg_o',
          source: { id: 'agent-onboarding:xyz', kind: 'inbox' },
          text: 'Welcome aboard',
          timestamp: '2026-07-04T15:01:00.000Z',
        },
      ],
    };

    const items = buildMessageFeed(page);

    expect(items.map((i) => i.kind)).toEqual(['system-event', 'system-event']);
    const [reminder, onboarding] = items;
    if (reminder?.kind !== 'system-event') throw new Error('expected system event');
    expect(reminder.eventKind).toBe('reminder');
    expect(reminder.body).toBe('Ship the report');
    if (onboarding?.kind !== 'system-event') throw new Error('expected system event');
    expect(onboarding.eventKind).toBe('onboarding');
    expect(onboarding.body).toBe('Welcome aboard');
  });

  it('projects outbound records to flat message/file/reaction rows', () => {
    const base = {
      channelId: 'C123',
      channelName: 'build',
      direction: 'out' as const,
      platform: 'slack',
      source: { id: 'actv_1', kind: 'activity' as const },
    };
    const page: AgentMessageHistoryPage = {
      entries: [
        {
          ...base,
          isEdit: true,
          kind: 'message',
          messageId: 'msg_out',
          permalink: 'https://slack.example/p1',
          text: 'agent reply',
          timestamp: '2026-07-04T16:00:00.000Z',
        },
        {
          ...base,
          kind: 'reaction',
          messageId: 'msg_react',
          reaction: { action: 'added', name: 'eyes' },
          text: '',
          timestamp: '2026-07-04T16:01:00.000Z',
        },
      ],
    };

    const [messageOut, reactionOut] = buildMessageFeed(page);

    if (messageOut?.kind !== 'message-out') throw new Error('expected message-out');
    expect(messageOut.text).toBe('agent reply');
    expect(messageOut.isEdit).toBe(true);
    expect(messageOut.permalink).toBe('https://slack.example/p1');
    expect(messageOut.surface).toEqual({ channelId: 'C123', kind: 'channel', label: '#build' });
    if (reactionOut?.kind !== 'reaction-out') throw new Error('expected reaction-out');
    expect(reactionOut.emoji).toBe('eyes');
    expect(reactionOut.surface).toEqual({ channelId: 'C123', kind: 'channel', label: '#build' });
  });
});
