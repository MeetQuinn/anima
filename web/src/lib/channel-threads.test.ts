import { describe, expect, it } from 'vitest';
import { buildChannelThreadContext, threadSnippet } from './channel-threads';
import type { AgentMessageRecord } from '@shared/messages';

// Minimal record factory — fills the fields the builder + author/text readers
// touch, leaving the rest defaulted. Cast keeps the fixtures terse.
function rec(p: Partial<AgentMessageRecord>): AgentMessageRecord {
  return {
    direction: 'in',
    kind: 'message',
    messageId: 'm',
    source: { kind: 'inbox', id: 's' },
    text: '',
    timestamp: '2026-07-08T00:00:00.000Z',
    ...p,
  } as AgentMessageRecord;
}

describe('threadSnippet', () => {
  it('collapses whitespace and trims', () => {
    expect(threadSnippet('  hello\n\n  world  ')).toBe('hello world');
  });

  it('clips to ~40 chars with an ellipsis', () => {
    const long = 'a'.repeat(60);
    const out = threadSnippet(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(41); // 40 chars + ellipsis
  });

  it('returns empty string for text-less input (author-only fallback)', () => {
    expect(threadSnippet('')).toBe('');
    expect(threadSnippet('   ')).toBe('');
  });

  it('strips inline and leading Markdown so it does not leak into the snippet', () => {
    expect(threadSnippet('**Release posture** for today')).toBe('Release posture for today');
    expect(threadSnippet('## Heading here')).toBe('Heading here');
    expect(threadSnippet('> quoted line')).toBe('quoted line');
    expect(threadSnippet('- list item')).toBe('list item');
    expect(threadSnippet('see `code` and _emph_')).toBe('see code and emph');
    expect(threadSnippet('read the [docs](https://x.io) now')).toBe('read the docs now');
  });
});

describe('buildChannelThreadContext', () => {
  const base = { agentName: 'Nora', channelKind: 'channel' as const };

  it('detects replies (threadTs !== messageTs) and counts them per parent', () => {
    const ctx = buildChannelThreadContext(
      [
        rec({ messageTs: '100', text: 'parent post' }), // thread starter
        rec({ messageTs: '101', threadTs: '100', text: 'reply one' }),
        rec({ messageTs: '102', threadTs: '100', text: 'reply two' }),
        rec({ messageTs: '200', text: 'unrelated top-level' }),
      ],
      base,
    );
    expect(ctx.replyCountByTs.get('100')).toBe(2);
    expect(ctx.replyCountByTs.has('200')).toBe(false);
    expect(ctx.countsExact).toBe(true);
  });

  it('does not count a thread parent whose threadTs equals its own messageTs', () => {
    // Slack marks a started-thread parent with thread_ts === ts; that is NOT a reply.
    const ctx = buildChannelThreadContext(
      [rec({ messageTs: '100', threadTs: '100', text: 'parent' })],
      base,
    );
    expect(ctx.replyCountByTs.size).toBe(0);
  });

  it('builds a parent lookup with author + clipped snippet', () => {
    const ctx = buildChannelThreadContext(
      [rec({ messageTs: '100', text: 'the original message', actorDisplayName: 'Milo' })],
      base,
    );
    expect(ctx.parentByTs.get('100')).toEqual({ author: 'Milo', snippet: 'the original message' });
  });

  it('resolves author by direction and channel kind', () => {
    const inChannel = buildChannelThreadContext(
      [
        rec({ direction: 'out', messageTs: '1', text: 'agent said' }),
        rec({ direction: 'in', messageTs: '2', text: 'user said', actorDisplayName: 'Aria' }),
      ],
      { agentName: 'Nora', channelKind: 'channel' },
    );
    expect(inChannel.parentByTs.get('1')?.author).toBe('Nora'); // outbound → agent
    expect(inChannel.parentByTs.get('2')?.author).toBe('Aria'); // inbound → sender byline

    const inDm = buildChannelThreadContext(
      [rec({ direction: 'in', messageTs: '3', text: 'dm text', actorDisplayName: 'Ignored' })],
      { agentName: 'Nora', channelKind: 'dm', channelName: 'totoday' },
    );
    expect(inDm.parentByTs.get('3')?.author).toBe('totoday'); // DM → channel name
  });

  it('gives a text-less parent an empty snippet (author-only back-ref)', () => {
    const ctx = buildChannelThreadContext(
      [rec({ direction: 'out', messageTs: '1', kind: 'file', text: '' })],
      base,
    );
    expect(ctx.parentByTs.get('1')).toEqual({ author: 'Nora', snippet: '' });
  });

  it('ignores records without a messageTs (non-Slack) for the parent map', () => {
    const ctx = buildChannelThreadContext([rec({ text: 'no ts' })], base);
    expect(ctx.parentByTs.size).toBe(0);
  });

  it('excludes reactions so they cannot masquerade as a thread parent or reply', () => {
    // A reaction carries the *target* message's ts as messageTs (and may carry
    // a threadTs). Without the kind==='reaction' guard it would overwrite the
    // real parent at ts 100 with "Reaction added…" and miscount ts 50 as a
    // reply target.
    const ctx = buildChannelThreadContext(
      [
        rec({ direction: 'out', messageTs: '100', text: 'the real parent post' }),
        rec({
          kind: 'reaction',
          direction: 'out',
          messageTs: '100',
          threadTs: '50',
          text: 'Reaction added: tada',
        }),
        rec({ messageTs: '101', threadTs: '100', text: 'the one real reply' }),
      ],
      base,
    );
    // real parent survives, not overwritten by the reaction's snippet
    expect(ctx.parentByTs.get('100')).toEqual({ author: 'Nora', snippet: 'the real parent post' });
    // only genuine messages are parents (100 + the reply row 101); no phantom
    expect([...ctx.parentByTs.keys()].sort()).toEqual(['100', '101']);
    // the reaction's threadTs (50) is not counted; only the real reply to 100
    expect(ctx.replyCountByTs.get('50')).toBeUndefined();
    expect(ctx.replyCountByTs.get('100')).toBe(1);
  });
});
