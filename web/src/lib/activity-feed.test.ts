import { describe, expect, it } from 'vitest';

import { buildActivityFeed, buildMessageFeed, type ActivityFeedItem } from './activity-feed';
import { buildActivityConversationItems, buildStepItems } from './activity-timeline';
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
          suggestion: 'Anima note: you\'ve been reading channel C123 without posting. If it is not relevant, mute it with `anima subscription mute --channel C123`.',
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
    expect(item.meta).toBe('Anima note: you\'ve been reading channel C123 without posting. If it is not relevant, mute it with `anima subscription mute --channel C123`.');
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

  it('projects main-loop outbound effects exactly', () => {
    const message = activityEvent('actv_message', 'external.effect.completed', {
      channel: 'C123',
      channelName: 'build',
      effect: 'slack.message.update',
      permalink: 'https://slack.example/p-message',
      platform: 'slack',
      text: 'edited body',
      threadTs: '1770000010.000001',
    }, '2026-07-04T14:00:01.000Z');
    const file = activityEvent('actv_file', 'external.effect.completed', {
      caption: 'the report',
      channel: 'C123',
      channelDisplayName: '#build',
      effect: 'slack.file.send',
      permalink: 'https://slack.example/p-file',
      platform: 'slack',
      uploads: [
        {
          fileId: 'F1',
          filename: 'report.pdf',
          mimetype: 'application/pdf',
          permalink: 'https://slack.example/file',
          sizeBytes: 10,
          thumb360: 'https://slack.example/thumb360',
          thumb720: 'https://slack.example/thumb720',
        },
      ],
    }, '2026-07-04T14:00:02.000Z');
    const reaction = activityEvent('actv_reaction', 'external.effect.completed', {
      action: 'removed',
      channel: 'D123',
      channelDisplayName: 'DM with ada',
      channelKind: 'dm',
      effect: 'slack.reaction',
      name: 'eyes',
      noop: true,
      platform: 'slack',
    }, '2026-07-04T14:00:03.000Z');
    const ask = activityEvent('actv_ask', 'external.effect.completed', {
      channel: 'C123',
      effect: 'slack.ask.post',
      platform: 'slack',
      question: 'Ship it?',
      tool: 'anima.ask',
    }, '2026-07-04T14:00:04.000Z');
    const page: AgentActivityFeedPage = {
      events: [message, file, reaction, ask],
      nextCursor: null,
    };

    expect(buildActivityFeed(page)).toEqual([
      {
        kind: 'message-out',
        text: 'edited body',
        platform: 'slack',
        permalink: 'https://slack.example/p-message',
        timestamp: '2026-07-04T14:00:01.000Z',
        surface: { channelId: 'C123', kind: 'thread', label: '#build' },
        isEdit: true,
      },
      {
        kind: 'file-out',
        caption: 'the report',
        platform: 'slack',
        files: [
          {
            fileId: 'F1',
            filename: 'report.pdf',
            mimetype: 'application/pdf',
            permalink: 'https://slack.example/file',
            sizeBytes: 10,
            thumb360: 'https://slack.example/thumb360',
            thumb720: 'https://slack.example/thumb720',
          },
        ],
        permalink: 'https://slack.example/p-file',
        timestamp: '2026-07-04T14:00:02.000Z',
        surface: { channelId: 'C123', kind: 'channel', label: '#build' },
      },
      {
        kind: 'reaction-out',
        action: 'removed',
        emoji: 'eyes',
        noop: true,
        timestamp: '2026-07-04T14:00:03.000Z',
        surface: { channelId: 'D123', kind: 'dm', label: '@ada' },
      },
      {
        kind: 'step',
        activity: ask,
        timestamp: '2026-07-04T14:00:04.000Z',
      },
    ]);
  });

  // `step` is the only union member carrying `activity`; narrowing keeps the
  // assertion honest about which rows survived the collapse.
  const webSearchSteps = (items: ActivityFeedItem[]): string[] =>
    items
      .filter((item) => item.kind === 'step')
      .map((item) => item.activity.activityId)
      .filter((id) => id.startsWith('actv_ws_'));

  // Newer Codex app-server builds emit `item/started` for a webSearch before the
  // query is known, then a detailed row with the same providerToolId once
  // `web_search_end` lands. Two rows, one search. buildActivityFeed drops the
  // blank one - but only when a detailed sibling actually exists.
  it('collapses a blank Codex webSearch row into its detailed sibling', () => {
    const blank = activityEvent('actv_ws_blank', 'tool.call.started', {
      providerToolId: 'ws_1',
      providerToolName: 'webSearch',
    }, '2026-07-04T14:00:00.000Z');
    const detailed = activityEvent('actv_ws_detailed', 'tool.call.started', {
      providerToolId: 'ws_1',
      providerToolName: 'webSearch',
      query: 'anima runtime health',
    }, '2026-07-04T14:00:01.000Z');

    const page: AgentActivityFeedPage = { events: [blank, detailed], nextCursor: null };
    const searches = webSearchSteps(buildActivityFeed(page));

    expect(searches).toEqual(['actv_ws_detailed']);
  });

  it('keeps a blank Codex webSearch row when no detailed sibling arrives', () => {
    const blank = activityEvent('actv_ws_blank', 'tool.call.started', {
      providerToolId: 'ws_1',
      providerToolName: 'webSearch',
    });
    // Same shape, different search: its providerToolId must not rescue the blank one.
    const otherDetailed = activityEvent('actv_ws_other', 'tool.call.started', {
      providerToolId: 'ws_2',
      providerToolName: 'webSearch',
      query: 'unrelated',
    }, '2026-07-04T14:00:01.000Z');

    const page: AgentActivityFeedPage = { events: [blank, otherDetailed], nextCursor: null };
    const searches = webSearchSteps(buildActivityFeed(page));

    expect(searches).toEqual(['actv_ws_blank', 'actv_ws_other']);
  });

  it('projects child-loop outbound effects exactly', () => {
    const parent = activityEvent('actv_parent', 'tool.call.started', {
      providerToolId: 'toolu_parent',
      providerToolName: 'Task',
    }, '2026-07-04T14:00:00.000Z');
    const message = activityEvent('actv_child_message', 'external.effect.completed', {
      channel: 'C123',
      channelName: 'build',
      effect: 'slack.message.send',
      parentToolCallId: 'toolu_parent',
      platform: 'slack',
      subRunId: 'child-1',
      text: 'child reply',
    }, '2026-07-04T14:00:01.000Z');
    const file = activityEvent('actv_child_file', 'external.effect.completed', {
      caption: 'child report',
      channel: 'oc_123',
      channelKind: 'group',
      effect: 'feishu.file.send',
      parentToolCallId: 'toolu_parent',
      platform: 'feishu',
      subRunId: 'child-1',
      uploads: [{ fileId: 'f1', filename: 'child.pdf', mimetype: 'application/pdf', sizeBytes: 11 }],
    }, '2026-07-04T14:00:02.000Z');
    const reaction = activityEvent('actv_child_reaction', 'external.effect.completed', {
      action: 'added',
      channel: 'oc_123',
      channelKind: 'group',
      effect: 'feishu.reaction',
      name: 'THUMBSUP',
      parentToolCallId: 'toolu_parent',
      platform: 'feishu',
      subRunId: 'child-1',
    }, '2026-07-04T14:00:03.000Z');
    const ask = activityEvent('actv_child_ask', 'external.effect.completed', {
      channel: 'C123',
      effect: 'slack.ask.post',
      parentToolCallId: 'toolu_parent',
      platform: 'slack',
      question: 'Child asks?',
      subRunId: 'child-1',
      tool: 'anima.ask',
    }, '2026-07-04T14:00:04.000Z');
    const page: AgentActivityFeedPage = {
      events: [parent, message, file, reaction, ask],
      nextCursor: null,
    };

    expect(buildActivityFeed(page)).toEqual([
      {
        kind: 'step',
        activity: parent,
        timestamp: '2026-07-04T14:00:00.000Z',
        subagentStreams: [
          {
            subRunId: 'child-1',
            depth: 1,
            items: [
              {
                kind: 'message-out',
                text: 'child reply',
                platform: 'slack',
                timestamp: '2026-07-04T14:00:01.000Z',
                surface: { channelId: 'C123', kind: 'channel', label: '#build' },
                isEdit: false,
              },
              {
                kind: 'file-out',
                caption: 'child report',
                platform: 'feishu',
                files: [
                  { fileId: 'f1', filename: 'child.pdf', mimetype: 'application/pdf', sizeBytes: 11 },
                ],
                timestamp: '2026-07-04T14:00:02.000Z',
                surface: { kind: 'channel', label: 'Feishu group' },
              },
              {
                kind: 'reaction-out',
                action: 'added',
                emoji: 'THUMBSUP',
                noop: false,
                timestamp: '2026-07-04T14:00:03.000Z',
                surface: { kind: 'channel', label: 'Feishu group' },
              },
              {
                kind: 'step',
                activity: ask,
                timestamp: '2026-07-04T14:00:04.000Z',
              },
            ],
          },
        ],
      },
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

  it('projects status:held as a neutral system row for all three hold tools (main + child)', () => {
    const heldMessage = activityEvent(
      'actv_held_msg',
      'tool.call.completed',
      {
        advancedToOrdinal: 12,
        deltaCount: 1,
        status: 'held',
        surfaceId: 'slack:T:C:main',
        tool: 'anima.message.send',
      },
      '2026-07-04T14:00:01.000Z',
    );
    const heldAsk = activityEvent(
      'actv_held_ask',
      'tool.call.completed',
      {
        deltaCount: 2,
        status: 'held',
        tool: 'anima.ask',
      },
      '2026-07-04T14:00:02.000Z',
    );
    const heldFile = activityEvent(
      'actv_held_file',
      'tool.call.completed',
      {
        deltaCount: 1,
        status: 'held',
        tool: 'anima.file.send',
      },
      '2026-07-04T14:00:03.000Z',
    );
    const parent = activityEvent(
      'actv_parent',
      'tool.call.started',
      { providerToolId: 'toolu_parent', providerToolName: 'Agent' },
      '2026-07-04T14:00:00.000Z',
    );
    const heldChild = activityEvent(
      'actv_held_child',
      'tool.call.completed',
      {
        deltaCount: 3,
        parentToolCallId: 'toolu_parent',
        status: 'held',
        subRunId: 'child-1',
        tool: 'anima.message.send',
      },
      '2026-07-04T14:00:04.000Z',
    );

    const items = buildActivityFeed({
      events: [heldMessage, heldAsk, heldFile, parent, heldChild],
      nextCursor: null,
    });

    expect(items.map((i) => i.kind)).toEqual([
      'step',
      'system-event',
      'system-event',
      'system-event',
    ]);
    const heldRows = items.filter(
      (i): i is Extract<ActivityFeedItem, { kind: 'system-event' }> =>
        i.kind === 'system-event',
    );
    expect(heldRows.every((row) => row.eventKind === 'held')).toBe(true);
    expect(heldRows.map((row) => row.body)).toEqual([
      'Send held: 1 new message arrived while composing; nothing was sent.',
      'Send held: 2 new messages arrived while composing; nothing was sent.',
      // File hold: delta is still conversation messages that arrived.
      'Send held: 1 new message arrived while composing; nothing was sent.',
    ]);
    expect(heldRows.every((row) => row.label === 'Send held')).toBe(true);
    // Never misrender as outbound message/file/ask rows.
    expect(items.some((i) => i.kind === 'message-out' || i.kind === 'file-out')).toBe(false);

    const parentStep = items.find((i) => i.kind === 'step');
    if (parentStep?.kind !== 'step') throw new Error('expected parent step');
    expect(parentStep.subagentStreams?.[0]?.items).toEqual([
      {
        kind: 'system-event',
        eventKind: 'held',
        label: 'Send held',
        body: 'Send held: 3 new messages arrived while composing; nothing was sent.',
        timestamp: '2026-07-04T14:00:04.000Z',
      },
    ]);
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
    // The raw onboarding prompt is collapsed to a short fixed label.
    expect(onboarding.body).toBe('Agent onboarding started');
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

it('Linear input and reply remain Linear session surfaces without Slack links', () => {
  const pages: AgentMessageHistoryPage[] = [{ nextCursor: null, entries: [
    { direction: 'in', kind: 'message', messageId: 'linear-in', platform: 'linear', channelId: 'session-uuid', threadTs: 'session-uuid', source: { id: 'linear:installation:created:session', kind: 'inbox' }, text: 'Request', timestamp: '2026-10-10T06:00:00Z' },
    { direction: 'out', kind: 'message', messageId: 'linear-out', platform: 'linear', channelId: 'session-uuid', threadTs: 'session-uuid', source: { id: 'activity', kind: 'activity' }, text: 'Response', timestamp: '2026-10-10T06:01:00Z' },
  ] }];
  const result = buildMessageFeed(pages[0]!);
  expect(result).toHaveLength(2);
  expect(result.every((row) => (row.kind === 'message-in' || row.kind === 'message-out') && row.surface?.label === 'Linear session')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('slack.com');
});

it('labels ordinary Linear issue and workspace activity separately from work sessions', () => {
  for (const [channelKind, threadTs, label, kind] of [
    ['linear_issue', 'root-comment', 'Linear issue', 'thread'],
    ['linear_issue', '', 'Linear issue', 'channel'],
    ['linear_workspace', '', 'Linear workspace', 'channel'],
    ['linear_session', 'session-id', 'Linear session', 'thread'],
  ] as const) {
    const entries: AgentMessageRecord[] = ['in', 'out'].map((direction) => ({
      direction: direction as 'in' | 'out', kind: 'message', messageId: `${channelKind}-${direction}`,
      platform: 'linear', channelKind, channelId: 'linear-resource', threadTs,
      source: { id: `${channelKind}-${direction}`, kind: direction === 'in' ? 'inbox' : 'activity' },
      text: 'Synthetic discussion', timestamp: '2026-10-23T00:00:00Z',
    }));
    const messages = buildMessageFeed({ entries, nextCursor: null });
    expect(messages).toHaveLength(2);
    for (const row of messages) {
      if (row.kind !== 'message-in' && row.kind !== 'message-out') throw new Error('expected message');
      expect(row.surface).toEqual({ kind, label });
    }
    const [outbound] = buildActivityFeed({ nextCursor: null, events: [activityEvent('linear-comment', 'external.effect.completed', {
      platform: 'linear', channelKind, channel: 'linear-resource', threadTs, text: 'Synthetic discussion', effect: 'linear.comment.create',
    })] });
    if (outbound?.kind !== 'message-out') throw new Error('expected outgoing activity');
    expect(outbound.surface).toEqual({ kind, label });
  }
});

describe('Linear API writes', () => {
  const api = (id: string, type: string, extra: Record<string, unknown>, createdAt = '2026-11-04T01:00:00.000Z') =>
    activityEvent(id, type, { tool: 'anima.linear.api', platform: 'linear', callId: id, ...extra }, createdAt);

  it('render completed writes as outbound actions with the issue as their place', () => {
    const feed = buildActivityFeed({ nextCursor: null, events: [
      api('w1-started', 'tool.call.started', { operation: 'mutation', fields: ['issueUpdate'], issueKey: 'ANI-5', status: 'started' }),
      api('w1', 'tool.call.completed', { operation: 'mutation', fields: ['issueUpdate'], issueKey: 'ANI-5', status: 'completed', outcome: 'request_completed' }),
      api('w2', 'tool.call.completed', { operation: 'mutation', fields: ['commentCreate'], issueKey: 'ANI-5', outcome: 'request_completed' }),
      api('w3', 'tool.call.completed', { operation: 'mutation', fields: ['agentSessionCreateOnIssue'], issueKey: 'ANI-23', outcome: 'request_completed' }),
      api('w4', 'tool.call.completed', { operation: 'mutation', fields: ['issueCreate'], issueKey: 'ANI-5', outcome: 'request_completed' }),
    ] });
    expect(feed).toEqual([
      { kind: 'action-out', label: 'Update ANI-5', timestamp: '2026-11-04T01:00:00.000Z', surface: { kind: 'channel', label: 'ANI-5', issueKey: 'ANI-5' } },
      { kind: 'action-out', label: 'Comment on ANI-5', timestamp: '2026-11-04T01:00:00.000Z', surface: { kind: 'channel', label: 'ANI-5', issueKey: 'ANI-5' } },
      { kind: 'action-out', label: 'Start work session on ANI-23', timestamp: '2026-11-04T01:00:00.000Z', surface: { kind: 'channel', label: 'ANI-23', issueKey: 'ANI-23' } },
      // A key in a create request is the parent, not the place.
      { kind: 'action-out', label: 'Create issue', timestamp: '2026-11-04T01:00:00.000Z', surface: { kind: 'channel', label: 'Linear' } },
    ]);
  });

  it('keep reads and failed writes as steps', () => {
    const events = [
      api('r1', 'tool.call.completed', { operation: 'query', fields: ['issue'], issueKey: 'ANI-5', outcome: 'request_completed' }),
      api('f1', 'tool.call.failed', { operation: 'mutation', fields: ['issueUpdate'], issueKey: 'ANI-5', outcome: 'unknown' }),
    ];
    const feed = buildActivityFeed({ nextCursor: null, events });
    expect(feed.map((item) => item.kind)).toEqual(['step', 'step']);
    expect(buildActivityConversationItems({ events })).toEqual([]);
    expect(buildStepItems({ events }).map((step) => step.activity.activityId)).toEqual(['r1', 'f1']);
  });

  it('rank with outbound messages when they share an instant with a step', () => {
    const feed = buildActivityFeed({ nextCursor: null, events: [
      api('r1', 'tool.call.completed', { operation: 'query', fields: ['issue'] }),
      api('w1', 'tool.call.completed', { operation: 'mutation', fields: ['issueUpdate'], issueKey: 'ANI-5' }),
    ] });
    expect(feed.map((item) => item.kind)).toEqual(['action-out', 'step']);
  });

  it('move writes out of the folded steps and into the conversation', () => {
    const events = [
      api('r1', 'tool.call.completed', { operation: 'query', fields: ['issue'], issueKey: 'ANI-5' }, '2026-11-04T01:00:00.000Z'),
      api('w1', 'tool.call.completed', { operation: 'mutation', fields: ['issueUpdate'], issueKey: 'ANI-5' }, '2026-11-04T01:00:01.000Z'),
    ];
    expect(buildStepItems({ events }).map((step) => step.activity.activityId)).toEqual(['r1']);
    expect(buildActivityConversationItems({ events })).toMatchObject([{ kind: 'action-out', label: 'Update ANI-5' }]);
  });

  it('carry nothing from the request beyond the action label and issue key', () => {
    const [item] = buildActivityFeed({ nextCursor: null, events: [api('w1', 'tool.call.completed', {
      operation: 'mutation', fields: ['issueUpdate'], issueKey: 'ANI-5', outcome: 'request_completed',
      query: 'PRIVATE_QUERY', variables: { input: 'PRIVATE_VARIABLE' }, result: 'PRIVATE_RESULT', error: 'PRIVATE_ERROR', text: 'PRIVATE_TEXT',
      channel: 'PRIVATE_CHANNEL', threadTs: 'PRIVATE_THREAD', permalink: 'https://linear.app/PRIVATE_LINK',
    })] });
    expect(item).toEqual({ kind: 'action-out', label: 'Update ANI-5', timestamp: '2026-11-04T01:00:00.000Z', surface: { kind: 'channel', label: 'ANI-5', issueKey: 'ANI-5' } });
    expect(JSON.stringify(item)).not.toContain('PRIVATE_');
  });

  it('read records from before field names and issue keys were kept', () => {
    const feed = buildActivityFeed({ nextCursor: null, events: [
      api('old-write', 'tool.call.completed', { operation: 'mutation' }, '2026-11-04T01:00:00.000Z'),
      api('old-read', 'tool.call.completed', { operation: 'query' }, '2026-11-04T01:00:01.000Z'),
      api('odd-write', 'tool.call.completed', { operation: 'mutation', fields: ['PRIVATE_FIELD'], issueKey: 'ANI-5' }, '2026-11-04T01:00:02.000Z'),
    ] });
    expect(feed).toMatchObject([
      { kind: 'action-out', label: 'Change Linear data', surface: { kind: 'channel', label: 'Linear' } },
      { kind: 'step' },
      { kind: 'action-out', label: 'Change Linear data', surface: { kind: 'channel', label: 'Linear' } },
    ]);
    expect(JSON.stringify(feed[2])).not.toContain('PRIVATE_');
  });

  it('sit beside Linear replies, comments and session starts, which are already outbound messages', () => {
    const feed = buildActivityFeed({ nextCursor: null, events: [
      activityEvent('reply', 'tool.call.completed', { tool: 'anima.linear.reply', platform: 'linear', channelKind: 'linear_session', channel: 'session-uuid', threadTs: 'session-uuid', text: 'Done' }, '2026-11-04T01:00:00.000Z'),
      activityEvent('comment', 'tool.call.completed', { tool: 'anima.linear.comment', platform: 'linear', channelKind: 'linear_issue', channel: 'issue-uuid', text: 'Looks good' }, '2026-11-04T01:00:01.000Z'),
      activityEvent('start', 'tool.call.completed', { tool: 'anima.linear.start', platform: 'linear', channelKind: 'linear_session', text: 'Taking this' }, '2026-11-04T01:00:02.000Z'),
      api('write', 'tool.call.completed', { operation: 'mutation', fields: ['issueUpdate'], issueKey: 'ANI-5' }, '2026-11-04T01:00:03.000Z'),
    ] });
    expect(feed.map((item) => item.kind)).toEqual(['message-out', 'message-out', 'message-out', 'action-out']);
    expect(feed.map((item) => ('surface' in item ? item.surface.label : ''))).toEqual(['Linear session', 'Linear issue', 'Linear session', 'ANI-5']);
  });
});

it.each([undefined, 'Show the issue'])('names and links Linear issue chips with title %s', (issueTitle) => {
  const issueKey = 'ANI-21', permalink = 'https://linear.app/anima/issue/ANI-21';
  const label = issueTitle ? `${issueKey} · ${issueTitle}` : issueKey;
  for (const threadTs of ['session-id', 'comment-root', undefined]) {
    const entries: AgentMessageRecord[] = ['in', 'out'].map((direction) => ({
      direction: direction as 'in' | 'out', kind: 'message', messageId: `${direction}-${threadTs}`,
      platform: 'linear', channelKind: 'linear_issue', channelId: 'issue-id', threadTs, issueKey, issueTitle, permalink,
      source: { id: `${direction}-${threadTs}`, kind: direction === 'in' ? 'inbox' : 'activity' },
      text: 'A message', timestamp: '2026-11-04T00:00:00Z',
    }));
    const rows = buildMessageFeed({ entries });
    for (const row of rows) {
      if (row.kind !== 'message-in' && row.kind !== 'message-out') throw new Error('expected message');
      expect(row.surface).toEqual({ kind: threadTs ? 'thread' : 'channel',
        label: row.kind === 'message-in' && threadTs ? `${label} · thread` : label, issueKey, href: permalink, linkTitle: 'Open in Linear' });
    }
    for (const effect of ['linear.activity.create', 'linear.comment.create', 'linear.session.start']) {
      const [row] = buildActivityFeed({ events: [activityEvent(effect, 'external.effect.completed', {
        platform: 'linear', channelKind: 'linear_issue', channel: 'issue-id', threadTs, issueKey, issueTitle, permalink, text: 'A reply', effect,
      })] });
      if (row?.kind !== 'message-out') throw new Error('expected outgoing activity');
      expect(row.platform).toBe('linear');
      expect(row.surface).toEqual({ kind: threadTs ? 'thread' : 'channel', label, issueKey, href: permalink, linkTitle: 'Open in Linear' });
    }
  }
});
