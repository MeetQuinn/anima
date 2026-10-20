import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type ObservedConversationEntry,
  type ObservedConversationStore,
  observedConversationFileStem,
  observedConversationsDir,
} from '../../storage/schema/observed-conversation.store.js';

/**
 * Observe rows on `slack:T1:<channelId>` until the journal has rotated twice,
 * with the clock stepped back one second between the rotations. Archives are
 * named by `Date.now()`, so the second archive sorts before the first and
 * reading segments by name is out of append order. The live file is left
 * holding only the newest row. Use a store with a small `maxBytes`.
 */
export async function observeAcrossClockStep(
  store: ObservedConversationStore,
  agentId: string,
  channelId: string,
): Promise<ObservedConversationEntry[]> {
  const archiveDir = join(
    observedConversationsDir(agentId),
    'archive',
    observedConversationFileStem(`slack:T1:${channelId}`),
  );
  const archives = async () => (await readdir(archiveDir).catch(() => [] as string[])).sort();
  const realNow = Date.now;
  const start = realNow();
  let clock = start;
  Date.now = () => clock;
  const rows: ObservedConversationEntry[] = [];
  try {
    while ((await archives()).length < 2) {
      if (rows.length >= 1000) throw new Error('journal did not rotate twice');
      const n = rows.length + 1;
      const result = await store.observe({
        teamId: 'T1',
        channelId,
        messageTs: `100.${String(n).padStart(4, '0')}`,
        text: `row-${n} ${'x'.repeat(400)}`,
        userId: 'U1',
      });
      if (!result.appended) throw new Error(`row ${n} was not appended`);
      rows.push(result.entry);
      if ((await archives()).length === 1) clock = start - 1_000;
    }
  } finally {
    Date.now = realNow;
  }
  const firstOrdinals = await Promise.all((await archives()).map(async (name) => {
    const [first] = (await readFile(join(archiveDir, name), 'utf8')).split('\n');
    return (JSON.parse(first!) as ObservedConversationEntry).ordinal;
  }));
  if (!(firstOrdinals[0]! > firstOrdinals[1]!)) throw new Error('archives still sort in append order');
  return rows;
}
