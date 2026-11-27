import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { buildActivityFeed, buildMessageFeed } from '@/lib/activity-feed';
import { buildActivityAuthorResolvers } from '@/lib/activity-authors';
import { groupByAuthor } from '@/lib/message-model';
import type { AgentMessageRecord } from '@shared/messages';
import { MessageGroupRow, messageGroupRowPropsEqual } from './SlackTimeline';
import { FileOutRow, MessageOutRow } from '../activity/MessageRows';

const issueUrl = 'https://linear.app/anima/issue/ANI-21';
const record: AgentMessageRecord = {
  direction: 'in', kind: 'message', messageId: 'in', platform: 'linear', channelKind: 'linear_issue',
  channelId: 'issue', threadTs: 'session', issueKey: 'ANI-21', issueTitle: 'Show the issue', permalink: issueUrl,
  actor: 'Requester', source: { id: 'in', kind: 'inbox' }, text: 'Please implement this.', timestamp: '2026-11-04T00:00:00Z',
};

describe('Linear issue links', () => {
  it('groups a message and a write action on the same issue even when only the message knows the title', () => {
    const messages = buildMessageFeed({ entries: [{ ...record, direction: 'out' }] });
    const actions = buildActivityFeed({ events: [{ activityId: 'write', type: 'tool.call.completed', createdAt: record.timestamp,
      payload: { tool: 'anima.linear.api', operation: 'mutation', fields: ['issueUpdate'], issueKey: 'ANI-21' } }] });
    const { resolveAuthor, resolveSurface } = buildActivityAuthorResolvers({ agent: undefined, agentId: 'scout' });
    const groups = groupByAuthor([...messages, ...actions], resolveAuthor, resolveSurface);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.surfaceKey).toBe('linear:ANI-21');
    expect(groups[0]!.items.map(({ item }) => item.kind)).toEqual(['message-out', 'linear-api']);
  });
  it('groups an issue by its key despite a new title or a different thread', () => {
    const feed = buildMessageFeed({ entries: [record, { ...record, messageId: 'second', issueTitle: 'Renamed', threadTs: 'comment-root' },
      { ...record, messageId: 'third', issueKey: 'ANI-22' }] });
    const { resolveAuthor, resolveSurface } = buildActivityAuthorResolvers({ agent: undefined, agentId: 'scout' });
    const groups = groupByAuthor(feed, resolveAuthor, resolveSurface);
    expect(groups.map((g) => [g.surfaceKey, g.items.length])).toEqual([['linear:ANI-21', 2], ['linear:ANI-22', 1]]);
  });
  it('opens the issue from the Activity chip and updates its link when the URL changes', () => {
    const feed = buildMessageFeed({ entries: [record] });
    const { resolveAuthor, resolveSurface } = buildActivityAuthorResolvers({ agent: undefined, agentId: 'scout' });
    const group = groupByAuthor(feed, resolveAuthor, resolveSurface)[0]!;
    render(<MemoryRouter><MessageGroupRow group={group} agentId="scout" /></MemoryRouter>);
    const link = screen.getByRole('link', { name: 'Open in Linear: ANI-21 · Show the issue · thread' });
    expect(link.getAttribute('href')).toBe(issueUrl);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('title')).toBe('Open in Linear: ANI-21 · Show the issue · thread');
    expect(link.getAttribute('title')).not.toContain('—');
    expect(messageGroupRowPropsEqual({ group, agentId: 'scout' }, {
      group: { ...group, surface: { ...group.surface!, href: `${issueUrl}/renamed` } }, agentId: 'scout',
    })).toBe(false);
  });

  it('formats edited DM titles grammatically and omits generic DM recipients', () => {
    const base = { kind: 'message-out' as const, text: 'hello', timestamp: '2026-11-04T00:00:00Z' };
    const { rerender } = render(
      <MessageOutRow item={{ ...base, isEdit: true, surface: { kind: 'dm', label: '@alice' } }} time="08:00" />,
    );
    expect(screen.getByText('Edited DM to alice')).toBeTruthy();

    rerender(
      <MessageOutRow item={{ ...base, isEdit: true, surface: { kind: 'dm', label: 'Feishu DM' } }} time="08:00" />,
    );
    expect(screen.getByText('Edited message')).toBeTruthy();

    rerender(
      <MessageOutRow item={{ ...base, isEdit: true, surface: { kind: 'thread', label: '#ops' } }} time="08:00" />,
    );
    expect(screen.getByText('Edited message in thread')).toBeTruthy();

    rerender(
      <MessageOutRow item={{ ...base, isEdit: false, surface: { kind: 'dm', label: 'Feishu DM' } }} time="08:00" />,
    );
    expect(screen.getByText('Replied')).toBeTruthy();
    expect(screen.queryByText(/Replied to Feishu DM/)).toBeNull();

    rerender(
      <MessageOutRow item={{ ...base, isEdit: false, surface: { kind: 'dm', label: 'DM' } }} time="08:00" />,
    );
    expect(screen.getByText('Replied')).toBeTruthy();

    rerender(
      <FileOutRow
        item={{
          kind: 'file-out',
          caption: '',
          files: [{ fileId: 'f1', filename: 'a.pdf', mimetype: 'application/pdf', sizeBytes: 12 }],
          surface: { kind: 'dm', label: 'Feishu DM' },
          timestamp: '2026-11-04T00:00:00Z',
        }}
        time="08:00"
        agentId="scout"
      />,
    );
    expect(screen.getByText('Sent 1 file')).toBeTruthy();
    expect(screen.queryByText(/Sent 1 file to Feishu DM/)).toBeNull();
  });

  it.each(['linear', 'slack', 'feishu', undefined])('names the platform on the outbound link: %s', (platform) => {
    const [item] = buildMessageFeed({ entries: [{ ...record, direction: 'out', platform }] });
    if (item?.kind !== 'message-out') throw new Error('expected outgoing message');
    render(<MessageOutRow item={item} time="08:00" />);
    const name = platform === 'linear' ? 'Linear' : platform === 'feishu' ? 'Feishu' : 'Slack';
    const link = screen.getByRole('link', { name: `Open in ${name}` });
    expect(link.getAttribute('href')).toBe(issueUrl);
    expect(link.getAttribute('title')).toBe(`Open in ${name}`);
  });
});
