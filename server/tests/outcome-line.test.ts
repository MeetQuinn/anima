import test from 'node:test';
import assert from 'node:assert/strict';

import { outcomeLine } from '../tools/outcome-line.js';

test('outcomeLine renders quoted values, notes, and empty parts', () => {
  assert.equal(
    outcomeLine('sent', [['channel', '#product launch'], ['message_ts', '1770000200.000123']], {
      note: '@missing was sent as plain text.',
    }),
    'sent successfully. channel="#product launch", message_ts=1770000200.000123. Note: @missing was sent as plain text.',
  );
  assert.equal(outcomeLine('reaction added'), 'reaction added successfully.');
});
