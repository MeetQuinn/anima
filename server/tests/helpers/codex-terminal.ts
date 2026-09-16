import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A local protocol fixture: never launches Codex or makes a model request. */
export async function writeTerminalCodex(directory: string): Promise<string> {
  const path = join(directory, 'codex-terminal');
  await writeFile(path, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let count = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fake-codex/0.145.0' } });
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    send({ id: msg.id, result: { thread: { id: 'test-thread' } } });
  }
  if (msg.method !== 'turn/start') return;
  count += 1;
  if (process.env.CALLS_PATH) appendFileSync(process.env.CALLS_PATH, 'turn/start\\n');
  const turnId = 'test-turn-' + count;
  const status = count === 1 ? process.env.TERMINAL_STATUS : 'completed';
  const complete = () => {
    send({ method: 'item/agentMessage/delta', params: {
      threadId: 'test-thread', turnId, itemId: 'message-' + count, delta: 'partial or complete text',
    } });
    send({ method: 'turn/completed', params: { threadId: 'test-thread', turn: {
      id: turnId, status, error: process.env.TURN_ERROR ? { message: process.env.TURN_ERROR } : null,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    } } });
  };
  const respond = () => send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
  if (process.env.EARLY_COMPLETION === 'true') {
    complete();
    setTimeout(respond, 100);
  } else {
    respond();
    setTimeout(complete, 10);
  }
});
`, 'utf8');
  await chmod(path, 0o755);
  return path;
}
