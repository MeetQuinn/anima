// `agy` runs this script as a hook (see antigravityHooksDefinition): as a Stop hook
// each time an execution loop of one of its conversations ends (a prompt, a turn
// agy started on its own, or a subagent's run), and as a PostToolUse hook after
// each `invoke_subagent` call. It appends one JSON line to the file named by
// ANIMA_ANTIGRAVITY_HOOK_EVENTS, which the Anima controller reads. The payload
// also carries the conversation's last user input and the call's arguments; only
// the fields below are kept, the input as a keyed digest (antigravityInputTag) and
// only when ANIMA_ANTIGRAVITY_HOOK_KEY is set. The hook never changes what agy
// does: it always prints an empty result and exits 0.
import { appendFileSync } from 'node:fs';
import { antigravityInputTag } from './antigravity-input-tag.js';

const target = process.env['ANIMA_ANTIGRAVITY_HOOK_EVENTS'];
const key = process.env['ANIMA_ANTIGRAVITY_HOOK_KEY'];
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
      const toolCall = fields['toolCall'] && typeof fields['toolCall'] === 'object'
        ? fields['toolCall'] as Record<string, unknown>
        : undefined;
      const event = {
        at: Date.now(),
        conversationId: typeof fields['conversationId'] === 'string' ? fields['conversationId'] : undefined,
        // A failed call carries the error; a call that succeeded carries an empty one.
        failed: toolCall ? typeof fields['error'] === 'string' && fields['error'] !== '' : undefined,
        fullyIdle: typeof fields['fullyIdle'] === 'boolean' ? fields['fullyIdle'] : undefined,
        hookEventName: typeof fields['hookEventName'] === 'string' ? fields['hookEventName'] : undefined,
        input: key && typeof fields['lastUserInput'] === 'string' ? antigravityInputTag(key, fields['lastUserInput']) : undefined,
        terminationReason:
          typeof fields['terminationReason'] === 'string' ? fields['terminationReason'].slice(0, 64) : undefined,
        toolCallId: typeof toolCall?.['id'] === 'string' ? toolCall['id'].slice(0, 128) : undefined,
        toolName: typeof toolCall?.['name'] === 'string' ? toolCall['name'].slice(0, 64) : undefined,
      };
      appendFileSync(target, `${JSON.stringify(event)}\n`);
    }
  } catch {
    // A lost event only changes when Anima counts agy's work done (later for a lost Stop,
    // sooner for a lost call); agy's step must not fail.
  }
  process.stdout.write('{}');
});
