import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ActivityFeedItem } from '@/lib/activity-feed';
import { buildActivityFeed, buildMessageFeed } from '@/lib/activity-feed';
import type { MessageGroup } from '@/lib/message-model';
import { LinearActivityGroup } from './LinearActivityGroup';

const timestamp = '2026-11-04T09:00:00Z';
const surface = { kind: 'channel' as const, platform: 'linear', issueKey: 'ANI-30', issueTitle: 'Clear activity', label: 'ANI-30', href: 'https://linear.app/example/issue/ANI-30' };
const group = (items: ActivityFeedItem[]): MessageGroup => ({
  author: { key: 'agent', name: 'Ada', initial: 'A', isAgent: true }, surfaceKey: 'linear:ANI-30', surface, startTs: timestamp,
  items: items.map((item, index) => ({ item, key: String(index) })),
});

it('shows task identity and separates progress from a result using recorded types', () => {
  const items = buildMessageFeed({ entries: ['thought', 'response'].map((linearKind, index) => ({
    direction: 'out' as const, kind: 'message' as const, messageId: String(index), text: index ? 'The result' : 'The body says Done but this is progress',
    linearKind: linearKind as 'thought' | 'response', platform: 'linear', issueKey: 'ANI-30', issueTitle: 'Clear activity', timestamp,
    source: { kind: 'activity' as const, id: String(index) },
  })) });
  render(<LinearActivityGroup group={group(items)} heading={surface} agentId="ada" agentName="Ada" />);
  expect(screen.getByRole('link', { name: 'Open ANI-30 in Linear' }).getAttribute('href')).toBe(surface.href);
  expect(screen.getByText('Clear activity')).toBeTruthy();
  expect(screen.getByText('progress update')).toBeTruthy();
  expect(screen.getByText('sent a result')).toBeTruthy();
  expect(screen.getByText('The body says Done but this is progress')).toBeTruthy();
});

it('omits repeated task headings while retaining each row and author', () => {
  const item: ActivityFeedItem = { kind: 'message-out', text: 'Second author group', platform: 'linear', timestamp, surface, isEdit: false };
  const props = { group: group([item]), agentId: 'ada' };
  const { container, rerender } = render(<LinearActivityGroup {...props} heading={surface} />);
  expect(screen.getByText('Clear activity')).toBeTruthy();
  rerender(<LinearActivityGroup {...props} />);
  expect(container.querySelector('header')).toBeNull();
  expect(screen.queryByText('Clear activity')).toBeNull();
  expect(screen.getByText('Ada')).toBeTruthy();
  expect(screen.getByText('Second author group')).toBeTruthy();
});

it('keeps missing semantic information generic rather than deriving it from the body', () => {
  const item: ActivityFeedItem = { kind: 'message-out', text: 'Done', platform: 'linear', timestamp, surface, isEdit: false };
  render(<LinearActivityGroup group={group([item])} agentId="ada" />);
  expect(screen.getByText('replied')).toBeTruthy();
  expect(screen.queryByText('sent a result')).toBeNull();
});

describe('API request details', () => {
  it('keeps uncertainty in the collapsed summary and reveals operation details on demand', () => {
    const items = buildActivityFeed({ events: [{ activityId: 'api', createdAt: timestamp, type: 'tool.call.completed', payload: {
      tool: 'anima.linear.api', operation: 'mutation', fields: ['issueUpdate'], issueKey: 'ANI-30', outcome: 'request_completed', query: 'PRIVATE_QUERY',
    } }] });
    const { container } = render(<LinearActivityGroup group={group(items)} agentId="ada" />);
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(screen.getByText('· Change not confirmed').closest('summary')).toBeTruthy();
    fireEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    expect(screen.getByText('mutation · issueUpdate')).toBeTruthy();
    expect(screen.getByText('Request completed; the change was not confirmed')).toBeTruthy();
    expect(container.textContent).not.toContain('PRIVATE_QUERY');
  });

  it('keeps failures visible without opening details or claiming that a write had no effect', () => {
    const items = buildActivityFeed({ events: [{ activityId: 'api', createdAt: timestamp, type: 'tool.call.failed', payload: {
      tool: 'anima.linear.api', operation: 'mutation', fields: ['issueUpdate'], issueKey: 'ANI-30', failure: 'network',
    } }] });
    render(<LinearActivityGroup group={group(items)} agentId="ada" />);
    expect(screen.getByText('· Failed, outcome unknown').closest('summary')).toBeTruthy();
  });
});

it('shows an unsent request without borrowing token failure metadata or claiming a remote outcome', () => {
  const items = buildActivityFeed({ events: [{ activityId: 'unsent', createdAt: timestamp, type: 'tool.call.failed', payload: {
    tool: 'anima.linear.api', operation: 'mutation', fields: ['issueUpdate'], outcome: 'not_sent', httpStatus: 400, failure: 'network',
  } }] });
  const { container } = render(<LinearActivityGroup group={group(items)} agentId="ada" />);
  expect(screen.getByText('· Not sent').closest('summary')).toBeTruthy();
  expect(screen.getByText('Request not sent')).toBeTruthy();
  expect(container.textContent).not.toMatch(/HTTP|network|outcome unknown/);
  expect(container.querySelector('header')).toBeNull();
});

it.each([['issueLabelCreate', 'mutation'], ['workflowStates', 'query']])('does not say a recorded but undisplayed field was missing: %s', (field, operation) => {
  const items = buildActivityFeed({ events: [{ activityId: 'other', createdAt: timestamp, type: 'tool.call.completed', payload: {
    tool: 'anima.linear.api', operation, fields: [field],
  } }] });
  const { container } = render(<LinearActivityGroup group={group(items)} agentId="ada" />);
  expect(container.querySelector('code')?.textContent).toBe(operation);
  expect(container.textContent).not.toContain('field not recorded');
});
