import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyOutboundEffect,
  heldSendActivityCopy,
} from '../../shared/outbound-effects.js';
import { isRuntimeEventNoise } from '../../shared/runtime-event-noise.js';

test('classifyOutboundEffect maps message tools and effects', () => {
  assert.deepEqual(classifyOutboundEffect({ tool: 'anima.message.send' }), { isEdit: false, kind: 'message' });
  assert.deepEqual(classifyOutboundEffect({ tool: 'anima.message.update' }), { isEdit: true, kind: 'message' });
  assert.deepEqual(classifyOutboundEffect({ effect: 'slack.message.send' }), { isEdit: false, kind: 'message' });
  assert.deepEqual(classifyOutboundEffect({ effect: 'slack.message.update' }), { isEdit: true, kind: 'message' });
});

test('classifyOutboundEffect recognizes effect-only feishu payloads (pre-refactor drift)', () => {
  // Before the shared classifier, these three were only matched via the tool
  // field; an effect-only payload was silently dropped from the ledger.
  assert.deepEqual(classifyOutboundEffect({ effect: 'feishu.message.update' }), { isEdit: true, kind: 'message' });
  assert.deepEqual(classifyOutboundEffect({ effect: 'feishu.reaction' }), { kind: 'reaction' });
  assert.deepEqual(classifyOutboundEffect({ effect: 'feishu.file.send' }), { kind: 'file' });
});

test('classifyOutboundEffect maps file and reaction tools', () => {
  assert.deepEqual(classifyOutboundEffect({ tool: 'anima.file.send' }), { kind: 'file' });
  assert.deepEqual(classifyOutboundEffect({ effect: 'slack.file.send' }), { kind: 'file' });
  assert.deepEqual(classifyOutboundEffect({ tool: 'anima.message.react' }), { kind: 'reaction' });
  assert.deepEqual(classifyOutboundEffect({ effect: 'slack.reaction' }), { kind: 'reaction' });
});

test('classifyOutboundEffect classifies ask posts and leaves unknown effects unclassified', () => {
  // Interactive ask posts are agent-authored channel content: they classify
  // as `ask` so the server ledger projects them while the web activity feed
  // keeps its generic step row.
  assert.deepEqual(classifyOutboundEffect({ effect: 'slack.ask.post', tool: 'anima.ask' }), { kind: 'ask' });
  assert.deepEqual(classifyOutboundEffect({ effect: 'slack.ask.post' }), { kind: 'ask' });
  assert.deepEqual(classifyOutboundEffect({ tool: 'anima.ask' }), { kind: 'ask' });
  assert.equal(classifyOutboundEffect({ effect: 'slack.channel.join' }), undefined);
  assert.equal(classifyOutboundEffect({}), undefined);
});

test('classifyOutboundEffect never treats status:held as an outbound send', () => {
  for (const tool of ['anima.message.send', 'anima.ask', 'anima.file.send'] as const) {
    assert.equal(
      classifyOutboundEffect({ status: 'held', tool }),
      undefined,
      `${tool} held must not classify as outbound`,
    );
  }
  // Real completed posts still classify when status is completed / omitted.
  assert.deepEqual(
    classifyOutboundEffect({ status: 'completed', tool: 'anima.message.send' }),
    { isEdit: false, kind: 'message' },
  );
});

test('heldSendActivityCopy uses message noun for every held tool (delta is conversation)', () => {
  assert.equal(
    heldSendActivityCopy({ deltaCount: 1 }),
    'Send held: 1 new message arrived while composing; nothing was sent.',
  );
  assert.equal(
    heldSendActivityCopy({ deltaCount: 3 }),
    'Send held: 3 new messages arrived while composing; nothing was sent.',
  );
  // File holds still name the *arrived* conversation messages, not files.
  assert.equal(
    heldSendActivityCopy({ deltaCount: 2 }),
    'Send held: 2 new messages arrived while composing; nothing was sent.',
  );
});

test('isRuntimeEventNoise suppresses streaming frames and keeps lifecycle events', () => {
  assert.equal(isRuntimeEventNoise('claude.stream.message_stop'), true);
  assert.equal(isRuntimeEventNoise('provider.reasoning'), true);
  assert.equal(isRuntimeEventNoise('kimi.context.stats'), true);
  assert.equal(isRuntimeEventNoise('claude.thinking.delta'), true);
  assert.equal(isRuntimeEventNoise('codex.raw_response_item.completed'), true);
  assert.equal(isRuntimeEventNoise('codex.plan.updated'), false);
  assert.equal(isRuntimeEventNoise('kimi.plan.updated'), true);

  assert.equal(isRuntimeEventNoise('claude.session.started'), false);
  assert.equal(isRuntimeEventNoise('provider.error'), false);
});
