import test from 'node:test';
import assert from 'node:assert/strict';

import { MessageTransportRunner, type MessageTransport } from '../transports/message-transport.js';

function fakeTransport(input: {
  events: string[];
  failStart?: boolean;
  kind: MessageTransport['kind'];
}): MessageTransport {
  return {
    kind: input.kind,
    async start() {
      input.events.push(`start:${input.kind}`);
      if (input.failStart) throw new Error(`start failed:${input.kind}`);
    },
    async stop() {
      input.events.push(`stop:${input.kind}`);
    },
  };
}

test('message transport runner starts and stops transports in order', async () => {
  const events: string[] = [];
  const runner = new MessageTransportRunner([
    fakeTransport({ events, kind: 'slack' }),
    fakeTransport({ events, kind: 'feishu' }),
  ]);

  await runner.start();
  await runner.stop();

  assert.deepEqual(events, [
    'start:slack',
    'start:feishu',
    'stop:feishu',
    'stop:slack',
  ]);
});

test('message transport runner stops started transports when a later transport fails', async () => {
  const events: string[] = [];
  const runner = new MessageTransportRunner([
    fakeTransport({ events, kind: 'slack' }),
    fakeTransport({ events, failStart: true, kind: 'feishu' }),
    fakeTransport({ events, kind: 'dingtalk' }),
  ]);

  await assert.rejects(() => runner.start(), /start failed:feishu/);

  assert.deepEqual(events, [
    'start:slack',
    'start:feishu',
    'stop:slack',
  ]);
});
