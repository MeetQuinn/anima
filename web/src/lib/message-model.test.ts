import { describe, expect, it } from 'vitest';
import { inboundAuthorName, inboundSlackUserId } from './message-model';
import type { AgentMessageRecord } from '@shared/messages';

function rec(p: Partial<AgentMessageRecord>): AgentMessageRecord {
  return {
    direction: 'in',
    kind: 'message',
    messageId: 'm',
    source: { kind: 'inbox', id: 's' },
    text: '',
    timestamp: '2026-11-03T00:00:00.000Z',
    ...p,
  } as AgentMessageRecord;
}

describe('inboundAuthorName', () => {
  it('names a Linear sender from the recorded actor', () => {
    expect(inboundAuthorName(rec({ platform: 'linear', channelKind: 'linear_session', actor: 'Guoqiang' }))).toBe('Guoqiang');
    expect(inboundAuthorName(rec({ platform: 'linear', channelKind: 'linear_issue', actor: 'Guoqiang' }))).toBe('Guoqiang');
  });

  it('labels a Linear sender without a name as a Linear user', () => {
    expect(inboundAuthorName(rec({ platform: 'linear' }))).toBe('Linear user');
  });

  it('keeps Slack bylines on the Slack actor fields', () => {
    expect(inboundAuthorName(rec({ platform: 'slack', actor: 'Ada (@ada)', actorDisplayName: 'Ada', actorHandle: '@ada' }))).toBe('Ada');
    expect(inboundAuthorName(rec({ platform: 'slack' }))).toBe('Unknown user');
  });
});

describe('inboundSlackUserId', () => {
  it('groups Linear senders by name, not by their Linear id', () => {
    expect(inboundSlackUserId(rec({ platform: 'linear', actor: 'Guoqiang', actorUserId: 'linear-user-1' }))).toBeUndefined();
    expect(inboundSlackUserId(rec({ platform: 'slack', actorUserId: 'U0ALICE001' }))).toBe('U0ALICE001');
  });
});
