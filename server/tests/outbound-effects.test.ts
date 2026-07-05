import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyOutboundEffect } from '../../shared/outbound-effects.js';
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

test('classifyOutboundEffect leaves ask posts and unknown effects unclassified', () => {
  // slack.ask.post projection into the ledger is a separate semantics change;
  // this refactor deliberately keeps it out of the classifier.
  assert.equal(classifyOutboundEffect({ effect: 'slack.ask.post', tool: 'anima.ask' }), undefined);
  assert.equal(classifyOutboundEffect({ effect: 'slack.channel.join' }), undefined);
  assert.equal(classifyOutboundEffect({}), undefined);
});

test('isRuntimeEventNoise suppresses streaming frames and keeps lifecycle events', () => {
  assert.equal(isRuntimeEventNoise('claude.stream.message_stop'), true);
  assert.equal(isRuntimeEventNoise('provider.reasoning'), true);
  assert.equal(isRuntimeEventNoise('kimi.context.stats'), true);
  assert.equal(isRuntimeEventNoise('claude.thinking.delta'), true);
  assert.equal(isRuntimeEventNoise('codex.raw_response_item.completed'), true);

  assert.equal(isRuntimeEventNoise('claude.session.started'), false);
  assert.equal(isRuntimeEventNoise('provider.error'), false);
});
