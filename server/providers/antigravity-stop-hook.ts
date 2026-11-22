// `agy` runs this script as a Stop hook (see antigravityHooksDefinition) each
// time an execution loop of one of its conversations ends: a prompt, a turn
// agy started on its own, or a subagent's run. It appends one JSON line to the
// file named by ANIMA_ANTIGRAVITY_HOOK_EVENTS, which the Anima controller reads.
// The payload also carries the conversation's last user input; only the fields
// below are kept. The hook never blocks the stop: it always prints an empty
// decision and exits 0.
import { appendFileSync } from 'node:fs';

const target = process.env['ANIMA_ANTIGRAVITY_HOOK_EVENTS'];
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    const payload: unknown = JSON.parse(raw);
    if (target && payload && typeof payload === 'object') {
      const fields = payload as Record<string, unknown>;
      const event = {
        at: Date.now(),
        conversationId: typeof fields['conversationId'] === 'string' ? fields['conversationId'] : undefined,
        fullyIdle: typeof fields['fullyIdle'] === 'boolean' ? fields['fullyIdle'] : undefined,
        hookEventName: typeof fields['hookEventName'] === 'string' ? fields['hookEventName'] : undefined,
        terminationReason:
          typeof fields['terminationReason'] === 'string' ? fields['terminationReason'].slice(0, 64) : undefined,
      };
      appendFileSync(target, `${JSON.stringify(event)}\n`);
    }
  } catch {
    // A lost event only delays quiescence; agy's stop must not fail.
  }
  process.stdout.write('{}');
});
