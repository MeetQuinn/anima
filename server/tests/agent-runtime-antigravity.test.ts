import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAgentRuntime } from '../providers/factory.js';
import type { AgentRuntime, AgentRuntimeInput } from '../providers/contract.js';
import {
  AntigravityCliAgentRuntime,
  type AntigravityWakeTiming,
  antigravityAcpLaunchArgs,
  antigravityAgentDefinition,
  antigravityCommandProblem,
  antigravityHooksDefinition,
  antigravityLaunchEnvironment,
  antigravityQuotaNotice,
  antigravityQuotaResetsAt,
  antigravityToolName,
  parseAcpSelectOptions,
} from '../providers/antigravity.js';
import { antigravityInputTag } from '../providers/antigravity-input-tag.js';
import { providerFailureReasonFromError } from '../providers/provider-failure.js';
import { classifyProviderRetry, providerRateLimitResumeAt } from '../providers/provider-retry.js';
import { isProviderRateLimitedError, runProviderWithCrashRetries } from '../runtime/provider-runner.js';
import { runtimeSessionServiceForAgent } from '../runtime/runtime-session.service.js';
import { antigravityAcpModelCatalog, defaultSystemService, parseAntigravityConfigOptions } from '../services/system.service.js';
import { AgentService } from '../agents/agent.service.js';
import { withAnimaHome } from './anima-home.js';
import { agentTokenUsageServiceForAgent } from '../usage/agent-token-usage.service.js';
import {
  assertFollowupPrompt,
  providerSessionStartedPayload,
  runtimeFollowupInput,
  runtimeInput,
  runtimeTestEnv,
} from './helpers/agent-runtime.js';
import { waitFor, withTimeout } from './helpers/harness.js';
import { ingestEvent } from './helpers/inbox.js';
import { makeSlackEvent } from './helpers/slack.js';
import { allActivities, loadState } from './helpers/state.js';
import { ensureTestAgentConfig } from './helpers/runtime-worker.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { AgentRestartCommandStore } from '../runtime/agent-restart-command.store.js';
import type { RunningAgentHandle } from '../runtime/agent-runner.js';
import { RuntimeHost } from '../runtime/host.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import type { AgentConfig } from '../../shared/agent-config.js';

/** configOptions as `agy acp` 1.5 reports them on a free-tier account (values trimmed). */
const CONFIG_OPTIONS = [
  {
    category: 'model',
    currentValue: 'gemini-3.8-flash',
    id: 'model',
    name: 'Model',
    options: [
      { name: 'Gemini 3.8 Flash', value: 'gemini-3.8-flash' },
      { name: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
    ],
    type: 'select',
  },
  {
    category: 'thought_level',
    currentValue: 'high',
    id: 'thought_level',
    name: 'Thinking',
    options: [
      { name: 'Low', value: 'low' },
      { name: 'Medium', value: 'medium' },
      { name: 'High', value: 'high' },
    ],
    type: 'select',
  },
  {
    category: 'mode',
    currentValue: 'agent',
    id: 'mode',
    options: [{ value: 'agent' }, { value: 'plan' }],
    type: 'select',
  },
];

/**
 * Fake `agy acp`. The scenario (JSON in AGY_SCENARIO) picks the responses:
 * - appendSystemPrompt: advertise `_meta.antigravity.systemPrompt.append`
 * - resume: 'ok' | 'missing'
 * - newError / promptError: JSON-RPC error objects
 * - newHangs: session/new is never answered
 * - richTurn: emit permission request, thought, tool call and usage on the first prompt
 * - agents: 'none' lists no agents (an agy that cannot find Anima's agent), 'fail' exits 1,
 *   'hang' ignores SIGTERM and never answers (its pid goes to AGENTS_PID_PATH)
 * - quotaNotice / quotaError: answer the prompt with agy's quota notice, as a reply or an error;
 *   quotaNotice 'afterTool' sends it as the step after some text and a tool call, 'afterOneNotice'
 *   the same with the tool call reported once, already completed
 * - quotaLookalike: a normal reply whose last line looks like a quota notice
 * - quotaAfterFollowup: the first prompt waits until it is cancelled, which ends it with
 *   Stop(false); agy then starts a read on its own. The next prompt says a line of its own, the
 *   read completes, and the prompt ends with the quota notice it quotes.
 * - wake: the first prompt starts a subagent and ends with background work pending; once
 *   WAKE_TRIGGER_PATH exists, agy starts a turn of its own (thinking, a permission request,
 *   a file write, a reply) for the report. Every prompt and that turn end with a Stop, which
 *   agy runs after the usage update that closes the loop and before a prompt's answer.
 *   wake 'joined': that turn reads a file and stops short; the next prompt joins it and finishes it.
 *   Once WAKE_TRIGGER_PATH.tail exists it runs one more tool and says one more line in a single
 *   write, then asks permission 'tail-seen'.
 *   early: the report comes at once, in the same write as the first prompt's answer. 'together':
 *   the report's Stop follows 200ms later; 'lateRead': it is on disk before that write, as when
 *   Anima reads agy's output late. Then WAKE_TRIGGER_PATH.early is written.
 *   second: the second prompt starts another subagent; once WAKE_TRIGGER_PATH.second exists,
 *   that one reports in a turn of its own. second 'slowLateRead': 400ms after the second prompt's
 *   Stop, the report's Stop is on disk and the answer and the report come in one write.
 *   WAKE_TRIGGER_PATH.stopped is written after the self-started turn's Stop, and
 *   WAKE_TRIGGER_PATH.hooks-done once the hooks and calls that follow it (below) have run.
 *   crossing: the self-started turn's Stop is still being written when the next prompt arrives,
 *   so it lands after that prompt's send.
 *   A subagent's own conversation stops as its report starts (subagent 2 with REPORT-B.).
 *   lateSubagentStop: it stops 50ms after the self-started turn, whose Stop still counts it as
 *   running; invokeTwice: the first prompt invokes two subagents, and only one ever stops;
 *   openTool: the self-started turn leaves a command running in the background; subagentBusy:
 *   the subagent's Stop says work of its own is still running. wakeLeavesWork: the subagent stops
 *   as usual, but the self-started turn's Stop says work is still running. invokeTitle: the title
 *   of the first prompt's invoke_subagent call. subagentStops: [conversation, idle] Stops that
 *   follow the self-started turn 50ms apart (with lateSubagentStop); idle 'call' is a model call
 *   instead, 'resumed' one of a subagent with earlier steps that this run never saw (from before
 *   a reload), 'fresh' one that shows no earlier steps, and conversation 'session' is the
 *   session's own. earlierWork: before its
 *   calls, the first prompt shows earlier work that has just ended: a subagent started by a call
 *   Anima cannot tell apart and one started by invoke_subagent, their Stops, then the session's
 *   own Stop, still being written when the prompt went out; then WAKE_TRIGGER_PATH.earlier is
 *   written. earlierStopLost: the Stop of that invoked subagent is lost. invokeFails: the first
 *   prompt first makes an invoke_subagent call that fails;
 *   'afterStop': the call is still open when the prompt ends and fails 350ms after the subagent Stops.
 *   tailEnds: once 'tail-seen' is answered, wake 'joined' says REPORT-A. and stops.
 *   replyAfterStop: the reply of that turn comes 300ms after its Stop, as when Anima reads
 *   agy's output late.
 * - lateUsage: a usage update follows the answer of a plain prompt
 * - doneFirst: the first prompt invokes subagent a, which stops before the prompt's own Stop
 *   says the session is idle (then WAKE_TRIGGER_PATH.a-idle is written); 'report': the prompt
 *   ends with Stop(false), and 50ms later a stops and the session reports in a turn of its own
 *   whose Stop says it is idle. The second prompt invokes subagent b, ends with Stop(false), and
 *   b stops 50ms later. Each prompt's text goes to WAKE_TRIGGER_PATH.prompt1 and .prompt2.
 *   readLate: before its call, the first prompt writes WAKE_TRIGGER_PATH.about and waits for
 *   WAKE_TRIGGER_PATH.reading.
 * - reportBeforeNext: the first prompt starts subagent a and ends with Stop(false). Once
 *   WAKE_TRIGGER_PATH.a-report exists, a stops and the session runs a turn of its own: it
 *   starts subagent check, which stops at once, says 'REPORT FOR A ONLY.', and ends with a
 *   Stop that says it is idle (then WAKE_TRIGGER_PATH.a-idle is written). The second prompt,
 *   which must come after that, starts subagent b and ends with Stop(false); b stops 50ms later.
 * - stopCrossesNext: the first prompt starts subagent a and ends with Stop(false). Once
 *   WAKE_TRIGGER_PATH.a-report exists, a stops and the session reports ('REPORT-A.') in a turn
 *   of its own, whose Stop hook starts but writes nothing until the second prompt arrives (then
 *   WAKE_TRIGGER_PATH.a-stopping is written). After that hook, the second prompt starts subagent
 *   b and ends with Stop(false); once WAKE_TRIGGER_PATH.b-report exists, b stops and the session
 *   reports ('REPORT-B.') in a turn of its own that ends idle. Each prompt's text goes to
 *   WAKE_TRIGGER_PATH.prompt1 and .prompt2.
 * - failsAround 'before' | 'after': the first prompt makes an invoke_subagent call that fails,
 *   then starts subagent 1, which stops before the prompt's Stop(false). The call fails before
 *   those Stops, or 100ms after the answer. Once WAKE_TRIGGER_PATH exists, the session says
 *   FINAL REPORT. and stops idle.
 * - reportLoop 'beforeStop' | 'afterStop': the first prompt starts subagent r and ends with
 *   Stop(false). 50ms later r stops, and the session's loop for r's report calls the model just
 *   before that Stop, or callAfterMs after it; the loop says 'PRIMARY REPORT.' and stops idle
 *   once WAKE_TRIGGER_PATH.report-go exists.
 * - nested: the first prompt starts coordinator c and ends with Stop(false). 50ms later c calls
 *   the model, starts a leaf and stops saying work goes on, and the session's loop says
 *   'COORDINATOR REPORT.' and stops the same way; the leaf stops once WAKE_TRIGGER_PATH.leaf-go
 *   exists. nested 'inLoop': c starts the leaf while the first prompt's loop runs, and once the
 *   leaf has stopped and WAKE_TRIGGER_PATH.coordinator-go exists, c runs again and stops idle.
 * - peerWork: the first prompt starts a reader and a writer and ends with Stop(false). 50ms later
 *   the reader stops saying work of its own goes on, then the writer stops. Once
 *   WAKE_TRIGGER_PATH.reader-go exists, the reader runs again and stops, and the session's loop
 *   says 'READER COMMAND REPORT.' and stops idle.
 * - peerRewake: the first prompt starts a reader and a writer and ends with Stop(false); 50ms later
 *   both stop, and the session says 'READER AND WRITER REPORT.' and stops idle. The second prompt
 *   wakes the reader with a message and ends with Stop(false); 50ms later the reader wakes
 *   the writer, stops saying work of its own goes on, and the writer stops. Once
 *   WAKE_TRIGGER_PATH.reader-go exists, the reader runs again and stops, and the session's loop
 *   says 'READER COMMAND REPORT.' and stops idle.
 * - nestedAgain: the first prompt starts coordinator c and ends with Stop(false); 50ms later c
 *   starts a leaf, both stop, and the session says 'COORDINATOR REPORT.' and stops idle. The
 *   second prompt wakes c and ends with Stop(false); 50ms later c wakes the leaf and stops saying
 *   work goes on. The leaf stops once WAKE_TRIGGER_PATH.leaf-go exists. nestedAgain
 *   'reportFirst': c hands its report over before it stops, so the session's turn ends saying
 *   work goes on and no Stop of the session's own ends the first prompt's work.
 * - toolOwner 'duringPrompt' | 'afterAnswer' | 'fromWake': the first prompt starts a reader and
 *   ends with Stop(false). Command a is started by that prompt ('duringPrompt') or 50ms later by a
 *   turn agy starts on its own ('fromWake', then WAKE_TRIGGER_PATH.a-started is written), and
 *   fails ('A-SPECIFIC FAILURE.') in the second prompt, which says 'B reply.'. 'afterAnswer': the
 *   second prompt starts command b, and b fails ('B-SPECIFIC FAILURE.') 50ms after its answer.
 *   The reader stops once WAKE_TRIGGER_PATH.reader-stop exists. With quotaAround, the second
 *   prompt answers with agy's quota notice and a fails just after it ('notice'), or answers with
 *   a line of its own, a fails, then the notice it quotes ('quoted'). sameWrite: a's failure and
 *   'B reply.' come in one write, so Anima reads them together.
 * - terminalOnly: the first prompt starts a reader and ends with Stop(false). Once
 *   WAKE_TRIGGER_PATH.go exists, a turn agy starts on its own reports a read only once it has
 *   ended (a single tool_call with status completed), says 'All work finished.' and stops saying
 *   work goes on, and the reader then stops idle.
 * - commandThen 'fail' | 'append': the first prompt starts a reader and a command that keeps
 *   running, and ends with Stop(false). 'fail': every later prompt fails with Invalid params,
 *   and the reader stops after the first of them. 'append': the second prompt calls the model and
 *   waits (then WAKE_TRIGGER_PATH.b-start is written) until it is cancelled, which ends it with
 *   Stop(false); the third says 'HANDLED B AND THE FOLLOW-UP.', ends with Stop(false), and the
 *   reader stops. Once WAKE_TRIGGER_PATH.command-go exists, the command ends and the session's
 *   loop says 'COMMAND A FINISHED.' and stops idle. ownTool: the first prompt starts only the
 *   reader ('Started a reader.'), and the second starts a call of its own that never ends before
 *   it fails (after a Stop that says work goes on) or waits.
 * - barrierUnanswered 'always' | 'afterFirst': a request for a method agy does not know gets no
 *   answer (agy answers it with an error), or none once a prompt has come. barrierLateMs: it is
 *   answered that much later. textBeforeBarrier: once a prompt has come, agy says EARLIER. just
 *   before it answers.
 * - reportAfterBarrier: the first prompt starts subagent a and ends with Stop(false). agy reads
 *   the second prompt only after the turn it starts on its own for a: a stops, the turn starts
 *   subagent check, which stops at once, says 'REPORT FOR A ONLY.', and ends with a Stop that
 *   says the session is idle. Then the prompt starts subagent b and ends with Stop(false); b
 *   stops 50ms later.
 * - reportBeforeAnswer: the first prompt says 'A foreground.' and ends idle. The second starts
 *   subagent b and ends with Stop(false), and its answer is written only after the turn agy
 *   then starts on its own has ended: b stops, the turn starts subagent b2, which stops, and
 *   its Stop says the session is idle. The answer, that turn's text ('B-SELF-REPORT.') and its
 *   call come in one write. The third prompt starts subagent c and ends with Stop(false); c
 *   stops 50ms later. The first two prompts' text goes to WAKE_TRIGGER_PATH.prompt1 and .prompt2.
 * - barrierHeldFrom n: the nth request for a method agy does not know, and each one after it,
 *   is answered only once WAKE_TRIGGER_PATH.release-<its number> exists; then
 *   WAKE_TRIGGER_PATH.answered-<its number> is written.
 * `agy --add-dir <dir> agents` lists the agents defined in `<dir>/.agents/agents`. Stop runs
 * the Stop hooks in `<dir>/.agents/hooks.json` the way agy does: `sh -c`, synchronously,
 * with the hook payload on stdin.
 */
const FAKE_AGY = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const scenario = JSON.parse(process.env.AGY_SCENARIO || '{}');",
  "const configOptions = JSON.parse(process.env.AGY_CONFIG_OPTIONS);",
  "const argv = process.argv.slice(2);",
  "if (argv[argv.length - 1] === 'agents') {",
  "  if (process.env.AGENTS_PATH) fs.writeFileSync(process.env.AGENTS_PATH, JSON.stringify({ argv, cwd: process.cwd() }));",
  "  if (scenario.agents === 'fail') { process.stderr.write('unknown command'); process.exit(1); }",
  "  if (scenario.agents === 'hang') {",
  "    process.on('SIGTERM', () => {});",
  // Written only after SIGTERM is ignored, so this pid can only end by SIGKILL.
  "    fs.writeFileSync(process.env.AGENTS_PID_PATH, String(process.pid));",
  "    setInterval(() => {}, 1000);",
  "    return;",
  "  }",
  "  const dir = argv[argv.indexOf('--add-dir') + 1];",
  "  if (scenario.agents !== 'none' && dir) for (const file of fs.readdirSync(path.join(dir, '.agents', 'agents'))) {",
  "    const name = /^name: (.+)$/m.exec(fs.readFileSync(path.join(dir, '.agents', 'agents', file), 'utf8'));",
  "    if (name) process.stdout.write(name[1] + '\\n');",
  "  }",
  "  process.exit(0);",
  "}",
  "if (process.env.LAUNCH_PATH) fs.writeFileSync(process.env.LAUNCH_PATH, JSON.stringify({ argv, autoCompact: process.env.AGY_CLI_AUTO_COMPACT_OVERRIDE, home: process.env.HOME }));",
  "process.stdin.setEncoding('utf8');",
  "let buffer = '';",
  "let sessionId = 'agy-session-1';",
  'let promptCount = 0;',
  'let pendingPromptId;',
  'let wakeDone = false;',
  // agy's Stop carries the conversation's last user input: the prompt a loop ran for, or for a
  // turn agy starts on its own, the prompt before it. A subagent's carries none.
  "let lastUserInput = '';",
  "let previousUserInput = '';",
  'let barrierCount = 0;',
  'let pendingStop;',
  "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
  // Like agy, start the subagents an invoke_subagent call starts as the call ends, before its update.
  'const invokeCalls = new Set();',
  'function update(value) {',
  "  if (value.sessionUpdate === 'tool_call' && /^agy-invoke-/.test(value.toolCallId)) invokeCalls.add(value.toolCallId);",
  "  if (value.sessionUpdate === 'tool_call_update' && invokeCalls.has(value.toolCallId) && (value.status === 'completed' || value.status === 'failed')) {",
  '    invokeCalls.delete(value.toolCallId);',
  "    if (value.status === 'completed') startedBy(value.toolCallId).forEach(startSubagent);",
  '  }',
  "  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });",
  '}',
  // agy-invoke-<x> starts agy-subagent-<x>; agy-invoke-1b starts agy-subagent-2, and one call can start two.
  'function startedBy(id) {',
  "  if (id === 'agy-invoke-rw' || (id === 'agy-invoke-1' && scenario.batch)) return id === 'agy-invoke-1' ? ['agy-subagent-1', 'agy-subagent-2'] : ['agy-subagent-r', 'agy-subagent-w'];",
  "  return [id === 'agy-invoke-1b' ? 'agy-subagent-2' : id.replace('agy-invoke-', 'agy-subagent-')];",
  '}',
  'function whenTriggered(suffix, then) {',
  '  const timer = setInterval(() => {',
  '    if (!fs.existsSync(process.env.WAKE_TRIGGER_PATH + suffix)) return;',
  '    clearInterval(timer);',
  '    then();',
  '  }, 10);',
  '}',
  'function hookSpecs() {',
  "  const at = argv.indexOf('--add-dir');",
  '  if (at < 0) return [];',
  "  const hooksPath = path.join(argv[at + 1], '.agents', 'hooks.json');",
  '  if (!fs.existsSync(hooksPath)) return [];',
  "  return Object.values(JSON.parse(fs.readFileSync(hooksPath, 'utf8'))).map((spec) => ({ dir: path.dirname(hooksPath), spec }));",
  '}',
  'function runHook(dir, hook, payload) {',
  "  require('child_process').spawnSync('sh', ['-c', hook.command], { cwd: dir, env: process.env, input: JSON.stringify(payload) });",
  '}',
  "function runStopHook(conversationId, fullyIdle, input = conversationId !== sessionId ? '' : scenario.otherInput ? 'not the prompt' : lastUserInput) {",
  '  if (!conversationSteps.has(conversationId)) conversationSteps.set(conversationId, 1);',
  "  const payload = { conversationId, continuationActive: false, executionNum: 0, fullyIdle, hookEventName: 'Stop', lastUserInput: input, terminationReason: 'NO_TOOL_CALL' };",
  '  for (const { dir, spec } of hookSpecs()) for (const hook of spec.Stop || []) runHook(dir, hook, payload);',
  '}',
  'function runHooks(name, payload) {',
  '  for (const { dir, spec } of hookSpecs()) for (const hook of spec[name] || []) runHook(dir, hook, payload);',
  '}',
  // Like agy, a new subagent's conversation starts and then calls the model; one a message wakes only calls the model.
  'function startSubagent(conversationId) {',
  "  runHooks('SessionStart', { conversationId, hookEventName: 'SessionStart', lastUserInput: 'count the lines' });",
  '  modelCall(conversationId);',
  '}',
  // Like agy, a new subagent's first model call has no earlier steps; its later ones, and the session's, have some.
  'const conversationSteps = new Map();',
  'function modelCall(conversationId) {',
  "  const input = conversationId === sessionId ? lastUserInput : 'count the lines';",
  '  const initialNumSteps = conversationSteps.get(conversationId) ?? (conversationId === sessionId ? 1 : 0);',
  '  conversationSteps.set(conversationId, initialNumSteps + 2);',
  "  runHooks('PreInvocation', { conversationId, hookEventName: 'PreInvocation', initialNumSteps, invocationNum: 0, lastUserInput: input });",
  '}',
  // Starts the Stop hook but holds its input open, so the event is written only once finish is called.
  'function startStopHook(conversationId, fullyIdle) {',
  "  const at = argv.indexOf('--add-dir');",
  "  const hooksPath = path.join(argv[at + 1], '.agents', 'hooks.json');",
  "  const payload = JSON.stringify({ conversationId, continuationActive: false, executionNum: 0, fullyIdle, hookEventName: 'Stop', lastUserInput, terminationReason: 'NO_TOOL_CALL' });",
  "  const hook = Object.values(JSON.parse(fs.readFileSync(hooksPath, 'utf8')))[0].Stop[0];",
  "  const proc = require('child_process').spawn('sh', ['-c', hook.command], { cwd: path.dirname(hooksPath), env: process.env, stdio: ['pipe', 'ignore', 'ignore'] });",
  '  proc.stdin.write(payload);',
  "  return { finish(then) { proc.on('exit', then); proc.stdin.end(); } };",
  '}',
  'let heldStop;',
  'function startWake() {',
  // The subagent's report starts the turn, which calls the model, before the subagent stops.
  '  modelCall(sessionId);',
  // The subagent's own conversation stops; its Stop says nothing about the session's work.
  "  if (!scenario.lateSubagentStop) runStopHook('agy-subagent-1', true);",
  "  if (scenario.wake === 'joined') {",
  "    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reading the report.' } });",
  "    update({ sessionUpdate: 'tool_call', toolCallId: 'agy-wake-read', title: 'Read report.md', kind: 'read', status: 'in_progress', locations: [{ path: '/work/report.md' }] });",
  "    update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-wake-read', status: 'completed' });",
  '    const tail = setInterval(() => {',
  "      if (!fs.existsSync(process.env.WAKE_TRIGGER_PATH + '.tail')) return;",
  '      clearInterval(tail);',
  '      process.stdout.write([',
  "        { sessionUpdate: 'tool_call', toolCallId: 'agy-tail-tool', title: 'Read notes.md', kind: 'read', status: 'in_progress', locations: [{ path: '/work/notes.md' }] },",
  "        { sessionUpdate: 'tool_call_update', toolCallId: 'agy-tail-tool', status: 'completed' },",
  "        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A-TAIL.' } },",
  "      ].map((value) => JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } })).join('\\n') + '\\n');",
  "      send({ jsonrpc: '2.0', id: 'tail-seen', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'agy-wake-read' }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }] } });",
  '    }, 10);',
  '    return;',
  '  }',
  "  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'the reader reported' } });",
  "  update({ sessionUpdate: 'usage_update', used: 3500, size: 1048576 });",
  "  send({ jsonrpc: '2.0', id: 'permission-wake', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'agy-wake-tool' }, options: [{ optionId: 'reject', kind: 'reject_once', name: 'Reject' }, { optionId: 'allow', kind: 'allow_once', name: 'Allow' }] } });",
  '}',
  'function finishWake() {',
  "  update({ sessionUpdate: 'tool_call', toolCallId: 'agy-wake-tool', title: 'File notes/summary.md', kind: 'edit', status: 'in_progress', locations: [{ path: '/work/notes/summary.md' }] });",
  "  update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-wake-tool', status: 'completed' });",
  '  if (scenario.replyAfterStop) {',
  '    runStopHook(sessionId, true);',
  '    setTimeout(() => {',
  "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SUMMARY SAVED' } });",
  "      update({ sessionUpdate: 'usage_update', used: 5000, size: 1048576 });",
  "      fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.stopped', '');",
  '    }, 300);',
  '    return;',
  '  }',
  "  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SUMMARY SAVED' } });",
  "  if (scenario.openTool) update({ sessionUpdate: 'tool_call', toolCallId: 'agy-bg-command', title: 'sleep 600', kind: 'execute', status: 'in_progress', rawInput: { command: 'sleep 600' } });",
  '  wakeDone = !scenario.lateSubagentStop && !scenario.wakeLeavesWork;',
  "  update({ sessionUpdate: 'usage_update', used: 5000, size: 1048576 });",
  '  if (scenario.crossing) {',
  '    const input = lastUserInput;',
  '    pendingStop = () => runStopHook(sessionId, true, input);',
  '  } else {',
  '    runStopHook(sessionId, wakeDone);',
  '  }',
  '  if (scenario.lateSubagentStop) {',
  "    const stops = scenario.subagentStops || [['agy-subagent-1', !scenario.subagentBusy]];",
  // A 'call' entry is a model call: a message woke that subagent. 'session' is the session's own conversation.
  "    stops.forEach(([name, idle], index) => setTimeout(() => {",
  "      const conversationId = name === 'session' ? sessionId : name;",
  "      if (idle === 'fresh' || idle === 'resumed') conversationSteps.set(conversationId, idle === 'fresh' ? 0 : 9);",
  "      if (idle === 'call' || idle === 'fresh' || idle === 'resumed') modelCall(conversationId);",
  '      else runStopHook(conversationId, idle);',
  '    }, 50 * (index + 1)));',
  "    if (scenario.invokeFails === 'afterStop') setTimeout(failInvoke, 50 * stops.length + 350);",
  "    if (scenario.lateStart) setTimeout(() => startSubagent('agy-subagent-late'), 50 * stops.length + 100);",
  '    if (scenario.sessionCall) setTimeout(() => modelCall(sessionId), 50 * stops.length + 100);',
  // Timers run in order, so every hook and call above is on disk by then.
  "    setTimeout(() => fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.hooks-done', ''), 50 * stops.length + 400);",
  '  } else {',
  "    fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.hooks-done', '');",
  '  }',
  "  fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.stopped', '');",
  '}',
  // The session messages the reader, which wakes it: the reader calls the model again.
  'function sendReaderMessage() {',
  "  update({ sessionUpdate: 'tool_call', toolCallId: 'agy-message-r', title: 'Run send_message', status: 'in_progress', rawInput: { Recipient: 'reader' } });",
  "  update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-message-r', status: 'completed' });",
  "  modelCall('agy-subagent-r');",
  '}',
  // A subagent hands its report to the session, whose turn reading it ends with work left; then the subagent stops.
  'function reportThenStop(text, subagent) {',
  '  modelCall(sessionId);',
  "  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });",
  "  update({ sessionUpdate: 'usage_update', used: 4500, size: 1048576 });",
  '  runStopHook(sessionId, false);',
  '  runStopHook(subagent, true);',
  '}',
  'function failInvoke() {',
  "  update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-x', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Unknown subagent' } }] });",
  '}',
  'function select(category, value) {',
  '  const option = configOptions.find((entry) => entry.category === category);',
  '  if (!option || !option.options.some((entry) => entry.value === value)) return false;',
  '  option.currentValue = value;',
  '  return true;',
  '}',
  "process.stdin.on('data', (chunk) => {",
  '  buffer += chunk;',
  '  const lines = buffer.split(/\\r?\\n/);',
  "  buffer = lines.pop() || '';",
  '  for (const line of lines) {',
  '    if (!line.trim()) continue;',
  '    const msg = JSON.parse(line);',
  "    fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(msg) + '\\n');",
  // Like agy, answer a request for a method it does not know with an error.
  "    if (msg.id !== undefined && typeof msg.method === 'string' && !['initialize', 'session/new', 'session/resume', 'session/set_config_option', 'session/prompt'].includes(msg.method)) {",
  "      const unanswered = scenario.barrierUnanswered === 'always' || (scenario.barrierUnanswered === 'afterFirst' && promptCount > 0);",
  "      if (scenario.textBeforeBarrier && promptCount > 0) update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'EARLIER.' } });",
  "      const answer = () => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });",
  '      barrierCount += 1;',
  '      if (scenario.barrierHeldFrom && barrierCount >= scenario.barrierHeldFrom) {',
  "        const marker = process.env.WAKE_TRIGGER_PATH + '.answered-' + barrierCount;",
  "        const release = process.env.WAKE_TRIGGER_PATH + '.release-' + barrierCount;",
  '        const held = setInterval(() => {',
  '          if (!fs.existsSync(release)) return;',
  '          clearInterval(held);',
  '          answer();',
  "          fs.writeFileSync(marker, '');",
  '        }, 10);',
  '        continue;',
  '      }',
  '      if (scenario.barrierLateMs) setTimeout(answer, scenario.barrierLateMs);',
  '      else if (!unanswered) answer();',
  '      continue;',
  '    }',
  "    if (msg.id === 'permission-wake' && msg.result) {",
  '      finishWake();',
  '      continue;',
  '    }',
  "    if (msg.id === 'tail-seen' && msg.result && scenario.tailEnds) {",
  "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPORT-A.' } });",
  "      update({ sessionUpdate: 'usage_update', used: 4200, size: 1048576 });",
  '      runStopHook(sessionId, true);',
  '      continue;',
  '    }',
  "    if (msg.id === 'permission-1' && msg.result) {",
  "      fs.writeFileSync(process.env.CALLS_PATH + '.permission', JSON.stringify(msg.result));",
  "      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'considering' } });",
  "      update({ sessionUpdate: 'tool_call', toolCallId: 'agy-tool-1', title: 'pwd', kind: 'execute', status: 'pending', rawInput: { command: 'pwd' } });",
  "      update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '/tmp' } }] });",
  "      update({ sessionUpdate: 'tool_call', toolCallId: 'agy-tool-2', title: 'Read notes.md', kind: 'read', status: 'pending', locations: [{ path: '/work/notes.md' }] });",
  "      update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-tool-2', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'no such file' } }] });",
  "      update({ sessionUpdate: 'usage_update', used: 4096, size: 1048576 });",
  "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'handled first' } });",
  "      setTimeout(() => send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } }), 80);",
  '      continue;',
  '    }',
  "    if (msg.method === 'initialize') {",
  "      const agentCapabilities = { loadSession: true, sessionCapabilities: { close: {}, resume: {} } };",
  "      if (scenario.appendSystemPrompt) agentCapabilities._meta = { antigravity: { systemPrompt: { append: true } } };",
  "      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'antigravity', version: '1.5.3' }, agentCapabilities, authMethods: [] } });",
  '      continue;',
  '    }',
  "    if (msg.method === 'session/new') {",
  "      if (scenario.newError) { send({ jsonrpc: '2.0', id: msg.id, error: scenario.newError }); continue; }",
  '      if (scenario.newHangs) continue;',
  "      sessionId = scenario.uniqueSessions ? 'agy-session-' + process.pid : 'agy-session-new';",
  "      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId, configOptions } });",
  '      continue;',
  '    }',
  "    if (msg.method === 'session/resume') {",
  "      if (scenario.resumeError) { send({ jsonrpc: '2.0', id: msg.id, error: scenario.resumeError }); continue; }",
  "      if (scenario.resume === 'missing') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Failed to read session ' + msg.params.sessionId + '; retry, or load it with session/load' } }); continue; }",
  '      sessionId = msg.params.sessionId;',
  "      send({ jsonrpc: '2.0', id: msg.id, result: { configOptions } });",
  '      continue;',
  '    }',
  "    if (msg.method === 'session/set_config_option') {",
  '      const option = configOptions.find((entry) => entry.id === msg.params.configId);',
  "      if (!option || !select(option.category, msg.params.value)) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'bad value' } }); continue; }",
  "      send({ jsonrpc: '2.0', id: msg.id, result: { configOptions } });",
  '      continue;',
  '    }',
  "    if (msg.method === 'session/cancel') {",
  "      if (scenario.quotaAfterFollowup && pendingPromptId !== undefined) {",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled' } });",
  '        pendingPromptId = undefined;',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-gap', title: 'Read notes.md', kind: 'read', status: 'in_progress' });",
  '        continue;',
  '      }',
  "      if (scenario.commandThen === 'append' && pendingPromptId !== undefined) {",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled' } });",
  '        pendingPromptId = undefined;',
  '        continue;',
  '      }',
  '      if (scenario.hang && pendingPromptId !== undefined) {',
  "        send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled' } });",
  '        pendingPromptId = undefined;',
  '      }',
  '      continue;',
  '    }',
  "    if (msg.method === 'session/prompt') {",
  '      previousUserInput = lastUserInput;',
  "      lastUserInput = (msg.params.prompt || []).map((block) => block.text || '').join('');",
  "      if (scenario.promptError) { send({ jsonrpc: '2.0', id: msg.id, error: scenario.promptError }); continue; }",
  "      if (scenario.quotaError) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h30m.' } }); continue; }",
  "      const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };",
  "      if (scenario.quotaNotice) {",
  "        if (scenario.quotaNotice === 'afterOneNotice') {",
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking the notes.' } });",
  "          update({ sessionUpdate: 'tool_call', toolCallId: 'agy-tool-q', title: 'pwd', kind: 'execute', status: 'completed', rawInput: { command: 'pwd' }, content: [{ type: 'content', content: { type: 'text', text: '/tmp' } }] });",
  "        }",
  "        if (scenario.quotaNotice === 'afterTool') {",
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking the notes.' } });",
  "          update({ sessionUpdate: 'tool_call', toolCallId: 'agy-tool-q', title: 'pwd', kind: 'execute', status: 'pending', rawInput: { command: 'pwd' } });",
  "          update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-tool-q', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '/tmp' } }] });",
  "        }",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h20m5s.\\n' } });",
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage } });",
  "        continue;",
  "      }",
  "      if (scenario.quotaLookalike) {",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Individual quota reached. Ask your team admin to raise the daily limit.' } });",
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage } });",
  "        continue;",
  "      }",
  "      if (scenario.exitOnPrompt) process.exit(0);",
  '      promptCount += 1;',
  "      if (scenario.commandThen === 'fail' && promptCount > 1) {",
  '        if (scenario.ownTool) {',
  '          modelCall(sessionId);',
  "          update({ sessionUpdate: 'tool_call', toolCallId: 'agy-command-b', title: 'Read notes.md', kind: 'read', status: 'in_progress', locations: [{ path: '/work/notes.md' }] });",
  '          runStopHook(sessionId, false);',
  '        }',
  "        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params' } });",
  "        if (promptCount === 2) runStopHook('agy-subagent-r', true);",
  '        continue;',
  '      }',
  '      if (pendingStop) {',
  '        const stop = pendingStop;',
  '        pendingStop = undefined;',
  '        stop();',
  '      }',
  // Like agy, the prompt's loop calls the model first.
  '      modelCall(sessionId);',
  '      if (scenario.hang) { pendingPromptId = msg.id; continue; }',
  '      if (scenario.quotaAfterFollowup) {',
  "        const say = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });",
  "        if (promptCount === 1) { say('Working on the first.'); pendingPromptId = msg.id; continue; }",
  "        say('Here is the notice you asked me to quote:');",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-gap', status: 'completed' });",
  "        say('\\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h30m.\\n');",
  '        runStopHook(sessionId, true);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } });",
  '        continue;',
  '      }',
  '      if (scenario.doneFirst && promptCount === 1) {',
  "        fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.prompt1', lastUserInput);",
  "        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Delegating.' } });",
  '        if (scenario.readLate) {',
  "          fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.about', '');",
  '          const end = Date.now() + 5000;',
  "          while (!fs.existsSync(process.env.WAKE_TRIGGER_PATH + '.reading')) {",
  "            if (Date.now() > end) throw new Error('nobody is reading');",
  '            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);',
  '          }',
  '        }',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-a', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'reader' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-a', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The reader is done.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  "        if (scenario.doneFirst === 'report') {",
  '          runStopHook(sessionId, false);',
  "          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '          setTimeout(() => {',
  "            runStopHook('agy-subagent-a', true);",
  "            update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPORT-A.' } });",
  "            update({ sessionUpdate: 'usage_update', used: 3500, size: 1048576 });",
  '            runStopHook(sessionId, true);',
  "            fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.a-idle', '');",
  '          }, 50);',
  '          continue;',
  '        }',
  "        runStopHook('agy-subagent-a', true);",
  '        runStopHook(sessionId, true);',
  "        fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.a-idle', '');",
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        continue;',
  '      }',
  '      if (scenario.doneFirst && promptCount === 2) {',
  "        fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.prompt2', lastUserInput);",
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-b', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'writer' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-b', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started another subagent.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 4000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        setTimeout(() => runStopHook('agy-subagent-b', true), 50);",
  '        continue;',
  '      }',
  '      if (scenario.stopCrossesNext && promptCount === 1) {',
  "        fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.prompt1', lastUserInput);",
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-a', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'reader' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-a', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a reader.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        const report = setInterval(() => {',
  "          if (!fs.existsSync(process.env.WAKE_TRIGGER_PATH + '.a-report')) return;",
  '          clearInterval(report);',
  "          runStopHook('agy-subagent-a', true);",
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPORT-A.' } });",
  "          update({ sessionUpdate: 'usage_update', used: 3500, size: 1048576 });",
  '          heldStop = startStopHook(sessionId, true);',
  "          fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.a-stopping', '');",
  '        }, 10);',
  '        continue;',
  '      }',
  '      if (scenario.stopCrossesNext && promptCount === 2) {',
  "        fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.prompt2', lastUserInput);",
  '        const id = msg.id;',
  '        const held = heldStop;',
  '        heldStop = undefined;',
  "        if (!held) throw new Error('the second prompt came before the report');",
  // agy runs a loop's Stop before the next loop starts.
  '        held.finish(() => {',
  "          update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-b', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'writer' } });",
  "          update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-b', status: 'completed' });",
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a writer.' } });",
  "          update({ sessionUpdate: 'usage_update', used: 4000, size: 1048576 });",
  '          runStopHook(sessionId, false);',
  "          send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });",
  '          const report = setInterval(() => {',
  "            if (!fs.existsSync(process.env.WAKE_TRIGGER_PATH + '.b-report')) return;",
  '            clearInterval(report);',
  "            runStopHook('agy-subagent-b', true);",
  "            update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPORT-B.' } });",
  "            update({ sessionUpdate: 'usage_update', used: 4500, size: 1048576 });",
  '            runStopHook(sessionId, true);',
  '          }, 10);',
  '        });',
  '        continue;',
  '      }',
  '      if (scenario.reportBeforeNext && promptCount === 1) {',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-a', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'reader' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-a', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a reader.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        const report = setInterval(() => {',
  "          if (!fs.existsSync(process.env.WAKE_TRIGGER_PATH + '.a-report')) return;",
  '          clearInterval(report);',
  "          runStopHook('agy-subagent-a', true);",
  "          update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-check', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'checker' } });",
  "          update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-check', status: 'completed' });",
  "          runStopHook('agy-subagent-check', true);",
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPORT FOR A ONLY.' } });",
  "          update({ sessionUpdate: 'usage_update', used: 3500, size: 1048576 });",
  '          runStopHook(sessionId, true);',
  "          fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.a-idle', '');",
  '        }, 10);',
  '        continue;',
  '      }',
  '      if (scenario.reportBeforeNext && promptCount === 2) {',
  "        if (!fs.existsSync(process.env.WAKE_TRIGGER_PATH + '.a-idle')) throw new Error('the second prompt came before the report');",
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-b', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'writer' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-b', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a writer.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 4000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        setTimeout(() => runStopHook('agy-subagent-b', true), 50);",
  '        continue;',
  '      }',
  '      if (scenario.reportAfterBarrier && promptCount === 1) {',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-a', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'reader' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-a', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a reader.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        continue;',
  '      }',
  '      if (scenario.reportAfterBarrier && promptCount === 2) {',
  // The turn agy started on its own for a ends before agy reads this prompt; its Stop carries the prompt before.
  "        runStopHook('agy-subagent-a', true);",
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-check', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'checker' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-check', status: 'completed' });",
  "        runStopHook('agy-subagent-check', true);",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPORT FOR A ONLY.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3500, size: 1048576 });",
  '        runStopHook(sessionId, true, previousUserInput);',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-b', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'writer' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-b', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a writer.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 4000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        setTimeout(() => runStopHook('agy-subagent-b', true), 50);",
  '        continue;',
  '      }',
  '      if (scenario.reportBeforeAnswer && promptCount === 1) {',
  "        fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.prompt1', lastUserInput);",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A foreground.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, true);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        continue;',
  '      }',
  '      if (scenario.reportBeforeAnswer && promptCount === 2) {',
  "        fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.prompt2', lastUserInput);",
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-b', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'writer' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-b', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B foreground.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 4000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  // The turn agy then starts on its own ends before Anima reads the answer.
  "        runStopHook('agy-subagent-b', true);",
  "        startSubagent('agy-subagent-b2');",
  "        runStopHook('agy-subagent-b2', true);",
  '        runStopHook(sessionId, true);',
  "        const note = (value) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });",
  '        const lines = [',
  "          { jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } },",
  "          note({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B-SELF-REPORT.' } }),",
  "          note({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-b2', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'checker' } }),",
  "          note({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-b2', status: 'completed' }),",
  "          note({ sessionUpdate: 'usage_update', used: 4500, size: 1048576 }),",
  '        ];',
  "        process.stdout.write(lines.map((value) => JSON.stringify(value)).join('\\n') + '\\n');",
  '        continue;',
  '      }',
  '      if (scenario.reportBeforeAnswer && promptCount === 3) {',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-c', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'checker' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-c', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'C foreground.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 5000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        setTimeout(() => runStopHook('agy-subagent-c', true), 50);",
  '        continue;',
  '      }',
  // One call starts a reader and a writer, or (split) one call each; the reader stops at once.
  // The reader's report starts the session's report loop, whose model call comes before the reader
  // stops ('beforeStop') or after it ('afterStop', callAfterMs later); its output waits for .report-go.
  // A coordinator starts a leaf (as in real runs, after the session's loop has ended, or 'inLoop'
  // while it runs); the coordinator's report starts the session's loop, and both the coordinator
  // and that loop stop saying work goes on while the leaf runs, until .leaf-go.
  '      if (scenario.nested && promptCount === 1) {',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-c', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Prompt: 'Coordinate the review.', Role: 'coordinator', TypeName: 'coordinator' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-c', status: 'completed' });",
  "        if (scenario.nested === 'inLoop') startSubagent('agy-subagent-leaf');",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a coordinator.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        setTimeout(() => {',
  "          modelCall('agy-subagent-c');",
  "          if (scenario.nested !== 'inLoop') startSubagent('agy-subagent-leaf');",
  "          runStopHook('agy-subagent-c', false);",
  '          modelCall(sessionId);',
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'COORDINATOR REPORT.' } });",
  "          update({ sessionUpdate: 'usage_update', used: 3500, size: 1048576 });",
  '          runStopHook(sessionId, false);',
  '        }, 50);',
  "        whenTriggered('.leaf-go', () => {",
  "          runStopHook('agy-subagent-leaf', true);",
  "          if (scenario.nested === 'inLoop') whenTriggered('.coordinator-go', () => { modelCall('agy-subagent-c'); runStopHook('agy-subagent-c', true); });",
  '        });',
  '        continue;',
  '      }',
  // The reader stops saying a command of its own still runs while the writer runs; the writer then stops.
  // The first prompt's reader and writer stop after it, and the session reports and ends idle. The
  // second prompt wakes the reader, which then wakes the writer with a message.
  '      if (scenario.peerRewake && promptCount === 1) {',
  "        for (const id of ['agy-invoke-r', 'agy-invoke-w']) {",
  "          update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Prompt: 'Review the fixture.' } });",
  "          update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' });",
  '        }',
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a reader and a writer.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        setTimeout(() => {',
  "          runStopHook('agy-subagent-r', true);",
  "          runStopHook('agy-subagent-w', true);",
  '          modelCall(sessionId);',
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'READER AND WRITER REPORT.' } });",
  "          update({ sessionUpdate: 'usage_update', used: 3500, size: 1048576 });",
  '          runStopHook(sessionId, true);',
  '        }, 50);',
  '        continue;',
  '      }',
  '      if (scenario.peerRewake && promptCount === 2) {',
  '        sendReaderMessage();',
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Asked the reader again.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 4000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        setTimeout(() => {',
  "          modelCall('agy-subagent-w');",
  "          runStopHook('agy-subagent-r', false);",
  "          runStopHook('agy-subagent-w', true);",
  '        }, 50);',
  "        whenTriggered('.reader-go', () => {",
  "          modelCall('agy-subagent-r');",
  "          runStopHook('agy-subagent-r', true);",
  '          modelCall(sessionId);',
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'READER COMMAND REPORT.' } });",
  "          update({ sessionUpdate: 'usage_update', used: 4500, size: 1048576 });",
  '          runStopHook(sessionId, true);',
  '        });',
  '        continue;',
  '      }',
  // The first prompt's coordinator starts a leaf after that prompt; both stop, and the session
  // reports and ends idle. The second prompt wakes the coordinator, which wakes its leaf again.
  '      if (scenario.nestedAgain && promptCount === 1) {',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-c', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Prompt: 'Coordinate.' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-c', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a coordinator.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        setTimeout(() => {',
  "          modelCall('agy-subagent-c');",
  "          startSubagent('agy-subagent-leaf');",
  "          runStopHook('agy-subagent-leaf', true);",
  "          modelCall('agy-subagent-c');",
  "          if (scenario.nestedAgain === 'reportFirst') return reportThenStop('COORDINATOR REPORT.', 'agy-subagent-c');",
  "          runStopHook('agy-subagent-c', true);",
  '          modelCall(sessionId);',
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'COORDINATOR REPORT.' } });",
  "          update({ sessionUpdate: 'usage_update', used: 3500, size: 1048576 });",
  '          runStopHook(sessionId, true);',
  '        }, 50);',
  '        continue;',
  '      }',
  '      if (scenario.nestedAgain && promptCount === 2) {',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-message-c', title: 'Run send_message', status: 'in_progress', rawInput: { Recipient: 'coordinator' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-message-c', status: 'completed' });",
  "        modelCall('agy-subagent-c');",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Asked the coordinator again.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 4000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        setTimeout(() => {',
  "          modelCall('agy-subagent-leaf');",
  "          runStopHook('agy-subagent-c', false);",
  '        }, 50);',
  "        whenTriggered('.leaf-go', () => runStopHook('agy-subagent-leaf', true));",
  '        continue;',
  '      }',
  // Item 1 leaves a reader running, and a command that ends during item 2 or after its answer.
  '      if (scenario.toolOwner && promptCount === 1) {',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-r', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Prompt: 'Review the fixture.' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-r', status: 'completed' });",
  "        if (scenario.toolOwner === 'duringPrompt') update({ sessionUpdate: 'tool_call', toolCallId: 'agy-command-a', title: 'sleep 60', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'sleep 60' } });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a reader.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        if (scenario.toolOwner === 'fromWake') {",
  '          setTimeout(() => {',
  '            modelCall(sessionId);',
  "            update({ sessionUpdate: 'tool_call', toolCallId: 'agy-command-a', title: 'sleep 60', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'sleep 60' } });",
  "            update({ sessionUpdate: 'usage_update', used: 3200, size: 1048576 });",
  '            runStopHook(sessionId, false);',
  "            fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.a-started', '');",
  '          }, 50);',
  '        }',
  '        continue;',
  '      }',
  '      if (scenario.toolOwner && promptCount === 2) {',
  "        const failed = (id, text) => update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text } }] });",
  "        const say = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });",
  "        const notice = '\\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h30m.\\n';",
  "        if (scenario.quotaAround === 'notice') { say(notice); failed('agy-command-a', 'A-SPECIFIC FAILURE.'); }",
  "        else if (scenario.quotaAround === 'quoted') { say('Here is the notice you asked me to quote:'); failed('agy-command-a', 'A-SPECIFIC FAILURE.'); say(notice); }",
  "        else {",
  "          if (scenario.sameWrite) {",
  '            process.stdout.write([',
  "              { sessionUpdate: 'tool_call_update', toolCallId: 'agy-command-a', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'A-SPECIFIC FAILURE.' } }] },",
  "              { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B reply.' } },",
  "            ].map((value) => JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } })).join('\\n') + '\\n');",
  '          } else {',
  "            if (scenario.toolOwner === 'afterAnswer') update({ sessionUpdate: 'tool_call', toolCallId: 'agy-command-b', title: 'sleep 60', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'sleep 60' } });",
  "            else failed('agy-command-a', 'A-SPECIFIC FAILURE.');",
  "            say('B reply.');",
  '          }',
  "        }",
  "        update({ sessionUpdate: 'usage_update', used: 4000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        if (scenario.toolOwner === 'afterAnswer') setTimeout(() => failed('agy-command-b', 'B-SPECIFIC FAILURE.'), 50);",
  "        whenTriggered('.reader-stop', () => runStopHook('agy-subagent-r', true));",
  '        continue;',
  '      }',
  // A turn agy starts on its own reports a call only once the call has ended.
  '      if (scenario.terminalOnly && promptCount === 1) {',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-r', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Prompt: 'Review the fixture.' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-r', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a reader.' } });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        whenTriggered('.go', () => {",
  '          modelCall(sessionId);',
  "          update({ sessionUpdate: 'tool_call', toolCallId: 'agy-read-late', title: 'Read notes.md', kind: 'read', status: 'completed' });",
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All work finished.' } });",
  '          runStopHook(sessionId, false);',
  "          runStopHook('agy-subagent-r', true);",
  '        });',
  '        continue;',
  '      }',
  '      if (scenario.peerWork && promptCount === 1) {',
  "        for (const [id, name] of [['agy-invoke-r', 'reader'], ['agy-invoke-w', 'writer']]) {",
  "          update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Prompt: 'Review the fixture.', Role: name, TypeName: name } });",
  "          update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' });",
  '        }',
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a reader and a writer.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        setTimeout(() => { runStopHook('agy-subagent-r', false); runStopHook('agy-subagent-w', true); }, 50);",
  "        whenTriggered('.reader-go', () => {",
  "          modelCall('agy-subagent-r');",
  "          runStopHook('agy-subagent-r', true);",
  '          modelCall(sessionId);',
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'READER COMMAND REPORT.' } });",
  "          update({ sessionUpdate: 'usage_update', used: 3500, size: 1048576 });",
  '          runStopHook(sessionId, true);',
  '        });',
  '        continue;',
  '      }',
  // The first prompt leaves a command of the session's own running beside a reader.
  '      if (scenario.commandThen && promptCount === 1) {',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-r', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Prompt: 'Review the fixture.', Role: 'reader', TypeName: 'reader' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-r', status: 'completed' });",
  '        if (!scenario.ownTool) {',
  "          update({ sessionUpdate: 'tool_call', toolCallId: 'agy-command-a', title: 'sleep 60', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'sleep 60', WaitMsBeforeAsync: 50 } });",
  '        }',
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: scenario.ownTool ? 'Started a reader.' : 'Started a command and a reader.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        whenTriggered('.command-go', () => {",
  "          update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-command-a', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'done' } }] });",
  '          modelCall(sessionId);',
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'COMMAND A FINISHED.' } });",
  "          update({ sessionUpdate: 'usage_update', used: 3500, size: 1048576 });",
  '          runStopHook(sessionId, true);',
  '        });',
  '        continue;',
  '      }',
  "      if (scenario.commandThen === 'append' && promptCount === 2) {",
  "        if (scenario.ownTool) update({ sessionUpdate: 'tool_call', toolCallId: 'agy-command-b', title: 'Read notes.md', kind: 'read', status: 'in_progress', locations: [{ path: '/work/notes.md' }] });",
  '        pendingPromptId = msg.id;',
  "        fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.b-start', '');",
  '        continue;',
  '      }',
  "      if (scenario.commandThen === 'append' && promptCount === 3) {",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HANDLED B AND THE FOLLOW-UP.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 4000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        runStopHook('agy-subagent-r', true);",
  '        continue;',
  '      }',
  '      if (scenario.reportLoop && promptCount === 1) {',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-r', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Subagents: [] } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-r', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a reader.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        setTimeout(() => {',
  "          if (scenario.reportLoop === 'beforeStop') modelCall(sessionId);",
  "          runStopHook('agy-subagent-r', true);",
  "          if (scenario.reportLoop === 'afterStop') setTimeout(() => modelCall(sessionId), scenario.callAfterMs || 0);",
  '        }, 50);',
  "        whenTriggered('.report-go', () => {",
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PRIMARY REPORT.' } });",
  "          update({ sessionUpdate: 'usage_update', used: 3500, size: 1048576 });",
  '          runStopHook(sessionId, true);',
  '        });',
  '        continue;',
  '      }',
  '      if (scenario.twoSubagents && promptCount === 1) {',
  "        for (const id of scenario.twoSubagents === 'split' ? ['agy-invoke-r', 'agy-invoke-w'] : ['agy-invoke-rw']) {",
  "          update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Subagents: [] } });",
  "          update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' });",
  '        }',
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a reader and a writer.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        setTimeout(() => runStopHook('agy-subagent-r', true), 50);",
  "        whenTriggered('.writer-go', () => reportThenStop('WRITER REPORT.', 'agy-subagent-w'));",
  '        continue;',
  '      }',
  // The reader stops, the session sends it a follow-up that wakes it, then the writer stops.
  '      if (scenario.rewake && promptCount === 1) {',
  "        for (const id of ['agy-invoke-r', 'agy-invoke-w']) {",
  "          update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Subagents: [] } });",
  "          update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' });",
  '        }',
  "        runStopHook('agy-subagent-r', true);",
  '        sendReaderMessage();',
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The reader has a follow-up.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        setTimeout(() => runStopHook('agy-subagent-w', true), 50);",
  "        whenTriggered('.reader-go', () => reportThenStop('READER SECOND REPORT.', 'agy-subagent-r'));",
  '        continue;',
  '      }',
  // The first prompt's reader reports and the session ends idle; the second prompt only wakes that reader.
  '      if (scenario.wakeOnly && promptCount === 1) {',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-r', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Subagents: [] } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-r', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a reader.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        setTimeout(() => {',
  "          runStopHook('agy-subagent-r', true);",
  '          modelCall(sessionId);',
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'READER REPORT.' } });",
  "          update({ sessionUpdate: 'usage_update', used: 3500, size: 1048576 });",
  '          runStopHook(sessionId, true);',
  '        }, 50);',
  '        continue;',
  '      }',
  '      if (scenario.wakeOnly && promptCount === 2) {',
  '        sendReaderMessage();',
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Asked the reader again.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 4000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        whenTriggered('.reader-go', () => reportThenStop('READER SECOND REPORT.', 'agy-subagent-r'));",
  '        continue;',
  '      }',
  '      if (scenario.failsAround && promptCount === 1) {',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-x', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'nobody' } });",
  "        if (scenario.failsAround === 'before') failInvoke();",
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-1', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'reader' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-1', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a subagent.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  "        runStopHook('agy-subagent-1', true);",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "        if (scenario.failsAround === 'after') setTimeout(failInvoke, 100);",
  '        const finish = setInterval(() => {',
  '          if (!fs.existsSync(process.env.WAKE_TRIGGER_PATH)) return;',
  '          clearInterval(finish);',
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FINAL REPORT.' } });",
  "          update({ sessionUpdate: 'usage_update', used: 3500, size: 1048576 });",
  '          runStopHook(sessionId, true);',
  '        }, 10);',
  '        continue;',
  '      }',
  '      if (scenario.wake && promptCount === 1) {',
  '        if (scenario.earlierWork) {',
  "          update({ sessionUpdate: 'tool_call', toolCallId: 'agy-helper-0', title: 'Run start_helper', status: 'in_progress', rawInput: { Name: 'helper' } });",
  "          update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-helper-0', status: 'completed' });",
  "          update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-0', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'counter' } });",
  "          update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-0', status: 'completed' });",
  "          runStopHook('agy-helper-0', true);",
  "          if (!scenario.earlierStopLost) runStopHook('agy-subagent-0', true);",
  "          runStopHook(sessionId, true, 'an earlier loop');",
  "          fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.earlier', '');",
  '        }',
  '        if (scenario.invokeFails) {',
  "          update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-x', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'nobody' } });",
  "          if (scenario.invokeFails !== 'afterStop') failInvoke();",
  '        }',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-1', title: scenario.invokeTitle || 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'reader' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-1', status: 'completed' });",
  '        if (scenario.invokeTwice) {',
  "          update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-1b', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'writer' } });",
  "          update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-1b', status: 'completed' });",
  '        }',
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started a subagent.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 3000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  '        if (scenario.early) {',
  "          const report = { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'EARLY REPORT.' } } } };",
  "          const answerAndReport = () => process.stdout.write([{ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }, report].map((value) => JSON.stringify(value)).join('\\n') + '\\n');",
  '          const lateRead = () => {',
  '            runStopHook(sessionId, true);',
  '            answerAndReport();',
  "            fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.early', '');",
  '          };',
  "          if (scenario.early === 'lateRead') { lateRead(); continue; }",
  '          answerAndReport();',
  '          setTimeout(() => {',
  '            runStopHook(sessionId, true);',
  "            fs.writeFileSync(process.env.WAKE_TRIGGER_PATH + '.early', '');",
  '          }, 200);',
  '          continue;',
  '        }',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } });",
  '        const trigger = setInterval(() => {',
  '          if (!fs.existsSync(process.env.WAKE_TRIGGER_PATH)) return;',
  '          clearInterval(trigger);',
  '          startWake();',
  '        }, 20);',
  '        continue;',
  '      }',
  '      if (scenario.richTurn && promptCount === 1) {',
  '        pendingPromptId = msg.id;',
  "        send({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'agy-tool-1' }, options: [{ optionId: 'reject', kind: 'reject_once', name: 'Reject' }, { optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'allow-always', kind: 'allow_always', name: 'Always allow' }] } });",
  '        continue;',
  '      }',
  "      if (scenario.wake === 'joined' && promptCount === 2) {",
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-joined-tool', title: 'File notes/summary.md', kind: 'edit', status: 'in_progress', locations: [{ path: '/work/notes/summary.md' }] });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-joined-tool', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Saved the summary and answered.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 5200, size: 1048576 });",
  '        runStopHook(sessionId, true);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        continue;',
  '      }',
  "      if (scenario.second === 'slowLateRead' && promptCount === 2) {",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started another subagent.' } });",
  '        runStopHook(sessionId, false);',
  "        const report = { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'EARLY REPORT.' } } } };",
  '        setTimeout(() => {',
  '          runStopHook(sessionId, true);',
  "          process.stdout.write([{ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }, report].map((value) => JSON.stringify(value)).join('\\n') + '\\n');",
  '        }, 400);',
  '        continue;',
  '      }',
  '      if (scenario.second && promptCount === 2) {',
  "        update({ sessionUpdate: 'tool_call', toolCallId: 'agy-invoke-2', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Name: 'reader' } });",
  "        update({ sessionUpdate: 'tool_call_update', toolCallId: 'agy-invoke-2', status: 'completed' });",
  "        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started another subagent.' } });",
  "        update({ sessionUpdate: 'usage_update', used: 6000, size: 1048576 });",
  '        runStopHook(sessionId, false);',
  "        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  '        const second = setInterval(() => {',
  "          if (!fs.existsSync(process.env.WAKE_TRIGGER_PATH + '.second')) return;",
  '          clearInterval(second);',
  "          runStopHook('agy-subagent-2', true);",
  "          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPORT-B.' } });",
  "          update({ sessionUpdate: 'usage_update', used: 6500, size: 1048576 });",
  '          runStopHook(sessionId, true);',
  '        }, 10);',
  '        continue;',
  '      }',
  "      if (scenario.contextUsed) update({ sessionUpdate: 'usage_update', used: scenario.contextUsed, size: 1048576 });",
  "      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: scenario.richTurn ? ' + appended' : 'reply ' + promptCount } });",
  '      if (scenario.wake) runStopHook(sessionId, wakeDone);',
  "      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });",
  "      if (scenario.lateUsage) update({ sessionUpdate: 'usage_update', used: 7000, size: 1048576 });",
  '    }',
  '  }',
  '});',
];

test('antigravity-cli launches `agy acp` with permissions pre-approved and the machine HOME', () => {
  assert.deepEqual(antigravityAcpLaunchArgs(), ['acp', '--dangerously-skip-permissions']);
  assert.deepEqual(antigravityAcpLaunchArgs(['--disable-telemetry']), [
    'acp',
    '--disable-telemetry',
    '--dangerously-skip-permissions',
  ]);
  assert.deepEqual(antigravityAcpLaunchArgs(['--disable-telemetry'], '/run/agent'), [
    'acp',
    '--disable-telemetry',
    '--dangerously-skip-permissions',
    '--add-dir',
    '/run/agent',
    '--agent',
    'anima-runtime',
  ]);
  const env = antigravityLaunchEnvironment(
    { HOME: '/agent/home', PATH: '/agent/bin' },
    { HOME: '/machine/home', PATH: '/machine/bin' },
  );
  assert.equal(env.HOME, '/machine/home');
  assert.equal(env.PATH, '/agent/bin');
});

test('antigravity-cli writes its system prompt as a custom agent that replaces the default one', () => {
  assert.equal(
    antigravityAgentDefinition('  You are Wren.\n\nBe brief.  ', '/agents/wren'),
    [
      '---',
      'name: anima-runtime',
      'description: Anima agent runtime',
      'excludeDefaultComponents: true',
      'tools: [read_file, write_file, edit_file, run_command, search_web, define_subagent, invoke_subagent, manage_subagents, send_message]',
      '---',
      'You are Wren.',
      '',
      'Be brief.',
      '',
      'Your working directory is /agents/wren.',
      '',
    ].join('\n'),
  );
});

test('antigravity-cli registers Stop and PreInvocation hooks that record only the conversation, idle state, reason and an input digest', async () => {
  const handler = { command: `'/opt/node'\\''s/bin/node' '/dist/hook.js'`, timeout: 10, type: 'command' };
  assert.deepEqual(JSON.parse(antigravityHooksDefinition("/opt/node's/bin/node", '/dist/hook.js')), {
    anima: { PreInvocation: [handler], Stop: [handler] },
  });
  const dir = await mkdtemp(join(tmpdir(), 'anima-agy-hook-'));
  try {
    const script = fileURLToPath(new URL('../providers/antigravity-hook.js', import.meta.url));
    const definition = JSON.parse(antigravityHooksDefinition(process.execPath, script)) as {
      anima: { Stop: Array<{ command: string }> };
    };
    const command = definition.anima.Stop[0]!.command;
    const events = join(dir, 'events.jsonl');
    const payload = JSON.stringify({
      conversationId: 'conv-1',
      fullyIdle: false,
      hookEventName: 'Stop',
      lastUserInput: 'private words',
      terminationReason: 'NO_TOOL_CALL',
      transcriptPath: '/private/transcript.jsonl',
    });
    const run = (input: string, env: NodeJS.ProcessEnv) =>
      spawnSync('sh', ['-c', command], { encoding: 'utf8', env, input });

    const key = 'a'.repeat(64);
    const recorded = run(payload, { ...process.env, ANIMA_ANTIGRAVITY_HOOK_EVENTS: events, ANIMA_ANTIGRAVITY_HOOK_KEY: key });
    assert.equal(recorded.status, 0);
    assert.equal(recorded.stdout, '{}', 'the hook never blocks the stop');
    const [event, ...rest] = await readJsonLines(events);
    assert.equal(rest.length, 0);
    assert.deepEqual(Object.keys(event ?? {}).sort(), ['at', 'conversationId', 'fullyIdle', 'hookEventName', 'input', 'terminationReason']);
    assert.equal(event?.conversationId, 'conv-1');
    assert.equal(event?.fullyIdle, false);
    assert.equal(event?.input, antigravityInputTag(key, 'private words'));
    assert.notEqual(antigravityInputTag(key, 'private words'), antigravityInputTag('b'.repeat(64), 'private words'));
    assert.doesNotMatch(await readFile(events, 'utf8'), /private/);
    // Without a key the input is left out.
    assert.equal(run(payload, { ...process.env, ANIMA_ANTIGRAVITY_HOOK_EVENTS: events }).status, 0);
    const unkeyed = (await readJsonLines(events))[1];
    assert.deepEqual(Object.keys(unkeyed ?? {}).sort(), ['at', 'conversationId', 'fullyIdle', 'hookEventName', 'terminationReason']);

    const { ANIMA_ANTIGRAVITY_HOOK_EVENTS: _unset, ...withoutTarget } = process.env;
    for (const [input, env] of [['not json', { ...process.env, ANIMA_ANTIGRAVITY_HOOK_EVENTS: events }], [payload, withoutTarget]] as const) {
      const result = run(input, env);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '{}');
    }
    assert.equal((await readJsonLines(events)).length, 2);

    // Before a model call of a subagent: its conversation, the event and its earlier steps; not its text.
    const modelCall = JSON.stringify({
      conversationId: 'sub-1',
      hookEventName: 'PreInvocation',
      initialNumSteps: 8,
      invocationNum: 0,
      lastUserInput: 'private task',
      transcriptPath: '/private/sub-1.jsonl',
    });
    const called = run(modelCall, { ...process.env, ANIMA_ANTIGRAVITY_HOOK_EVENTS: events, ANIMA_ANTIGRAVITY_HOOK_KEY: key });
    assert.equal(called.status, 0);
    assert.equal(called.stdout, '{}');
    const [call, ...more] = (await readJsonLines(events)).slice(2);
    assert.equal(more.length, 0);
    assert.deepEqual(Object.keys(call ?? {}).sort(), ['at', 'conversationId', 'hookEventName', 'initialNumSteps', 'input']);
    assert.deepEqual([call?.conversationId, call?.hookEventName, call?.initialNumSteps], ['sub-1', 'PreInvocation', 8]);
    assert.doesNotMatch(await readFile(events, 'utf8'), /private/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('antigravity-cli recognizes the quota notice agy sends as a reply', () => {
  const notice = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h20m5s.';
  assert.equal(antigravityQuotaNotice(`⚠ ${notice}`), notice);
  assert.equal(antigravityQuotaNotice(`\n⚠️ ${notice}\n`), notice);
  assert.equal(antigravityQuotaNotice(`⚠ ${notice.replace('3h20m5s', '45s')}`), notice.replace('3h20m5s', '45s'));
  // Model replies that talk about a quota are replies.
  assert.equal(antigravityQuotaNotice(notice), undefined);
  assert.equal(antigravityQuotaNotice('Individual quota reached. Ask your team admin to raise the daily limit.'), undefined);
  assert.equal(antigravityQuotaNotice('⚠ Individual quota reached. Ask your team admin to raise the daily limit.'), undefined);
  assert.equal(antigravityQuotaNotice(`Working on it.\n⚠ ${notice}`), undefined);
  assert.equal(antigravityQuotaNotice(`⚠ ${notice}\nMore text.`), undefined);
  assert.equal(antigravityQuotaNotice(`agy said: ⚠ ${notice}`), undefined);
  assert.equal(antigravityQuotaNotice('All done.'), undefined);

  const now = new Date('2026-11-22T00:00:00.000Z');
  assert.equal(antigravityQuotaResetsAt(notice, now)?.toISOString(), '2026-11-22T03:20:05.000Z');
  assert.equal(antigravityQuotaResetsAt('Resets in 2d1h.', now)?.toISOString(), '2026-11-24T01:00:00.000Z');
  assert.equal(antigravityQuotaResetsAt('Resets in 45s.', now)?.toISOString(), '2026-11-22T00:00:45.000Z');
  assert.equal(antigravityQuotaResetsAt('Individual quota reached.', now), undefined);
});

test('antigravity-cli refuses the Antigravity app editor launcher', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-agy-launcher-'));
  try {
    const appBin = join(dir, 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin');
    await mkdir(appBin, { recursive: true });
    await writeFile(join(appBin, 'agy'), '#!/bin/sh\n', 'utf8');
    await chmod(join(appBin, 'agy'), 0o755);
    const pathDir = join(dir, 'bin');
    await mkdir(pathDir);
    await symlink(join(appBin, 'agy'), join(pathDir, 'agy'));
    assert.match(antigravityCommandProblem('agy', { PATH: pathDir }) ?? '', /editor launcher, not Antigravity CLI/);

    const cliDir = join(dir, 'cli');
    await mkdir(cliDir);
    await writeFile(join(cliDir, 'agy'), '#!/bin/sh\n', 'utf8');
    await chmod(join(cliDir, 'agy'), 0o755);
    assert.equal(antigravityCommandProblem('agy', { PATH: cliDir }), undefined);
    assert.equal(antigravityCommandProblem('agy', { PATH: join(dir, 'missing') }), undefined);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('antigravity-cli parses ACP select options and names tools by ACP kind', () => {
  const options = parseAcpSelectOptions([
    ...CONFIG_OPTIONS,
    { id: 'grouped', options: [{ group: 'g', name: 'G', options: [{ value: 'a' }, { value: 'b' }] }, { value: 'c' }] },
    { id: 'toggle', type: 'boolean', currentValue: true },
  ]);
  assert.deepEqual(options?.map((option) => option.id), ['model', 'thought_level', 'mode', 'grouped']);
  assert.deepEqual(options?.[3]?.values.map((entry) => entry.value), ['a', 'b', 'c']);
  assert.equal(parseAcpSelectOptions(undefined), undefined);

  assert.equal(antigravityToolName({ kind: 'execute', title: 'ls' }), 'Shell');
  assert.equal(antigravityToolName({ kind: 'edit', title: 'Edit a.ts' }), 'EditFile');
  assert.equal(antigravityToolName({ kind: 'other', title: 'browser subagent: open page' }), 'BrowserSubagent');
  assert.equal(antigravityToolName({}), 'Tool');
});

test('antigravity-cli model catalog comes from the session model select', () => {
  assert.deepEqual(parseAntigravityConfigOptions(CONFIG_OPTIONS), {
    defaultModel: 'gemini-3.8-flash',
    modelReasoningEfforts: { 'gemini-3.8-flash': ['low', 'medium', 'high'] },
    models: ['gemini-3.8-flash', 'claude-sonnet-4-6'],
  });
  // A current model without levels has an empty menu; levels with no known current model belong to none.
  assert.deepEqual(parseAntigravityConfigOptions(CONFIG_OPTIONS.filter((option) => option.category !== 'thought_level')), {
    defaultModel: 'gemini-3.8-flash',
    modelReasoningEfforts: { 'gemini-3.8-flash': [] },
    models: ['gemini-3.8-flash', 'claude-sonnet-4-6'],
  });
  assert.deepEqual(
    parseAntigravityConfigOptions(CONFIG_OPTIONS.map((option) => (option.category === 'model' ? { ...option, currentValue: 'gone' } : option))),
    { defaultModel: 'gemini-3.8-flash', models: ['gemini-3.8-flash', 'claude-sonnet-4-6'] },
  );
  assert.throws(() => parseAntigravityConfigOptions([]), /did not report any models/);
});

/**
 * A fake `agy acp` for the catalog probe. Its session starts on gemini-4-neon. A switch to
 * gemini-4-carbon or gemini-pro-orchestrator (which has no levels) reports that model's levels;
 * one to gemini-broken fails; one to gemini-ignored leaves the model as it was. With
 * `switchHangs`, no switch is answered; with `exitOnSwitchTo`, the process exits (code 7) on
 * the switch to that model. Every request's method and value go to `logPath`.
 */
function catalogProbeAgy(
  logPath: string,
  { exitOnSwitchTo, switchHangs = false }: { exitOnSwitchTo?: string; switchHangs?: boolean } = {},
): string {
  const levels = (...values: string[]) => ({ category: 'thought_level', currentValue: 'high', id: 'thought_level', options: values.map((value) => ({ value })), type: 'select' });
  const models = ['gemini-4-neon', 'gemini-4-carbon', 'gemini-pro-orchestrator', 'gemini-broken', 'gemini-ignored'];
  const model = (currentValue: string) => ({ category: 'model', currentValue, id: 'model', options: models.map((value) => ({ value })), type: 'select' });
  const sessions = {
    'gemini-4-carbon': [model('gemini-4-carbon'), levels('low', 'medium', 'high')],
    'gemini-4-neon': [model('gemini-4-neon'), levels('low', 'medium', 'high', 'xhigh')],
    'gemini-pro-orchestrator': [model('gemini-pro-orchestrator')],
  };
  return [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `const sessions = ${JSON.stringify(sessions)};`,
    `const switchHangs = ${JSON.stringify(switchHangs)};`,
    `const exitOnSwitchTo = ${JSON.stringify(exitOnSwitchTo ?? null)};`,
    "let current = 'gemini-4-neon';",
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk;',
    "  const lines = buffer.split('\\n');",
    "  buffer = lines.pop() || '';",
    '  for (const line of lines) {',
    '    if (!line.trim()) continue;',
    '    const msg = JSON.parse(line);',
    `    fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify([msg.method, msg.params && msg.params.value]) + '\\n');`,
    "    const send = (body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }) + '\\n');",
    "    if (msg.method === 'initialize') send({ result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } } });",
    "    if (msg.method === 'session/new') send({ result: { sessionId: 'probe-session', configOptions: sessions[current] } });",
    "    if (msg.method === 'session/close') send({ result: {} });",
    "    if (msg.method === 'session/set_config_option' && msg.params.value === exitOnSwitchTo) process.exit(7);",
    "    if (msg.method === 'session/set_config_option' && !switchHangs) {",
    "      if (msg.params.value === 'gemini-broken') { send({ error: { code: -32603, message: 'model unavailable' } }); continue; }",
    "      if (sessions[msg.params.value]) current = msg.params.value;",
    '      send({ result: { configOptions: sessions[current] } });',
    '    }',
    '  }',
    '});',
  ].join('\n');
}

test('antigravity-cli catalog probe reads each model\'s thinking levels by switching its own session', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-probe-levels-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const logPath = join(stateDir, 'requests.jsonl');
      const agy = join(stateDir, 'agy');
      await writeFile(agy, catalogProbeAgy(logPath), 'utf8');
      await chmod(agy, 0o755);
      const catalog = await antigravityAcpModelCatalog(agy, { killGraceMs: 100, timeoutMs: 15_000 });
      assert.deepEqual(catalog, {
        defaultModel: 'gemini-4-neon',
        // A switch that failed or left the model as it was gives no menu; a model without levels has an empty one.
        modelReasoningEfforts: {
          'gemini-4-carbon': ['low', 'medium', 'high'],
          'gemini-4-neon': ['low', 'medium', 'high', 'xhigh'],
          'gemini-pro-orchestrator': [],
        },
        models: ['gemini-4-neon', 'gemini-4-carbon', 'gemini-pro-orchestrator', 'gemini-broken', 'gemini-ignored'],
      });
      assert.deepEqual(await readJsonLines(logPath), [
        ['initialize', null],
        ['session/new', null],
        ['session/set_config_option', 'gemini-4-carbon'],
        ['session/set_config_option', 'gemini-pro-orchestrator'],
        ['session/set_config_option', 'gemini-broken'],
        ['session/set_config_option', 'gemini-ignored'],
        ['session/close', null],
      ]);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli catalog probe stops switching models in time to return what it has', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-probe-switch-hangs-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const logPath = join(stateDir, 'requests.jsonl');
      const agy = join(stateDir, 'agy');
      await writeFile(agy, catalogProbeAgy(logPath, { switchHangs: true }), 'utf8');
      await chmod(agy, 0o755);
      // Switches stop at two thirds of the timeout: 4s leaves room for the fake to start
      // and answer session/new under a loaded parallel run, so the first switch is sent.
      const catalog = await antigravityAcpModelCatalog(agy, { killGraceMs: 100, timeoutMs: 6_000 });
      assert.deepEqual(catalog.modelReasoningEfforts, { 'gemini-4-neon': ['low', 'medium', 'high', 'xhigh'] });
      const switches = (await readJsonLines(logPath) as unknown[]).filter((entry) => (entry as unknown[])[0] === 'session/set_config_option');
      assert.deepEqual(switches, [['session/set_config_option', 'gemini-4-carbon']]);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli catalog probe keeps the models and menus it has when agy exits during a switch', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-probe-switch-exits-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const logPath = join(stateDir, 'requests.jsonl');
      const agy = join(stateDir, 'agy');
      await writeFile(agy, catalogProbeAgy(logPath, { exitOnSwitchTo: 'gemini-broken' }), 'utf8');
      await chmod(agy, 0o755);
      const catalog = await withTimeout(antigravityAcpModelCatalog(agy, { killGraceMs: 100, timeoutMs: 15_000 }), 10_000);
      assert.deepEqual(catalog, {
        defaultModel: 'gemini-4-neon',
        modelReasoningEfforts: {
          'gemini-4-carbon': ['low', 'medium', 'high'],
          'gemini-4-neon': ['low', 'medium', 'high', 'xhigh'],
          'gemini-pro-orchestrator': [],
        },
        models: ['gemini-4-neon', 'gemini-4-carbon', 'gemini-pro-orchestrator', 'gemini-broken', 'gemini-ignored'],
      });
      assert.deepEqual(await readJsonLines(logPath), [
        ['initialize', null],
        ['session/new', null],
        ['session/set_config_option', 'gemini-4-carbon'],
        ['session/set_config_option', 'gemini-pro-orchestrator'],
        ['session/set_config_option', 'gemini-broken'],
      ]);
      // Before session/new gives a catalog, an exit is still an error.
      const early = join(stateDir, 'agy-early-exit');
      await writeFile(early, ['#!/usr/bin/env node', 'process.exit(7);'].join('\n'), 'utf8');
      await chmod(early, 0o755);
      await assert.rejects(antigravityAcpModelCatalog(early, { killGraceMs: 100, timeoutMs: 15_000 }), /model catalog probe exited \(7\)/);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli catalog probe survives a JSON null line and kills a child that ignores SIGTERM', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-probe-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const pidPath = join(stateDir, 'probe.pid');
      const agy = join(stateDir, 'agy');
      await writeFile(agy, [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        `const configOptions = ${JSON.stringify(CONFIG_OPTIONS)};`,
        "process.stdout.write('null\\n42\\n');",
        "let buffer = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        "  const lines = buffer.split('\\n');",
        "  buffer = lines.pop() || '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        "    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');",
        "    if (msg.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } });",
        "    if (msg.method === 'session/new') reply({ sessionId: 'probe-session', configOptions });",
        // The session keeps its model, so the levels it reports stay the current model's.
        "    if (msg.method === 'session/set_config_option') reply({ configOptions });",
        "    if (msg.method === 'session/close') reply({});",
        '  }',
        '});',
        'setInterval(() => {}, 1000);',
      ].join('\n'), 'utf8');
      await chmod(agy, 0o755);

      const catalog = await antigravityAcpModelCatalog(agy, { killGraceMs: 100, timeoutMs: 15_000 });
      assert.equal(catalog.defaultModel, 'gemini-3.8-flash');
      assert.deepEqual(catalog.modelReasoningEfforts, { 'gemini-3.8-flash': ['low', 'medium', 'high'] });
      const pid = Number(await readFile(pidPath, 'utf8'));
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli catalog probe times out and still kills a child that ignores SIGTERM', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-probe-timeout-'));
  let pid: number | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const readyPath = join(stateDir, 'ready.pid');
      const agy = join(stateDir, 'agy');
      await writeFile(agy, [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "process.on('SIGTERM', () => {});",
        // Written only after SIGTERM is ignored, so this pid can only end by SIGKILL.
        `fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
        "process.stdin.resume();",
        'setInterval(() => {}, 1000);',
      ].join('\n'), 'utf8');
      await chmod(agy, 0o755);

      // The probe deadline starts at spawn, and a fake that starts slowly under load
      // would lose that race. The test owns the clock and moves it only once the
      // fake is ignoring SIGTERM. setInterval stays real for the polling below.
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const outcome = antigravityAcpModelCatalog(agy, { killGraceMs: 100, timeoutMs: 1_500 }).then(
        () => undefined,
        (error: unknown) => error,
      );
      // A reader can see the file before its contents land; pid 0 would mean the process group.
      const readyPid = () => readFile(readyPath, 'utf8').then((text) => Number(text), () => 0);
      await pollUntil(async () => (await readyPid()) > 0, 30_000);
      pid = await readyPid();

      t.mock.timers.tick(1_500);
      assert.match(String(await outcome), /model catalog probe timed out/);
      await realDelay(200);
      assert.equal(processAlive(pid), true, 'the fake ignored SIGTERM and is waiting for the grace period');
      t.mock.timers.tick(100);
      await pollUntil(() => !processAlive(pid!), 5_000);
    });
  } finally {
    if (pid && pid > 0 && processAlive(pid)) process.kill(pid, 'SIGKILL');
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli catalog probe refuses the app editor launcher without starting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-agy-probe-launcher-'));
  try {
    const appBin = join(dir, 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin');
    const marker = join(dir, 'launched');
    await mkdir(appBin, { recursive: true });
    await writeFile(join(appBin, 'agy'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, 'utf8');
    await chmod(join(appBin, 'agy'), 0o755);
    await symlink(join(appBin, 'agy'), join(dir, 'agy'));
    await assert.rejects(antigravityAcpModelCatalog(join(dir, 'agy')), /editor launcher, not Antigravity CLI/);
    await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('antigravity-cli runs the system prompt as a custom agent, selects model and thinking, and appends follow-ups', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-runtime-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      const launchPath = join(stateDir, 'launch.json');
      const agentsPath = join(stateDir, 'agents.json');
      await installFakeAgy(stateDir);
      const firstCtx = await ingestAgyEvent(stateDir, 'Start Antigravity.', '1786000000.000001');
      const secondCtx = await ingestAgyEvent(stateDir, 'Steer Antigravity.', '1786000000.000002');
      runtime = createAgentRuntime(
        {
          env: agyEnv(
            stateDir,
            { appendSystemPrompt: true, richTurn: true },
            { AGENTS_PATH: agentsPath, LAUNCH_PATH: launchPath },
          ),
          kind: 'antigravity-cli',
          model: 'claude-sonnet-4-6',
          reasoningEffort: 'low',
        },
        { args: ['--disable-telemetry'] },
      );

      const runPromise = runtime.run(await runtimeInput(runtime, firstCtx, await loadState()));
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"method":"session/prompt"')));
      assert.deepEqual(
        await runtime.appendToActiveRun(
          await runtimeFollowupInput(runtime, firstCtx, secondCtx, await loadState()),
        ),
        { accepted: true, text: 'Antigravity follow-up applied (interrupts active prompt)' },
      );
      assert.equal((await withTimeout(runPromise, 3_000)).text, 'handled first + appended');

      const agentDir = join(stateDir, 'run', 'agents', 'anima', 'antigravity-cli-agent');
      const launch = JSON.parse(await readFile(launchPath, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(launch.argv, [
        'acp',
        '--disable-telemetry',
        '--dangerously-skip-permissions',
        '--add-dir',
        agentDir,
        '--agent',
        'anima-runtime',
      ]);
      assert.equal(launch.home, process.env.HOME);
      assert.equal(launch.autoCompact, '240000');
      assert.deepEqual(JSON.parse(await readFile(agentsPath, 'utf8')), {
        argv: ['--add-dir', agentDir, 'agents'],
        cwd: await realpath(stateDir),
      });
      const definition = await readFile(join(agentDir, '.agents', 'agents', 'anima-runtime.md'), 'utf8');
      assert.match(definition, /^---\nname: anima-runtime\n[\s\S]*excludeDefaultComponents: true\n[\s\S]*\n---\n## Who you are\n\nYou are Anima/);
      assert.ok(definition.endsWith(`\n\nYour working directory is ${stateDir}.\n`));
      assert.deepEqual(JSON.parse(await readFile(`${callsPath}.permission`, 'utf8')), {
        outcome: { optionId: 'allow-always', outcome: 'selected' },
      });
      assert.equal(runtime.health?.().child?.version, '1.5.3');

      const calls = await readJsonLines(callsPath);
      // Before a prompt, Anima reads up to the answer to a request agy does not know.
      assert.deepEqual(methodsOf(calls).slice(0, 6), [
        'initialize',
        'session/new',
        'session/set_config_option',
        'session/set_config_option',
        '_anima/barrier',
        'session/prompt',
      ]);
      const sessionNew = calls.find((call) => call.method === 'session/new')?.params as Record<string, unknown>;
      assert.equal('_meta' in sessionNew, false, 'the custom agent carries the system prompt');
      assert.deepEqual(
        calls.filter((call) => call.method === 'session/set_config_option').map((call) => call.params),
        [
          { configId: 'model', sessionId: 'agy-session-new', value: 'claude-sonnet-4-6' },
          { configId: 'thought_level', sessionId: 'agy-session-new', value: 'low' },
        ],
      );
      const prompts = promptTexts(calls);
      assert.equal(prompts.length, 2);
      assert.doesNotMatch(prompts[0] ?? '', /You are Anima/);
      assert.match(prompts[0] ?? '', /Start Antigravity\./);
      assertFollowupPrompt(prompts[1] ?? '', 'Steer Antigravity.');
      assert.deepEqual(await providerSessionStartedPayload(firstCtx.item.id), {
        kind: 'antigravity-cli',
        resumed: false,
      });

      const state = await loadState();
      assert.equal(state.sessions.anima?.current?.id, 'agy-session-new');
      assert.equal(state.sessions.anima?.latestProviderStats?.currentContextTokens, 4096);
      assert.equal(state.sessions.anima?.latestProviderStats?.contextWindow, 1_048_576);
      assert.equal(state.sessions.anima?.latestProviderStats?.autoCompactWindow, 240_000);
      const activities = allActivities(state);
      const shell = activities.find((activity) =>
        activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-tool-1');
      assert.equal(shell?.payload?.['tool'], 'antigravity.Shell');
      assert.equal(shell?.payload?.['command'], 'pwd');
      const read = activities.find((activity) =>
        activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-tool-2');
      assert.equal(read?.payload?.['tool'], 'antigravity.ReadFile');
      assert.equal(read?.payload?.['target'], '/work/notes.md');
      assert.ok(activities.some((activity) =>
        activity.type === 'tool.call.failed' && activity.payload?.['providerToolId'] === 'agy-tool-2'));
      assert.ok(activities.some((activity) =>
        activity.type === 'runtime.event'
          && activity.payload?.['eventType'] === 'antigravity.model.selected'
          && activity.payload?.['model'] === 'claude-sonnet-4-6'
          && activity.payload?.['reasoningEffort'] === 'low'));
      for (const hiddenEventType of [
        'antigravity.system.init',
        'antigravity.turn.started',
        'antigravity.thinking.delta',
        'provider.reasoning',
        'antigravity.tool_result',
        'antigravity.turn.completed',
      ]) {
        assert.equal(
          activities.some((activity) => activity.type === 'runtime.event' && activity.payload?.['eventType'] === hiddenEventType),
          false,
          hiddenEventType,
        );
      }
      const usage = await agentTokenUsageServiceForAgent('anima').summary({
        agentName: 'Anima',
        from: '2000-01-01',
        through: '2100-01-01',
        timezone: 'UTC',
      });
      assert.equal(usage.reportedRuns, 1);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli rejects the turn when the final transcript write fails', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-finish-write-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Write fails.', '1786000015.000001');
      runtime = createAgentRuntime({ env: agyEnv(stateDir, {}), kind: 'antigravity-cli' });
      const input = await runtimeInput(runtime, ctx, await loadState());
      const failing = {
        ...input,
        effects: {
          ...input.effects,
          recordAgentText: async () => {
            throw new Error('transcript write failed');
          },
        },
      };
      await assert.rejects(withTimeout(runtime.run(failing), 3_000), /transcript write failed/);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli keeps the current model, skips an unavailable thinking level, and prepends the prompt when neither agent nor append is available', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-defaults-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Use defaults.', '1786000010.000001');
      runtime = createAgentRuntime({
        env: agyEnv(stateDir, { agents: 'none' }),
        kind: 'antigravity-cli',
        model: 'gemini-3.8-flash',
        reasoningEffort: 'max',
      });

      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'reply 1');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(methodsOf(calls), ['initialize', 'session/new', '_anima/barrier', 'session/prompt']);
      const sessionNew = calls.find((call) => call.method === 'session/new')?.params as Record<string, unknown>;
      assert.equal('_meta' in sessionNew, false);
      assert.match(promptTexts(calls)[0] ?? '', /You are Anima[\s\S]*---[\s\S]*Use defaults\./);
      assert.ok(allActivities(await loadState()).some((activity) =>
        activity.payload?.['eventType'] === 'antigravity.effort.unavailable'
          && activity.payload?.['reasoningEffort'] === 'max'));
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli saves a thinking level the probed menu lacks, and the next turn applies it', async () => {
  // A version manager's shim runs another agy where a directory pins one (mise with a
  // mise.toml in the agent home), with no file changing. The probe runs outside the pin,
  // so its menu does not describe the agent's agy: saves keep the write vocabulary.
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-pinned-'));
  const previousEnv = Object.fromEntries(['PATH', 'AGY_CONFIG_OPTIONS', 'AGY_SCENARIO', 'CALLS_PATH'].map((key) => [key, process.env[key]]));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      const shims = join(stateDir, 'shims');
      await mkdir(shims);
      const probed = join(stateDir, 'agy-global');
      const pinned = join(stateDir, 'agy-pinned');
      await writeFile(probed, catalogProbeAgy(join(stateDir, 'probe.log')).replace('#!/usr/bin/env node', `#!${process.execPath}`), 'utf8');
      await writeFile(pinned, [`#!${process.execPath}`, ...FAKE_AGY].join('\n'), 'utf8');
      await writeFile(join(shims, 'agy'), [
        '#!/bin/sh',
        'if [ "$1" = --version ]; then echo agy 1.5.3; exit 0; fi',
        `if [ -f .agy-pin ]; then exec ${shellQuote(pinned)} "$@"; fi`,
        `exec ${shellQuote(probed)} "$@"`,
        '',
      ].join('\n'), 'utf8');
      for (const file of [probed, pinned, join(shims, 'agy')]) await chmod(file, 0o755);
      await writeFile(join(stateDir, '.agy-pin'), '', 'utf8');
      const pinnedOptions = [
        { category: 'model', currentValue: 'gemini-4-carbon', id: 'model', options: [{ value: 'gemini-4-carbon' }], type: 'select' },
        { category: 'thought_level', currentValue: 'high', id: 'thought_level', options: [{ value: 'high' }, { value: 'xhigh' }], type: 'select' },
      ];
      Object.assign(process.env, {
        AGY_CONFIG_OPTIONS: JSON.stringify(pinnedOptions),
        AGY_SCENARIO: JSON.stringify({ agents: 'none' }),
        CALLS_PATH: callsPath,
        PATH: `${shims}:/usr/bin:/bin`,
      });

      const availability = (await defaultSystemService.providerAvailability()).providers.find((entry) => entry.kind === 'antigravity-cli');
      assert.deepEqual(availability?.modelReasoningEfforts?.['gemini-4-carbon'], ['low', 'medium', 'high']);

      await ensureTestAgentConfig({ agentId: 'anima', stateDir });
      const configPath = join(stateDir, 'agents', 'anima', 'config.json');
      await writeFile(configPath, JSON.stringify({
        enabled: true,
        homePath: stateDir,
        id: 'anima',
        profile: { displayName: 'Anima', role: 'test' },
        provider: { kind: 'antigravity-cli', model: 'gemini-4-carbon' },
      }), 'utf8');
      const saved = async () => (JSON.parse(await readFile(configPath, 'utf8')) as AgentConfig).provider;
      const service = new AgentService('anima');
      await service.updateProvider({ reasoningEffort: 'xhigh' });
      assert.equal((await saved()).reasoningEffort, 'xhigh');
      await service.updateProvider({ model: 'gemini-4-carbon' });
      assert.equal((await saved()).reasoningEffort, 'xhigh');

      const ctx = await ingestAgyEvent(stateDir, 'Think it through.', '1786000011.000001');
      runtime = createAgentRuntime(await saved());
      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'reply 1');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(
        calls.filter((call) => call.method === 'session/set_config_option').map((call) => call.params),
        [{ configId: 'thought_level', sessionId: 'agy-session-new', value: 'xhigh' }],
      );
    });
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli passes agy the context limit an agent sets for itself', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-compact-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const launchPath = join(stateDir, 'launch.json');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Compact later.', '1786000012.000101');
      runtime = createAgentRuntime({
        env: agyEnv(stateDir, {}, { AGY_CLI_AUTO_COMPACT_OVERRIDE: '0.5M', LAUNCH_PATH: launchPath }),
        kind: 'antigravity-cli',
      });
      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'reply 1');
      const launch = JSON.parse(await readFile(launchPath, 'utf8')) as Record<string, unknown>;
      assert.equal(launch.autoCompact, '0.5M');
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

for (const agents of ['none', 'fail'] as const) {
  test(`antigravity-cli appends the system prompt when agy ${agents === 'none' ? 'does not find' : 'cannot list'} the custom agent`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-agent-missing-'));
    let runtime: AgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const callsPath = join(stateDir, 'calls.jsonl');
        const launchPath = join(stateDir, 'launch.json');
        await installFakeAgy(stateDir);
        const ctx = await ingestAgyEvent(stateDir, 'Append instead.', '1786000012.000001');
        runtime = createAgentRuntime({
          env: agyEnv(stateDir, { agents, appendSystemPrompt: true }, { LAUNCH_PATH: launchPath }),
          kind: 'antigravity-cli',
        });

        assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'reply 1');
        const launch = JSON.parse(await readFile(launchPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(launch.argv, ['acp', '--dangerously-skip-permissions']);
        const calls = await readJsonLines(callsPath);
        const sessionNew = calls.find((call) => call.method === 'session/new')?.params as Record<string, unknown>;
        const meta = sessionNew._meta as { antigravity?: { systemPrompt?: { append?: string } } };
        assert.match(meta.antigravity?.systemPrompt?.append ?? '', /You are Anima/);
        assert.doesNotMatch(promptTexts(calls)[0] ?? '', /You are Anima/);
        const unavailable = allActivities(await loadState()).find((activity) =>
          activity.payload?.['eventType'] === 'antigravity.agent.unavailable');
        assert.match(
          String(unavailable?.payload?.['problem']),
          agents === 'none' ? /did not list the agent/ : /unknown command|Command failed/,
        );
      });
    } finally {
      await runtime?.close?.();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

for (const scenario of [
  { name: 'reply', quotaNotice: true, resetMs: (3 * 3600 + 20 * 60 + 5) * 1000, usage: true },
  { name: 'reply after a tool step', quotaNotice: 'afterTool', resetMs: (3 * 3600 + 20 * 60 + 5) * 1000, usage: true },
  { name: 'reply after a tool step reported once', quotaNotice: 'afterOneNotice', resetMs: (3 * 3600 + 20 * 60 + 5) * 1000, usage: true },
  { name: 'error', quotaError: true, resetMs: 90 * 60 * 1000, usage: false },
]) {
  test(`antigravity-cli treats a quota notice ${scenario.name} as quota exhausted until it resets`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-quota-'));
    let runtime: AgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        await installFakeAgy(stateDir);
        const ctx = await ingestAgyEvent(stateDir, 'Out of quota.', '1786000014.000001');
        runtime = createAgentRuntime({ env: agyEnv(stateDir, scenario), kind: 'antigravity-cli' });
        const before = Date.now();
        const error = await runtime.run(await runtimeInput(runtime, ctx, await loadState())).then(
          () => assert.fail('the turn should fail'),
          (failure: unknown) => failure,
        );
        assert.match(String(error), /Antigravity: Individual quota reached\./);
        assert.equal(classifyProviderRetry(error), 'rate_limited');
        const resumeAt = providerRateLimitResumeAt(error, new Date(before)).getTime();
        assert.ok(Math.abs(resumeAt - (before + scenario.resetMs)) < 60_000, String(new Date(resumeAt)));
        assert.equal(
          allActivities(await loadState()).some((activity) => activity.type === 'agent.text'),
          false,
          'the notice is not recorded as the agent reply',
        );
        if (scenario.usage) await assertUsageRecordedOnce();
      });
    } finally {
      await runtime?.close?.();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

test('antigravity-cli keeps a follow-up reply that quotes the quota notice when a call agy started between the prompts ends inside it', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-quota-followup-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeAgy(stateDir);
      const firstCtx = await ingestAgyEvent(stateDir, 'Start on this.', '1786000053.000001');
      const secondCtx = await ingestAgyEvent(stateDir, 'Quote the quota notice.', '1786000053.000002');
      runtime = createAgentRuntime({ env: agyEnv(stateDir, { quotaAfterFollowup: true }), kind: 'antigravity-cli' });
      const active = runtime;
      const runPromise = active.run(await runtimeInput(active, firstCtx, await loadState()));
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"method":"session/prompt"')));
      assert.equal(
        (await active.appendToActiveRun(await runtimeFollowupInput(active, firstCtx, secondCtx, await loadState()))).accepted,
        true,
      );
      // The read is not a step of the follow-up prompt, though it is on the same item.
      const result = await withTimeout(runPromise, 5_000);
      assert.match(result.text ?? '', /^Here is the notice you asked me to quote:\s+⚠ Individual quota reached\. .* Resets in 1h30m\.\s*$/);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli keeps a reply that only mentions a quota', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-quota-text-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'What does the limit say?', '1786000015.000001');
      runtime = createAgentRuntime({ env: agyEnv(stateDir, { quotaLookalike: true }), kind: 'antigravity-cli' });
      assert.equal(
        (await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text,
        'Individual quota reached. Ask your team admin to raise the daily limit.',
      );
      await assertUsageRecordedOnce();
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli kills a stuck agent check, appends the prompt, and frees the launch permit', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-agent-hang-'));
  const runtimes: AgentRuntime[] = [];
  let pids: number[] = [];
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      const pidPaths = { cli: join(stateDir, 'agents.pid'), wrapper: join(stateDir, 'wrapper.pid') };
      await installWrappedFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Check hangs.', '1786000016.000001');
      const stuck = new AntigravityCliAgentRuntime(
        {
          env: agyEnv(
            stateDir,
            { agents: 'hang', appendSystemPrompt: true },
            { AGENTS_PID_PATH: pidPaths.cli, WRAPPER_PID_PATH: pidPaths.wrapper },
          ),
          kind: 'antigravity-cli',
        },
        'agy',
        [],
        // Long enough for the fake to start ignoring SIGTERM before the deadline.
        { agentCheck: { killGraceMs: 200, timeoutMs: 3_000 } },
      );
      runtimes.push(stuck);

      assert.equal((await stuck.run(await runtimeInput(stuck, ctx, await loadState()))).text, 'reply 1');
      pids = [await readPid(pidPaths.wrapper), await readPid(pidPaths.cli)];
      assert.equal(processAlive(pids[0]!), false, 'the wrapper script exited');
      assert.equal(processAlive(pids[1]!), false, 'the CLI it started ignored SIGTERM and was killed');
      const sessionNew = (await readJsonLines(callsPath)).find((call) => call.method === 'session/new')
        ?.params as Record<string, unknown>;
      const meta = sessionNew._meta as { antigravity?: { systemPrompt?: { append?: string } } };
      assert.match(meta.antigravity?.systemPrompt?.append ?? '', /You are Anima/);
      const unavailable = allActivities(await loadState()).find((activity) =>
        activity.payload?.['eventType'] === 'antigravity.agent.unavailable');
      assert.match(String(unavailable?.payload?.['problem']), /did not finish within 3000 ms/);

      // The launch permit is free again: the next agy start goes through.
      const next = createAgentRuntime({ env: agyEnv(stateDir, {}), kind: 'antigravity-cli' });
      runtimes.push(next);
      const nextCtx = await ingestAgyEvent(stateDir, 'Next start.', '1786000016.000002');
      const nextRun = next.run(await runtimeInput(next, nextCtx, await loadState()));
      assert.equal((await withTimeout(nextRun, 10_000)).text, 'reply 1');
    });
  } finally {
    for (const runtime of runtimes) await runtime.close?.();
    killLeftovers(pids);
    await rm(stateDir, { force: true, recursive: true });
  }
});

for (const when of ['during the agent check', 'while recording that the agent is unavailable'] as const) {
  test(`antigravity-cli starts no agy session after a Stop ${when}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-agent-stop-'));
    let runtime: AgentRuntime | undefined;
    let pids: number[] = [];
    try {
      await withAnimaHome(stateDir, async () => {
        const pidPaths = { cli: join(stateDir, 'agents.pid'), wrapper: join(stateDir, 'wrapper.pid') };
        const launchPath = join(stateDir, 'launch.json');
        await installWrappedFakeAgy(stateDir);
        const ctx = await ingestAgyEvent(stateDir, 'Stop early.', '1786000017.000001');
        runtime = createAgentRuntime({
          env: agyEnv(
            stateDir,
            { agents: when === 'during the agent check' ? 'hang' : 'none', appendSystemPrompt: true },
            { AGENTS_PID_PATH: pidPaths.cli, LAUNCH_PATH: launchPath, WRAPPER_PID_PATH: pidPaths.wrapper },
          ),
          kind: 'antigravity-cli',
        });
        const stop = new AbortController();
        const base = await runtimeInput(runtime, ctx, await loadState());
        const input = {
          ...base,
          effects: {
            ...base.effects,
            recordEvent: async (payload: Record<string, unknown>) => {
              if (payload['eventType'] === 'antigravity.agent.unavailable') stop.abort('stop');
              await base.effects.recordEvent(payload);
            },
          },
          signal: stop.signal,
        };
        const outcome = runtime.run(input).then(() => assert.fail('the turn should stop'), (error: unknown) => error);
        if (when === 'during the agent check') {
          await pollUntil(async () => (await readPid(pidPaths.cli).catch(() => 0)) > 0, 30_000);
          pids = [await readPid(pidPaths.wrapper), await readPid(pidPaths.cli)];
          stop.abort('stop');
        }
        await withTimeout(outcome, 10_000);
        if (pids.length > 0) {
          assert.equal(processAlive(pids[0]!), false, 'the wrapper script exited');
          assert.equal(processAlive(pids[1]!), false, 'the CLI it started was killed');
        }
        await assert.rejects(readFile(launchPath, 'utf8'), { code: 'ENOENT' }, 'agy acp never started');
        await assert.rejects(readFile(join(stateDir, 'calls.jsonl'), 'utf8'), { code: 'ENOENT' });
        assert.equal((await loadState()).sessions.anima?.current?.id, undefined);
      });
    } finally {
      await runtime?.close?.();
      killLeftovers(pids);
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

test('antigravity-cli fails clearly when the account does not offer the configured model', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-model-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Use Argon.', '1786000020.000001');
      runtime = createAgentRuntime({
        env: agyEnv(stateDir, { appendSystemPrompt: true }),
        kind: 'antigravity-cli',
        model: 'gemini-4-argon',
      });

      await assert.rejects(
        runtime.run(await runtimeInput(runtime, ctx, await loadState())),
        /does not offer gemini-4-argon to the signed-in account \(available: gemini-3\.8-flash, claude-sonnet-4-6\)/,
      );
      assert.equal(methodsOf(await readJsonLines(callsPath)).includes('session/prompt'), false);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli resumes a persisted session without resending the system prompt', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-resume-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Resume Antigravity.', '1786000030.000001');
      await runtimeSessionServiceForAgent('anima').persistProviderSession('antigravity-cli', {
        id: 'agy-session-existing',
        updatedAt: '2026-11-08T00:00:00.000Z',
      });
      runtime = createAgentRuntime({
        env: agyEnv(stateDir, { appendSystemPrompt: true, resume: 'ok' }),
        kind: 'antigravity-cli',
        model: 'gemini-3.8-flash',
      });

      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'reply 1');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(methodsOf(calls), ['initialize', 'session/resume', '_anima/barrier', 'session/prompt']);
      assert.deepEqual(calls[1]?.params, { cwd: stateDir, mcpServers: [], sessionId: 'agy-session-existing' });
      assert.doesNotMatch(promptTexts(calls)[0] ?? '', /You are Anima/);
      assert.deepEqual(await providerSessionStartedPayload(ctx.item.id), {
        id: 'agy-session-existing',
        kind: 'antigravity-cli',
        resumed: true,
      });
      assert.equal((await loadState()).sessions.anima?.current?.id, 'agy-session-existing');
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli creates a fresh session when the persisted one is gone', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-resume-missing-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Recover Antigravity.', '1786000040.000001');
      await runtimeSessionServiceForAgent('anima').persistProviderSession('antigravity-cli', {
        id: 'agy-session-missing',
        updatedAt: '2026-11-08T00:00:00.000Z',
      });
      runtime = createAgentRuntime({
        env: agyEnv(stateDir, { agents: 'none', appendSystemPrompt: true, resume: 'missing' }),
        kind: 'antigravity-cli',
      });

      assert.equal((await runtime.run(await runtimeInput(runtime, ctx, await loadState()))).text, 'reply 1');
      const calls = await readJsonLines(callsPath);
      assert.deepEqual(methodsOf(calls), ['initialize', 'session/resume', 'session/new', '_anima/barrier', 'session/prompt']);
      const sessionNew = calls.find((call) => call.method === 'session/new')?.params as Record<string, unknown>;
      assert.ok(sessionNew._meta, 'a fresh session carries the system prompt');
      assert.equal((await loadState()).sessions.anima?.current?.id, 'agy-session-new');
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

for (const scenario of [
  { name: 'starts a new session for the next item once a turn leaves the context at its limit', used: 5_000 },
  { name: 'keeps the session for the next item while the context is below its limit', used: 4_999 },
]) {
  test(`antigravity-cli ${scenario.name}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-context-limit-'));
    let worker: AgentRuntimeWorker | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const callsPath = join(stateDir, 'calls.jsonl');
        await ensureTestAgentConfig({ agentId: 'anima', stateDir });
        await installFakeAgy(stateDir);
        const runtime = createAgentRuntime({
          env: agyEnv(stateDir, { contextUsed: scenario.used, uniqueSessions: true }, { AGY_CLI_AUTO_COMPACT_OVERRIDE: '5K' }),
          kind: 'antigravity-cli',
        });
        const started = new AgentRuntimeWorker(
          { agentId: 'anima', agentRuntime: runtime, homePath: stateDir, queue: new WakeQueueService('anima'), stateDir },
          { error() {}, log() {} },
        );
        worker = started;
        await ingestAgyEvent(stateDir, 'Fill the context.', '1786000041.000001');
        assert.equal(await started.drainOnce(), 1);
        const before = (await loadState()).sessions.anima;
        const first = before?.current?.id;
        assert.match(first ?? '', /^agy-session-\d+$/);
        assert.equal(before?.latestProviderStats?.currentContextTokens, scenario.used);
        assert.equal(before?.latestProviderStats?.autoCompactWindow, 5_000);

        const next = await ingestAgyEvent(stateDir, 'Carry on.', '1786000041.000002');
        assert.equal(await started.drainOnce(), 1);
        const state = await loadState();
        const methods = methodsOf(await readJsonLines(callsPath));
        assert.equal(methods.filter((method) => method === 'session/prompt').length, 2);
        assert.equal(methods.includes('session/resume'), false);
        const rotation = allActivities(state).filter((activity) => activity.type === 'anima.session.rotate');
        if (scenario.used < 5_000) {
          assert.equal(methods.filter((method) => method === 'session/new').length, 1);
          assert.equal(state.sessions.anima?.current?.id, first);
          assert.equal(rotation.length, 0);
          return;
        }
        assert.equal(methods.filter((method) => method === 'session/new').length, 2);
        assert.equal(state.sessions.anima?.archived?.[0]?.id, first);
        assert.match(state.sessions.anima?.current?.id ?? '', /^agy-session-\d+$/);
        assert.notEqual(state.sessions.anima?.current?.id, first);
        assert.equal(rotation.length, 1);
        assert.equal(rotation[0]?.payload?.['itemId'], next.item.id);
        assert.equal(rotation[0]?.payload?.['reason'], 'context_limit');
      });
    } finally {
      await worker?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

const QUOTED_QUOTA_TEXTS = [
  'Individual quota reached. Ask your team admin to raise the daily limit.',
  '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h30m.',
];
for (const scenario of [
  { name: 'on session/new', newError: { code: -32000, message: 'Authentication required' } },
  // The error data quotes earlier text that looks like a quota notice; the error is still about sign-in.
  ...QUOTED_QUOTA_TEXTS.map((detail, index) => ({
    name: `on a prompt whose data quotes a quota text (${index + 1})`,
    promptError: { code: -32000, data: { detail }, message: 'Authentication required' },
  })),
]) {
  test(`antigravity-cli turns ACP authentication errors into sign-in guidance ${scenario.name}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-auth-'));
    let runtime: AgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        await installFakeAgy(stateDir);
        const ctx = await ingestAgyEvent(stateDir, 'Sign in please.', '1786000050.000001');
        runtime = createAgentRuntime({ env: agyEnv(stateDir, scenario), kind: 'antigravity-cli' });

        const error = await runtime.run(await runtimeInput(runtime, ctx, await loadState())).then(
          () => assert.fail('the turn should fail'),
          (failure: unknown) => failure,
        );
        assert.match(
          String(error),
          /Antigravity CLI is not signed in on this machine\. Run `agy` in a terminal once and sign in/,
        );
        assert.notEqual(classifyProviderRetry(error), 'rate_limited');
        assert.equal(runtime.health?.().child, undefined);
      });
    } finally {
      await runtime?.close?.();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

const AGY_QUOTA_REASON = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h30m.';
type RpcRetryExpectation =
  | { deferMs: number }
  | { prompts: number; retryClass: 'terminal' | 'transient'; signIn?: boolean };
for (const scenario of [
  { name: 'quota notice', error: { code: -32603, message: AGY_QUOTA_REASON }, expect: { deferMs: 90 * 60_000 } },
  {
    name: 'quota notice whose data quotes a sign-in error',
    error: { code: -32603, data: { detail: 'Previous error: Authentication required' }, message: AGY_QUOTA_REASON },
    expect: { deferMs: 90 * 60_000 },
  },
  {
    name: 'rate limit in its own message',
    error: { code: -32603, message: 'Rate limit exceeded; try again in 2 minutes' },
    expect: { deferMs: 2 * 60_000 },
  },
  { name: 'invalid params', error: { code: -32602, message: 'Invalid params' }, expect: { prompts: 1, retryClass: 'terminal' } },
  {
    name: 'invalid params whose data quotes the quota notice',
    error: { code: -32602, data: { detail: `Invalid example text: ${AGY_QUOTA_REASON}` }, message: 'Invalid params' },
    expect: { prompts: 1, retryClass: 'terminal' },
  },
  {
    name: 'invalid params whose message quotes the quota notice',
    error: { code: -32602, message: `Invalid message template: "${AGY_QUOTA_REASON}"` },
    expect: { prompts: 1, retryClass: 'terminal' },
  },
  {
    // Its own message is about a quota, but the reset time it quotes is not agy's notice.
    name: 'internal error whose message quotes the quota notice',
    error: { code: -32603, message: `Invalid message template: "${AGY_QUOTA_REASON}"` },
    expect: { deferMs: 5 * 60_000 },
  },
  {
    name: 'internal error whose data quotes sign-in and quota text',
    error: { code: -32603, data: { detail: `Authentication required. ${AGY_QUOTA_REASON}` }, message: 'Internal error' },
    expect: { prompts: 4, retryClass: 'transient' },
  },
  {
    name: 'invalid params whose message quotes a sign-in error',
    error: { code: -32602, message: 'Invalid message template: "Authentication required"' },
    expect: { prompts: 1, retryClass: 'terminal' },
  },
  {
    name: 'internal error whose message quotes a sign-in error',
    error: { code: -32603, message: 'Invalid message template: "Authentication required"' },
    expect: { prompts: 1, retryClass: 'terminal' },
  },
  {
    name: 'internal error whose message is a sign-in error',
    error: { code: -32603, message: 'Authentication required' },
    expect: { prompts: 1, retryClass: 'terminal', signIn: true },
  },
  {
    name: 'authentication error whose data quotes the quota notice',
    error: { code: -32000, data: { detail: AGY_QUOTA_REASON }, message: 'Authentication required' },
    expect: { prompts: 1, retryClass: 'terminal', signIn: true },
  },
] satisfies Array<{ error: Record<string, unknown>; expect: RpcRetryExpectation; name: string }>) {
  test(`antigravity-cli retries an ACP ${scenario.name} by its code and own message`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-rpc-retry-'));
    let runtime: AgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        await installFakeAgy(stateDir);
        const ctx = await ingestAgyEvent(stateDir, 'Label the billing chart.', '1786000055.000001');
        runtime = createAgentRuntime({ env: agyEnv(stateDir, { promptError: scenario.error }), kind: 'antigravity-cli' });
        const input = await runtimeInput(runtime, ctx, await loadState());
        const before = Date.now();
        const error = await runProviderWithCrashRetries({
          agentId: 'anima',
          agentRuntime: runtime,
          buildInput: async () => input,
          itemId: input.itemId,
          retry: { transientBackoffMs: [0] },
          signal: new AbortController().signal,
        }).then(
          () => assert.fail('the item should not succeed'),
          (failure: unknown) => failure,
        );
        const expected: RpcRetryExpectation = scenario.expect;
        if ('deferMs' in expected) {
          assert.ok(isProviderRateLimitedError(error), String(error));
          assert.ok(Math.abs(error.resumeAt.getTime() - (before + expected.deferMs)) < 10_000, String(error.resumeAt));
          assert.doesNotMatch(String(error), /not signed in/);
        } else {
          assert.equal(isProviderRateLimitedError(error), false, String(error));
          assert.equal(classifyProviderRetry(error), expected.retryClass, String(error));
          assert.equal(/not signed in on this machine/.test(String(error)), expected.signIn ?? false, String(error));
          if (expected.retryClass === 'terminal') {
            assert.equal(providerFailureReasonFromError(error), expected.signIn ? 'provider_auth_failed' : 'provider_error');
          }
          if ('data' in scenario.error) assert.match(String(error), /data=/, 'data stays for diagnostics');
        }
        const prompts = promptTexts(await readJsonLines(join(stateDir, 'calls.jsonl')));
        assert.equal(prompts.length, 'deferMs' in expected ? 1 : expected.prompts);
      });
    } finally {
      await runtime?.close?.();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

const RESUME_MISSING_QUOTE = 'Previous attempt: Failed to read session agy-session-old; retry, or load it with session/load';
for (const scenario of [
  { name: 'an unknown method', resumeError: { code: -32601, message: 'Method not found' }, outcome: 'terminal' },
  {
    name: 'invalid params that read like a missing session',
    resumeError: { code: -32602, message: 'Failed to read session agy-session-saved; retry, or load it with session/load' },
    outcome: 'terminal',
  },
  {
    name: 'an internal error whose data quotes a missing session',
    resumeError: { code: -32603, data: { detail: RESUME_MISSING_QUOTE }, message: 'Internal error' },
    outcome: 'transient',
  },
  {
    name: 'the quota notice whose data quotes a missing session',
    resumeError: { code: -32603, data: { detail: RESUME_MISSING_QUOTE }, message: AGY_QUOTA_REASON },
    outcome: 'deferred',
  },
  {
    name: 'an authentication error whose data quotes a missing session',
    resumeError: { code: -32000, data: { detail: RESUME_MISSING_QUOTE }, message: 'Authentication required' },
    outcome: 'sign-in',
  },
] as const) {
  test(`antigravity-cli keeps the saved session when resume fails with ${scenario.name}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-resume-error-'));
    let runtime: AgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        await installFakeAgy(stateDir);
        const ctx = await ingestAgyEvent(stateDir, 'Resume Antigravity.', '1786000041.000001');
        await runtimeSessionServiceForAgent('anima').persistProviderSession('antigravity-cli', {
          id: 'agy-session-saved',
          updatedAt: '2026-11-08T00:00:00.000Z',
        });
        runtime = createAgentRuntime({ env: agyEnv(stateDir, { resumeError: scenario.resumeError }), kind: 'antigravity-cli' });
        const input = await runtimeInput(runtime, ctx, await loadState());
        const error = await runProviderWithCrashRetries({
          agentId: 'anima',
          agentRuntime: runtime,
          buildInput: async () => input,
          itemId: input.itemId,
          retry: { transientBackoffMs: [0] },
          signal: new AbortController().signal,
        }).then(
          () => assert.fail('the item should not succeed'),
          (failure: unknown) => failure,
        );
        const outcome = isProviderRateLimitedError(error)
          ? 'deferred'
          : /not signed in on this machine/.test(String(error)) ? 'sign-in' : classifyProviderRetry(error);
        assert.equal(outcome, scenario.outcome, String(error));
        const methods = methodsOf(await readJsonLines(join(stateDir, 'calls.jsonl')));
        assert.equal(methods.includes('session/new'), false, methods.join(','));
        assert.equal(methods.includes('session/prompt'), false, methods.join(','));
        assert.equal((await loadState()).sessions.anima?.current?.id, 'agy-session-saved');
      });
    } finally {
      await runtime?.close?.();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

test('antigravity-cli sends ACP cancel before tearing down an aborted turn', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-cancel-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Cancel Antigravity.', '1786000060.000001');
      runtime = createAgentRuntime({ env: agyEnv(stateDir, { hang: true }), kind: 'antigravity-cli' });
      const abort = new AbortController();
      const run = runtime.run({
        ...(await runtimeInput(runtime, ctx, await loadState())),
        signal: abort.signal,
      });
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"method":"session/prompt"')));
      abort.abort('operator_abort');
      await assert.rejects(run, /Antigravity turn cancelled/);
      const cancel = (await readJsonLines(callsPath)).find((call) => call.method === 'session/cancel');
      assert.deepEqual(cancel?.params, { sessionId: 'agy-session-new' });
      // agy was working on this run's prompt, so it is stopped too.
      const active = runtime;
      await pollUntil(() => active.health?.().child?.alive !== true, 5_000);
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('an Antigravity process that exits cleanly mid-turn is retried as a crash', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-exit-'));
  let runtime: AgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Exit mid-turn.', '1786000070.000001');
      runtime = createAgentRuntime({ env: agyEnv(stateDir, { exitOnPrompt: true }), kind: 'antigravity-cli' });
      const error = await runtime.run(await runtimeInput(runtime, ctx, await loadState())).then(
        () => assert.fail('the turn should fail'),
        (failure: unknown) => failure,
      );
      assert.equal(classifyProviderRetry(error), 'crash', String(error));
    });
  } finally {
    await runtime?.close?.();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli attaches a turn agy starts on its own to the item that left background work', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      const triggerPath = join(stateDir, 'wake-trigger');
      await installFakeAgy(stateDir);
      const firstCtx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000030.000001');
      const secondCtx = await ingestAgyEvent(stateDir, 'Something else.', '1786000030.000002');
      runtime = new AntigravityCliAgentRuntime(
        {
          env: agyEnv(stateDir, { wake: true }, { WAKE_TRIGGER_PATH: triggerPath }),
          kind: 'antigravity-cli',
          providerChildIdleTimeoutMs: 50,
        },
        'agy',
        [],
        // The prompt's answer applies its Stop; the poll applies the self-started turn's Stop,
        // which nothing follows. A quiet period longer than the test leaves only the Stop to end it.
        { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100 } },
      );
      const agentDir = join(stateDir, 'run', 'agents', 'anima', 'antigravity-cli-agent');
      const active = runtime;

      assert.equal((await active.run(await runtimeInput(active, firstCtx, await loadState()))).text, 'Started a subagent.');
      const hooks = JSON.parse(await readFile(join(agentDir, '.agents', 'hooks.json'), 'utf8')) as {
        anima: { Stop: Array<{ command: string }> };
      };
      assert.match(hooks.anima.Stop[0]!.command, /antigravity-hook\.js'$/);
      // The prompt's Stop said a subagent is still running; the subagent's own Stop says nothing about it.
      assert.equal(active.isProviderQuiescent(), false);
      assert.deepEqual(active.health().providerWork, { state: 'background' });
      await realDelay(200);
      assert.equal(active.health().child?.alive, true, 'the idle reset waits for the background work');

      assert.equal((await active.run(await runtimeInput(active, secondCtx, await loadState()))).text, 'reply 2');
      assert.equal(active.isProviderQuiescent(), false);

      await writeFile(triggerPath, '');
      await pollUntil(() => active.isProviderQuiescent() === true, 5_000);
      assert.equal(active.health().providerWork, undefined);
      await pollUntil(async () => allActivities(await loadState()).some((activity) =>
        activity.type === 'agent.text' && activity.payload?.['text'] === 'SUMMARY SAVED'), 5_000);
      const activities = allActivities(await loadState());
      const itemOf = (predicate: (activity: (typeof activities)[number]) => boolean) =>
        activities.filter(predicate).map((activity) => activity.payload?.['itemId']);
      assert.deepEqual(
        itemOf((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-wake-tool'),
        [firstCtx.item.id],
      );
      assert.deepEqual(
        itemOf((activity) => activity.type === 'agent.text' && activity.payload?.['text'] === 'SUMMARY SAVED'),
        [firstCtx.item.id],
      );
      const permission = (await readJsonLines(callsPath)).find((call) => call.id === 'permission-wake');
      assert.deepEqual(permission?.result, { outcome: { optionId: 'allow', outcome: 'selected' } });

      // Quiescent now, so the idle reset retires agy and its hook file.
      await pollUntil(() => active.health().child === undefined, 5_000);
      await pollUntil(async () => (await readdir(join(agentDir, 'events'))).length === 0, 5_000);
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli gives a prompt that joins a self-started turn the output from then on', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-joined-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const triggerPath = join(stateDir, 'wake-trigger');
      await installFakeAgy(stateDir);
      const firstCtx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000032.000001');
      const secondCtx = await ingestAgyEvent(stateDir, 'A new question.', '1786000032.000002');
      runtime = new AntigravityCliAgentRuntime(
        { env: agyEnv(stateDir, { wake: 'joined' }, { WAKE_TRIGGER_PATH: triggerPath }), kind: 'antigravity-cli' },
        'agy',
        [],
        // A quiet period longer than the test, so only the prompt can close the self-started turn.
        { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100 } },
      );
      const active = runtime;
      assert.equal((await active.run(await runtimeInput(active, firstCtx, await loadState()))).text, 'Started a subagent.');

      await writeFile(triggerPath, '');
      await pollUntil(async () => allActivities(await loadState()).some((activity) =>
        activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-wake-read'), 5_000);
      assert.deepEqual(active.health().providerWork, { state: 'working' });

      const second = await active.run(await runtimeInput(active, secondCtx, await loadState()));
      assert.equal(second.text, 'Saved the summary and answered.');
      await pollUntil(() => active.isProviderQuiescent() === true, 5_000);
      const activities = allActivities(await loadState());
      const itemOf = (predicate: (activity: (typeof activities)[number]) => boolean) =>
        activities.filter(predicate).map((activity) => activity.payload?.['itemId']);
      assert.deepEqual(
        itemOf((activity) => activity.type === 'agent.text' && activity.payload?.['text'] === 'Reading the report.'),
        [firstCtx.item.id],
      );
      assert.deepEqual(
        itemOf((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-wake-read'),
        [firstCtx.item.id],
      );
      assert.deepEqual(
        itemOf((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-joined-tool'),
        [secondCtx.item.id],
      );
      // The self-started turn's text is recorded before the prompt that joined it runs.
      const wakeText = activities.findIndex((activity) =>
        activity.type === 'agent.text' && activity.payload?.['text'] === 'Reading the report.');
      const joinedTool = activities.findIndex((activity) =>
        activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-joined-tool');
      assert.ok(wakeText >= 0 && joinedTool > wakeText, `wake text at ${wakeText}, joined tool at ${joinedTool}`);
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

for (const variant of [
  { early: 'together', hold: false, name: 'and Anima reads it at once' },
  // Holding the prompt's last update: the answer is handled after the report's Stop is on disk.
  { early: 'together', hold: true, name: 'and Anima handles the answer late' },
  { early: 'lateRead', hold: false, name: 'and Anima reads it after the report has stopped' },
]) {
  test(`antigravity-cli keeps a report agy sends right after an answer out of that answer ${variant.name}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-early-'));
    let runtime: AntigravityCliAgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const triggerPath = join(stateDir, 'wake-trigger');
        await installFakeAgy(stateDir);
        const ctx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000033.000001');
        runtime = new AntigravityCliAgentRuntime(
          {
            env: agyEnv(stateDir, { early: variant.early, wake: true }, { WAKE_TRIGGER_PATH: triggerPath }),
            kind: 'antigravity-cli',
          },
          'agy',
          [],
          { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100 } },
        );
        const active = runtime;
        const input = await runtimeInput(active, ctx, await loadState());
        let held = false;
        const reply = await active.run({
          ...input,
          effects: {
            ...input.effects,
            async recordEvent(event) {
              if (variant.hold && !held && event['eventType'] === 'antigravity.context.stats' && event['currentContextTokens'] === 3000) {
                held = true;
                await pollUntil(() => fileExists(`${triggerPath}.early`), 5_000);
              }
              return input.effects.recordEvent(event);
            },
          },
        });
        assert.equal(held, variant.hold);
        assert.equal(reply.text, 'Started a subagent.');
        // The prompt's Stop is the first one written after it was sent; the report's Stop
        // closes the report, however late the answer is read.
        await pollUntil(() => active.isProviderQuiescent() === true, 5_000);
        assert.equal(active.health().providerWork, undefined);
        const reports = allActivities(await loadState()).filter((activity) =>
          activity.type === 'agent.text' && activity.payload?.['text'] === 'EARLY REPORT.');
        assert.deepEqual(reports.map((activity) => activity.payload?.['itemId']), [ctx.item.id]);
      });
    } finally {
      await runtime?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

test('antigravity-cli keeps what agy says before a prompt is sent on the self-started turn', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-tail-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      const triggerPath = join(stateDir, 'wake-trigger');
      await installFakeAgy(stateDir);
      const firstCtx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000034.000001');
      const secondCtx = await ingestAgyEvent(stateDir, 'A new question.', '1786000034.000002');
      runtime = new AntigravityCliAgentRuntime(
        { env: agyEnv(stateDir, { wake: 'joined' }, { WAKE_TRIGGER_PATH: triggerPath }), kind: 'antigravity-cli' },
        'agy',
        [],
        { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100 } },
      );
      const active = runtime;
      assert.equal((await active.run(await runtimeInput(active, firstCtx, await loadState()))).text, 'Started a subagent.');
      await writeFile(triggerPath, '');
      await pollUntil(async () => allActivities(await loadState()).some((activity) =>
        activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-wake-read'), 5_000);

      // The second item has started but not yet sent its prompt when agy says more.
      const input = await runtimeInput(active, secondCtx, await loadState());
      const started = deferred();
      const release = deferred();
      const second = active.run({
        ...input,
        effects: {
          ...input.effects,
          async recordEvent(event) {
            if (event['eventType'] === 'antigravity.turn.started') {
              started.resolve();
              await release.promise;
            }
            return input.effects.recordEvent(event);
          },
        },
      });
      try {
        await withTimeout(started.promise, 5_000);
        await writeFile(`${triggerPath}.tail`, '');
        // Its permission request comes after the line, so once it is answered the line was handled.
        await pollUntil(async () => (await readJsonLines(callsPath)).some((call) =>
          call.id === 'tail-seen' && call.result !== undefined), 5_000);
        assert.equal(promptTexts(await readJsonLines(callsPath)).length, 1);
      } finally {
        release.resolve();
      }
      assert.equal((await second).text, 'Saved the summary and answered.');
      await pollUntil(() => active.isProviderQuiescent() === true, 5_000);
      const activities = allActivities(await loadState());
      assert.deepEqual(
        activities
          .filter((activity) => activity.type === 'agent.text' && activity.payload?.['text'] === 'Reading the report.A-TAIL.')
          .map((activity) => activity.payload?.['itemId']),
        [firstCtx.item.id],
      );
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli leaves a later Stop to the poll while a prompt waits for its answer', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-slow-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const triggerPath = join(stateDir, 'wake-trigger');
      await installFakeAgy(stateDir);
      const firstCtx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000040.000001');
      const secondCtx = await ingestAgyEvent(stateDir, 'Delegate more.', '1786000040.000002');
      runtime = new AntigravityCliAgentRuntime(
        {
          env: agyEnv(stateDir, { second: 'slowLateRead', wake: true }, { WAKE_TRIGGER_PATH: triggerPath }),
          kind: 'antigravity-cli',
        },
        'agy',
        [],
        { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100 } },
      );
      const active = runtime;
      assert.equal((await active.run(await runtimeInput(active, firstCtx, await loadState()))).text, 'Started a subagent.');
      // The first item's work keeps the poll running through the second prompt, whose Stop
      // is settled long before its answer is read.
      assert.deepEqual(active.health().providerWork, { state: 'background' });
      assert.equal((await active.run(await runtimeInput(active, secondCtx, await loadState()))).text, 'Started another subagent.');
      await pollUntil(() => active.isProviderQuiescent() === true, 5_000);
      // The first item's work was still running, so the report goes there.
      const reports = allActivities(await loadState()).filter((activity) =>
        activity.type === 'agent.text' && activity.payload?.['text'] === 'EARLY REPORT.');
      assert.deepEqual(reports.map((activity) => activity.payload?.['itemId']), [firstCtx.item.id]);
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli tells a Stop still being written when a prompt is sent from that prompt\'s own', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-crossing-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const triggerPath = join(stateDir, 'wake-trigger');
      await installFakeAgy(stateDir);
      const firstCtx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000041.000001');
      const secondCtx = await ingestAgyEvent(stateDir, 'Delegate more.', '1786000041.000002');
      runtime = new AntigravityCliAgentRuntime(
        {
          env: agyEnv(stateDir, { crossing: true, second: true, wake: true }, { WAKE_TRIGGER_PATH: triggerPath }),
          kind: 'antigravity-cli',
          providerChildIdleTimeoutMs: 200,
        },
        'agy',
        [],
        { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100 } },
      );
      const active = runtime;
      assert.equal((await active.run(await runtimeInput(active, firstCtx, await loadState()))).text, 'Started a subagent.');
      await writeFile(triggerPath, '');
      await pollUntil(() => fileExists(`${triggerPath}.stopped`), 5_000);
      // The first item's report is out, but its Stop (work done) lands only after the second
      // prompt is sent, just before that prompt's own Stop (a new subagent is running).
      assert.equal((await active.run(await runtimeInput(active, secondCtx, await loadState()))).text, 'Started another subagent.');
      assert.equal(active.isProviderQuiescent(), false);
      assert.deepEqual(active.health().providerWork, { state: 'background' });
      await realDelay(500);
      assert.equal(active.health().child?.alive, true, 'the idle reset waits for the second subagent');
      await writeFile(`${triggerPath}.second`, '');
      await pollUntil(() => active.isProviderQuiescent() === true, 5_000);
      const activities = allActivities(await loadState());
      const itemOf = (text: string) => activities
        .filter((activity) => activity.type === 'agent.text' && activity.payload?.['text'] === text)
        .map((activity) => activity.payload?.['itemId']);
      assert.deepEqual(itemOf('SUMMARY SAVED'), [firstCtx.item.id]);
      assert.deepEqual(itemOf('REPORT-B.'), [secondCtx.item.id]);
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

for (const answer of ['never', 'late'] as const) {
  test(`antigravity-cli writes the prompt anyway when agy leaves the request before it unanswered, and ${answer === 'never' ? 'sends no more of them' : 'sends them again once the answer comes'}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-barrier-'));
    let runtime: AntigravityCliAgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const callsPath = join(stateDir, 'calls.jsonl');
        await installFakeAgy(stateDir);
        const firstCtx = await ingestAgyEvent(stateDir, 'The first question.', '1786000050.000001');
        const secondCtx = await ingestAgyEvent(stateDir, 'The second question.', '1786000050.000002');
        runtime = new AntigravityCliAgentRuntime(
          {
            env: agyEnv(stateDir, answer === 'never' ? { barrierUnanswered: 'always' } : { barrierLateMs: 600 }),
            kind: 'antigravity-cli',
          },
          'agy',
          [],
          { wake: { barrierWaitMs: 300 } },
        );
        const active = runtime;
        const startedAt = Date.now();
        assert.equal((await active.run(await runtimeInput(active, firstCtx, await loadState()))).text, 'reply 1');
        assert.ok(Date.now() - startedAt >= 300, 'the prompt waited for the answer');
        if (answer === 'late') await realDelay(600);
        assert.equal((await active.run(await runtimeInput(active, secondCtx, await loadState()))).text, 'reply 2');
        const methods = methodsOf(await readJsonLines(callsPath)).filter((method) => method === '_anima/barrier' || method === 'session/prompt');
        assert.deepEqual(methods, answer === 'never'
          ? ['_anima/barrier', 'session/prompt', 'session/prompt']
          : ['_anima/barrier', 'session/prompt', '_anima/barrier', 'session/prompt']);
      });
    } finally {
      await runtime?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

test("antigravity-cli reads agy's answer to the request before a prompt, and what agy said before it, when Anima's event loop was held past the wait", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-barrier-held-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeAgy(stateDir);
      const firstCtx = await ingestAgyEvent(stateDir, 'The first question.', '1786000051.000001');
      const secondCtx = await ingestAgyEvent(stateDir, 'The second question.', '1786000051.000002');
      runtime = new AntigravityCliAgentRuntime(
        { env: agyEnv(stateDir, { textBeforeBarrier: true }), kind: 'antigravity-cli' },
        'agy',
        [],
        { wake: { barrierWaitMs: 50, pollMs: 20, quietMs: 60_000 } },
      );
      const active = runtime;
      assert.equal((await active.run(await runtimeInput(active, firstCtx, await loadState()))).text, 'reply 1');
      const secondInput = await runtimeInput(active, secondCtx, await loadState());
      const second = await active.run({
        ...secondInput,
        effects: {
          ...secondInput.effects,
          async recordEvent(payload) {
            const recorded = await secondInput.effects.recordEvent(payload);
            // Held once the request is out, past the wait, so the wait's timer comes before agy's answer is read.
            if (payload['eventType'] === 'antigravity.turn.started') {
              setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300));
            }
            return recorded;
          },
        },
      });
      assert.equal(second.text, 'reply 2');
      assert.deepEqual(itemsWith(allActivities(await loadState()), 'agent.text', 'text', 'EARLIER.'), [firstCtx.item.id]);
      const methods = methodsOf(await readJsonLines(callsPath)).filter((method) => method === '_anima/barrier' || method === 'session/prompt');
      assert.deepEqual(methods, ['_anima/barrier', 'session/prompt', '_anima/barrier', 'session/prompt']);
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli sends no request before the next prompt while its last one is unanswered, even once agy answers one that a stopped turn sent', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-barrier-stopped-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      const triggerPath = join(stateDir, 'wake-trigger');
      await installFakeAgy(stateDir);
      const firstCtx = await ingestAgyEvent(stateDir, 'The first question.', '1786000052.000001');
      const secondCtx = await ingestAgyEvent(stateDir, 'The second question.', '1786000052.000002');
      runtime = new AntigravityCliAgentRuntime(
        { env: agyEnv(stateDir, { barrierHeldFrom: 2 }, { WAKE_TRIGGER_PATH: triggerPath }), kind: 'antigravity-cli' },
        'agy',
        [],
        { wake: { barrierWaitMs: 300 } },
      );
      const active = runtime;
      const barriers = async () => methodsOf(await readJsonLines(callsPath)).filter((method) => method === '_anima/barrier').length;
      assert.equal((await active.run(await runtimeInput(active, firstCtx, await loadState()))).text, 'reply 1');
      const stop = new AbortController();
      const stopped = active
        .run({ ...(await runtimeInput(active, secondCtx, await loadState())), signal: stop.signal })
        .then(() => false, () => true);
      await pollUntil(async () => (await barriers()) === 2, 5_000);
      stop.abort();
      assert.equal(await stopped, true);
      // This request is left unanswered too, so the prompt goes out once the wait is over.
      assert.equal((await active.run(await runtimeInput(active, firstCtx, await loadState()))).text, 'reply 2');
      assert.equal(await barriers(), 3);
      await writeFile(`${triggerPath}.release-2`, '');
      await pollUntil(() => fileExists(`${triggerPath}.answered-2`), 5_000);
      await realDelay(200);
      assert.equal((await active.run(await runtimeInput(active, secondCtx, await loadState()))).text, 'reply 3');
      assert.equal(await barriers(), 3);
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

for (const when of [
  'while it waits for output agy already sent',
  'before that wait',
  'before its turn starts',
  'while Anima records its start for longer than the stop waits',
  'while agy has not answered the request Anima reads its output up to',
]) {
  test(`antigravity-cli never sends a prompt stopped ${when}, and agy goes on with its own turn`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-stop-'));
    const unanswered = when.startsWith('while agy has not answered');
    let runtime: AntigravityCliAgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const callsPath = join(stateDir, 'calls.jsonl');
        const triggerPath = join(stateDir, 'wake-trigger');
        await installFakeAgy(stateDir);
        const firstCtx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000042.000001');
        const secondCtx = await ingestAgyEvent(stateDir, 'A new question.', '1786000042.000002');
        runtime = new AntigravityCliAgentRuntime(
          { env: agyEnv(stateDir, { barrierUnanswered: unanswered ? 'afterFirst' : undefined, tailEnds: true, wake: 'joined' }, { WAKE_TRIGGER_PATH: triggerPath }), kind: 'antigravity-cli' },
          'agy',
          [],
          { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100 } },
        );
        const active = runtime;
        const waiting = when.startsWith('while it waits');
        const beforeTurn = when === 'before its turn starts';
        const slowStart = when.startsWith('while Anima records');
        const startRelease = deferred();
        const leftover = deferred();
        const firstInput = await runtimeInput(active, firstCtx, await loadState());
        const held = deferred();
        const release = deferred();
        assert.equal((await active.run({
          ...firstInput,
          effects: {
            ...firstInput.effects,
            async recordToolStarted(payload) {
              if (waiting && payload['providerToolId'] === 'agy-tail-tool') {
                held.resolve();
                await release.promise;
              }
              return firstInput.effects.recordToolStarted(payload);
            },
          },
        })).text, 'Started a subagent.');
        await writeFile(triggerPath, '');
        await pollUntil(async () => allActivities(await loadState()).some((activity) =>
          activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-wake-read'), 5_000);
        const stop = new AbortController();
        const started = deferred();
        const secondInput = await runtimeInput(active, secondCtx, await loadState());
        try {
          if (waiting) {
            await writeFile(`${triggerPath}.tail`, '');
            await withTimeout(held.promise, 5_000);
          }
          const second = active.run({
            ...secondInput,
            effects: {
              ...secondInput.effects,
              async persistProviderSession(session) {
                // Stopped before the turn exists, so the turn never starts; agy is running item 1's turn.
                if (beforeTurn) {
                  stop.abort('operator_stop');
                  started.resolve();
                }
                return secondInput.effects.persistProviderSession(session);
              },
              async recordEvent(payload) {
                if (slowStart && payload['eventType'] === 'antigravity.turn.started') {
                  // Held in Anima's own write, past the 2s the stop waits for the turn to end.
                  started.resolve();
                  await startRelease.promise;
                }
                const recorded = await secondInput.effects.recordEvent(payload);
                if (payload['eventType'] === 'antigravity.turn.completed') leftover.resolve();
                if (!slowStart && payload['eventType'] === 'antigravity.turn.started') {
                  // Stopped before the wait: nothing is pending, so only the check before the write stops it.
                  if (!waiting && !beforeTurn && !unanswered) stop.abort('operator_stop');
                  started.resolve();
                }
                return recorded;
              },
            },
            signal: stop.signal,
          });
          // A run stopped before its turn can end before the test gets here; it is checked below.
          second.catch(() => undefined);
          await withTimeout(started.promise, 5_000);
          if (waiting || slowStart || unanswered) {
            await realDelay(100);
            stop.abort('operator_stop');
          }
          // The stop ends the run while agy's earlier output is still being handled.
          await assert.rejects(withTimeout(second, slowStart ? 4_000 : 2_000), /cancelled/);
          // agy is still running item 1's turn, so the stop leaves it running.
          assert.equal(active.health().child?.alive, true);
          if (slowStart) {
            await realDelay(500);
            startRelease.resolve();
            // What is left of the stopped turn writes its end and sends nothing.
            await withTimeout(leftover.promise, 5_000);
          }
        } finally {
          startRelease.resolve();
          release.resolve();
        }
        if (!waiting) await writeFile(`${triggerPath}.tail`, '');
        await withTimeout(active.waitForProviderQuiescent(), 5_000);
        const texts = allActivities(await loadState())
          .filter((activity) => activity.type === 'agent.text')
          .map((activity) => ({ item: activity.payload?.['itemId'], text: activity.payload?.['text'] }));
        assert.deepEqual(texts.filter((entry) => String(entry.text).includes('REPORT-A.')), [
          { item: firstCtx.item.id, text: 'Reading the report.A-TAIL.REPORT-A.' },
        ]);
        assert.equal(active.health().child?.alive, true, 'the same agy finished the turn');
        const methods = methodsOf(await readJsonLines(callsPath));
        assert.equal(methods.filter((method) => method === 'session/prompt').length, 1, 'agy only ever got the first prompt');
        assert.equal(methods.includes('session/cancel'), false, 'nothing of the stopped run was on the wire to cancel');
        // A run stopped before the wait does not ask agy for its output so far either.
        assert.equal(methods.filter((method) => method === '_anima/barrier').length, waiting || unanswered ? 2 : 1);
      });
    } finally {
      await runtime?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

test('antigravity-cli handles what agy has already said before it sends the next prompt', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-boundary-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      const triggerPath = join(stateDir, 'wake-trigger');
      await installFakeAgy(stateDir);
      const firstCtx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000038.000001');
      const secondCtx = await ingestAgyEvent(stateDir, 'A new question.', '1786000038.000002');
      runtime = new AntigravityCliAgentRuntime(
        { env: agyEnv(stateDir, { wake: 'joined' }, { WAKE_TRIGGER_PATH: triggerPath }), kind: 'antigravity-cli' },
        'agy',
        [],
        { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100 } },
      );
      const active = runtime;
      // The self-started turn reports to the first item; hold its tool call, the first line
      // of a chunk whose last line is more of that turn's text.
      const firstInput = await runtimeInput(active, firstCtx, await loadState());
      const held = deferred();
      const release = deferred();
      const first = await active.run({
        ...firstInput,
        effects: {
          ...firstInput.effects,
          async recordToolStarted(payload) {
            if (payload['providerToolId'] === 'agy-tail-tool') {
              held.resolve();
              await release.promise;
            }
            return firstInput.effects.recordToolStarted(payload);
          },
        },
      });
      assert.equal(first.text, 'Started a subagent.');
      await writeFile(triggerPath, '');
      await pollUntil(async () => allActivities(await loadState()).some((activity) =>
        activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-wake-read'), 5_000);
      let second: ReturnType<AntigravityCliAgentRuntime['run']> | undefined;
      try {
        await writeFile(`${triggerPath}.tail`, '');
        await withTimeout(held.promise, 5_000);
        second = active.run(await runtimeInput(active, secondCtx, await loadState()));
        await realDelay(300);
        assert.equal(promptTexts(await readJsonLines(callsPath)).length, 1, 'the second prompt waits for the chunk');
      } finally {
        release.resolve();
      }
      assert.ok(second);
      assert.equal((await withTimeout(second, 5_000)).text, 'Saved the summary and answered.');
      await pollUntil(() => active.isProviderQuiescent() === true, 5_000);
      const activities = allActivities(await loadState());
      const itemOf = (predicate: (activity: (typeof activities)[number]) => boolean) =>
        activities.filter(predicate).map((activity) => activity.payload?.['itemId']);
      assert.deepEqual(
        itemOf((activity) => activity.type === 'agent.text' && activity.payload?.['text'] === 'Reading the report.A-TAIL.'),
        [firstCtx.item.id],
      );
      assert.deepEqual(
        itemOf((activity) => activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-tail-tool'),
        [firstCtx.item.id],
      );
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

for (const variant of [
  // The first report's Stop is still waiting for the poll when the second item runs.
  { name: 'before the first report has settled', settled: false, timing: { pollMs: 20, quietMs: 300, settleMs: 60_000 } },
  // An agy whose Stops carry input other than the prompt: the first own Stop after the send is the prompt's.
  {
    name: 'before the first report has settled, with Stops that never match the prompt',
    otherInput: true,
    settled: false,
    timing: { pollMs: 20, quietMs: 300, settleMs: 60_000 },
  },
  { name: 'after the first report has settled', settled: true, timing: { pollMs: 20, quietMs: 60_000, settleMs: 100 } },
]) {
  test(`antigravity-cli gives a second item's report to that item when it delegates ${variant.name}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-second-'));
    let runtime: AntigravityCliAgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const triggerPath = join(stateDir, 'wake-trigger');
        await installFakeAgy(stateDir);
        const firstCtx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000035.000001');
        const secondCtx = await ingestAgyEvent(stateDir, 'Delegate more.', '1786000035.000002');
        runtime = new AntigravityCliAgentRuntime(
          {
            env: agyEnv(
              stateDir,
              { otherInput: variant.otherInput === true, second: true, wake: true },
              { WAKE_TRIGGER_PATH: triggerPath },
            ),
            kind: 'antigravity-cli',
          },
          'agy',
          [],
          { wake: variant.timing },
        );
        const active = runtime;
        assert.equal((await active.run(await runtimeInput(active, firstCtx, await loadState()))).text, 'Started a subagent.');
        await writeFile(triggerPath, '');
        await pollUntil(() => fileExists(`${triggerPath}.stopped`), 5_000);
        if (variant.settled) await pollUntil(() => active.isProviderQuiescent() === true, 5_000);

        assert.equal((await active.run(await runtimeInput(active, secondCtx, await loadState()))).text, 'Started another subagent.');
        assert.deepEqual(active.health().providerWork, { state: 'background' });
        await writeFile(`${triggerPath}.second`, '');
        await pollUntil(async () => allActivities(await loadState()).some((activity) =>
          activity.type === 'agent.text' && activity.payload?.['text'] === 'REPORT-B.'), 5_000);
        const activities = allActivities(await loadState());
        const itemOf = (text: string) => activities
          .filter((activity) => activity.type === 'agent.text' && activity.payload?.['text'] === text)
          .map((activity) => activity.payload?.['itemId']);
        assert.deepEqual(itemOf('SUMMARY SAVED'), [firstCtx.item.id]);
        assert.deepEqual(itemOf('REPORT-B.'), [secondCtx.item.id]);
      });
    } finally {
      await runtime?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

for (const [mode, when, recordFails] of [
  ['duringPrompt', 'an earlier prompt started fails during the next one', false],
  ['fromWake', 'a turn agy started on its own started fails during the next prompt', false],
  ['afterAnswer', 'a prompt started fails after its answer, while an earlier item has work left', false],
  ['duringPrompt', 'an earlier prompt started fails during the next one and that item cannot record it', true],
] as const) {
  const name = recordFails
    ? `ends a tool call whose result cannot be recorded on the item it started on, when a call ${when}`
    : `records a tool call's result on the item it started on, when a call ${when}`;
  test(`antigravity-cli ${name}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-tool-owner-'));
    let runtime: AntigravityCliAgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const triggerPath = join(stateDir, 'wake-trigger');
        await installFakeAgy(stateDir);
        const firstCtx = await ingestAgyEvent(stateDir, 'Start a reader.', '1786000050.000001');
        const secondCtx = await ingestAgyEvent(stateDir, 'Answer something else.', '1786000050.000002');
        runtime = new AntigravityCliAgentRuntime(
          {
            // The failure that cannot be recorded comes in one write with B's reply, which must still reach B.
            env: agyEnv(stateDir, { sameWrite: recordFails, toolOwner: mode }, { WAKE_TRIGGER_PATH: triggerPath }),
            kind: 'antigravity-cli',
          },
          'agy',
          [],
          { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100, subagentsDoneMs: 300 } },
        );
        const active = runtime;
        const call = mode === 'afterAnswer' ? 'agy-command-b' : 'agy-command-a';
        const owner = mode === 'afterAnswer' ? secondCtx.item.id : firstCtx.item.id;
        const firstInput = await runtimeInput(active, firstCtx, await loadState());
        let failureLost = false;
        const first = recordFails
          ? {
              ...firstInput,
              effects: {
                ...firstInput.effects,
                async recordToolFailed() {
                  failureLost = true;
                  throw new Error('activity store unavailable');
                },
              },
            }
          : firstInput;
        assert.equal((await active.run(first)).text, 'Started a reader.');
        if (mode === 'fromWake') {
          await pollUntil(() => fileExists(`${triggerPath}.a-started`), 5_000);
          await pollUntil(async () => allActivities(await loadState()).some((activity) =>
            activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === call), 5_000);
        }
        assert.equal((await active.run(await runtimeInput(active, secondCtx, await loadState()))).text, 'B reply.');
        if (recordFails) {
          // The call has still ended: once the reader stops, nothing is left open.
          await pollUntil(() => failureLost, 5_000);
          await writeFile(`${triggerPath}.reader-stop`, '');
          await withTimeout(active.waitForProviderQuiescent(), 5_000);
          const activities = allActivities(await loadState());
          assert.deepEqual(itemsWith(activities, 'tool.call.failed', 'providerToolId', call), []);
          assert.deepEqual(itemsWith(activities, 'agent.text', 'text', 'B reply.'), [secondCtx.item.id]);
          return;
        }
        await pollUntil(async () => allActivities(await loadState()).some((activity) =>
          activity.type === 'tool.call.failed' && activity.payload?.['providerToolId'] === call), 5_000);
        const activities = allActivities(await loadState());
        const itemsOf = (type: string) => activities
          .filter((activity) => activity.type === type && activity.payload?.['providerToolId'] === call)
          .map((activity) => activity.payload?.['itemId']);
        assert.deepEqual(itemsOf('tool.call.started'), [owner]);
        assert.deepEqual(itemsOf('tool.call.failed'), [owner]);
        assert.deepEqual(
          activities.filter((activity) => activity.type === 'tool.call.failed').map((activity) => activity.payload?.['error']),
          [mode === 'afterAnswer' ? 'B-SPECIFIC FAILURE.' : 'A-SPECIFIC FAILURE.'],
        );
        assert.deepEqual(itemsWith(activities, 'agent.text', 'text', 'B reply.'), [secondCtx.item.id]);
      });
    } finally {
      await runtime?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

for (const [around, name] of [
  ['notice', 'puts an item off until the quota resets when agy answers it with the quota notice and a call from an earlier item ends right after'],
  ['quoted', 'keeps a reply that quotes the quota notice when a call from an earlier item ends inside it'],
] as const) {
  test(`antigravity-cli ${name}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-cross-quota-'));
    let worker: AgentRuntimeWorker | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const triggerPath = join(stateDir, 'wake-trigger');
        await ensureTestAgentConfig({ agentId: 'anima', stateDir });
        await installFakeAgy(stateDir);
        const runtime = new AntigravityCliAgentRuntime(
          {
            env: agyEnv(stateDir, { quotaAround: around, toolOwner: 'fromWake' }, { WAKE_TRIGGER_PATH: triggerPath }),
            kind: 'antigravity-cli',
          },
          'agy',
          [],
          { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100, subagentsDoneMs: 300 } },
        );
        const queue = new WakeQueueService('anima');
        const started = new AgentRuntimeWorker(
          { agentId: 'anima', agentRuntime: runtime, homePath: stateDir, queue, stateDir },
          { error() {}, log() {} },
        );
        worker = started;
        // Item 1 leaves a reader, and a turn agy starts on its own leaves command a running.
        const firstCtx = await ingestAgyEvent(stateDir, 'Start a reader.', '1786000051.000001');
        assert.equal(await started.drainOnce(), 1);
        await pollUntil(() => fileExists(`${triggerPath}.a-started`), 5_000);
        await pollUntil(async () => allActivities(await loadState()).some((activity) =>
          activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-command-a'), 5_000);

        const secondCtx = await ingestAgyEvent(stateDir, 'Answer something else.', '1786000051.000002');
        const before = Date.now();
        const handled = await started.drainOnce();
        const activities = allActivities(await loadState());
        assert.deepEqual(itemsWith(activities, 'tool.call.failed', 'providerToolId', 'agy-command-a'), [firstCtx.item.id]);
        const replies = activities
          .filter((activity) => activity.type === 'agent.text' && activity.payload?.['itemId'] === secondCtx.item.id)
          .map((activity) => String(activity.payload?.['text']));
        const queued = await queue.find(secondCtx.item.id);
        if (around === 'notice') {
          assert.equal(handled, 0);
          assert.deepEqual(replies, []);
          assert.equal(queued?.handling.status, 'queued');
          const resumeAt = Date.parse(String(queued?.handling.notBefore));
          assert.ok(Math.abs(resumeAt - (before + 90 * 60_000)) < 60_000, String(queued?.handling.notBefore));
        } else {
          assert.equal(handled, 1);
          assert.equal(queued, undefined);
          assert.equal(replies.length, 1);
          assert.match(replies[0]!, /^Here is the notice you asked me to quote:\s+⚠ Individual quota reached\. .* Resets in 1h30m\.\s*$/);
        }
        await writeFile(`${triggerPath}.reader-stop`, '');
        await withTimeout(runtime.waitForProviderQuiescent(), 5_000);
      });
    } finally {
      await worker?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

test('antigravity-cli closes a call whose first notice says it ended, when its item cannot record the start', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-terminal-only-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const triggerPath = join(stateDir, 'wake-trigger');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Start a reader.', '1786000052.000001');
      runtime = new AntigravityCliAgentRuntime(
        { env: agyEnv(stateDir, { terminalOnly: true }, { WAKE_TRIGGER_PATH: triggerPath }), kind: 'antigravity-cli' },
        'agy',
        [],
        { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100, subagentsDoneMs: 300 } },
      );
      const active = runtime;
      const input = await runtimeInput(active, ctx, await loadState());
      let startsLost = 0;
      const first: AgentRuntimeInput = {
        ...input,
        effects: {
          ...input.effects,
          async recordToolStarted(event) {
            if (event.providerToolId !== 'agy-read-late') return input.effects.recordToolStarted(event);
            startsLost += 1;
            throw new Error('activity store unavailable');
          },
        },
      };
      assert.equal((await active.run(first)).text, 'Started a reader.');
      await writeFile(`${triggerPath}.go`, '');
      await pollUntil(async () =>
        itemsWith(allActivities(await loadState()), 'agent.text', 'text', 'All work finished.').length > 0, 5_000);
      // The reader stopped after the session's last Stop, and the read has ended: nothing is left.
      await withTimeout(active.waitForProviderQuiescent(), 5_000);
      assert.equal(startsLost, 1);
      assert.equal(active.isProviderQuiescent(), true);
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

for (const lastWrite of ['succeeds', 'fails']) {
  test(`antigravity-cli ends a stopped run held up before it sends its prompt, leaving agy and the next run alone when its last write ${lastWrite}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-stop-stuck-'));
    let runtime: AntigravityCliAgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const callsPath = join(stateDir, 'calls.jsonl');
        await installFakeAgy(stateDir);
        const firstCtx = await ingestAgyEvent(stateDir, 'Hello.', '1786000044.000001');
        const secondCtx = await ingestAgyEvent(stateDir, 'Hello again.', '1786000044.000002');
        const thirdCtx = await ingestAgyEvent(stateDir, 'One more.', '1786000044.000003');
        const followupCtx = await ingestAgyEvent(stateDir, 'And another.', '1786000044.000004');
        runtime = new AntigravityCliAgentRuntime({ env: agyEnv(stateDir, {}), kind: 'antigravity-cli' }, 'agy');
        const active = runtime;
        assert.equal((await active.run(await runtimeInput(active, firstCtx, await loadState()))).text, 'reply 1');
        const stop = new AbortController();
        const stuck = deferred();
        const release = deferred();
        const leftover = deferred();
        const secondInput = await runtimeInput(active, secondCtx, await loadState());
        const second = active.run({
          ...secondInput,
          effects: {
            ...secondInput.effects,
            async recordEvent(payload) {
              if (payload['eventType'] === 'antigravity.turn.started') {
                stuck.resolve();
                await release.promise;
              }
              if (payload['eventType'] === 'antigravity.turn.completed') {
                leftover.resolve();
                // The run is over by now; its item may be gone too.
                if (lastWrite === 'fails') throw new Error('item gone');
              }
              return secondInput.effects.recordEvent(payload);
            },
          },
          signal: stop.signal,
        });
        const thirdStarted = deferred();
        const thirdRelease = deferred();
        let third: ReturnType<AntigravityCliAgentRuntime['run']> | undefined;
        try {
          await withTimeout(stuck.promise, 5_000);
          stop.abort('operator_stop');
          // Nothing of the run is with agy, so after 2s the run ends without stopping agy.
          await assert.rejects(withTimeout(second, 5_000), /cancelled/);
          assert.equal(active.health().child?.alive, true);
          const thirdInput = await runtimeInput(active, thirdCtx, await loadState());
          third = active.run({
            ...thirdInput,
            effects: {
              ...thirdInput.effects,
              async recordEvent(payload) {
                if (payload['eventType'] === 'antigravity.turn.started') {
                  thirdStarted.resolve();
                  await thirdRelease.promise;
                }
                return thirdInput.effects.recordEvent(payload);
              },
            },
          });
          await withTimeout(thirdStarted.promise, 5_000);
          // The stopped run's write returns while the next run holds the turn.
          release.resolve();
          await withTimeout(leftover.promise, 5_000);
          await realDelay(50);
          // That run still holds it: a follow-up joins it.
          assert.equal((await active.appendToActiveRun(
            await runtimeFollowupInput(active, thirdCtx, followupCtx, await loadState()),
          )).accepted, true);
        } finally {
          release.resolve();
          thirdRelease.resolve();
        }
        assert.ok(third);
        assert.equal((await withTimeout(third, 5_000)).text, 'reply 2reply 3');
        assert.equal(active.health().child?.alive, true);
        const prompts = promptTexts(await readJsonLines(callsPath));
        assert.equal(prompts.length, 3, 'the stopped run never sent its prompt');
        assert.ok(prompts[1]?.includes('One more.'));
        assert.ok(prompts[2]?.includes('And another.'));
        assert.equal(methodsOf(await readJsonLines(callsPath)).includes('session/cancel'), false);
      });
    } finally {
      await runtime?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

test('antigravity-cli stops agy when a run is stopped while agy starts its session', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-stop-session-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const callsPath = join(stateDir, 'calls.jsonl');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Hello.', '1786000045.000001');
      runtime = new AntigravityCliAgentRuntime({ env: agyEnv(stateDir, { newHangs: true }), kind: 'antigravity-cli' }, 'agy');
      const active = runtime;
      const stop = new AbortController();
      const run = active.run({ ...(await runtimeInput(active, ctx, await loadState())), signal: stop.signal });
      await waitFor(() => readFile(callsPath, 'utf8').then((text) => text.includes('"method":"session/new"')));
      stop.abort('operator_stop');
      // agy never answers session/new; only stopping it ends the run.
      const ended = await withTimeout(run.then(() => 'resolved', () => 'rejected'), 5_000);
      assert.equal(ended, 'rejected');
      assert.notEqual(active.health().child?.alive, true);
      assert.equal(methodsOf(await readJsonLines(callsPath)).includes('session/prompt'), false);
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

for (const variant of [
  { done: true, name: 'once its last subagent has stopped after the session went quiet' },
  { done: false, invokeTwice: true, name: 'not while another subagent it invoked is still running' },
  { done: false, name: 'not while a command it sent to the background is running', openTool: true },
  { done: false, name: 'not while its subagent still has work of its own', subagentBusy: true },
  { done: false, lateSubagentStop: false, name: 'not when the session says work goes on after its subagent stopped', wakeLeavesWork: true },
  { done: true, invokeTitle: 'Run start_helper', name: 'once its last subagent has stopped, whatever the call that started it is called' },
  { done: false, lateStart: true, name: 'not when another subagent starts after the last one stopped' },
  { done: false, name: 'not while the session calls the model after its last subagent stopped', sessionCall: true },
  {
    done: false,
    name: 'not while a loop of the session that called the model before its last subagent stopped is running',
    subagentStops: [['session', 'call'], ['agy-subagent-1', true]],
  },
  { batch: true, done: false, name: 'not while the second subagent one call started is still running' },
  {
    batch: true,
    done: true,
    name: 'once both subagents one call started have stopped',
    subagentStops: [['agy-subagent-1', true], ['agy-subagent-2', true]],
  },
  {
    done: false,
    invokeTwice: true,
    name: 'not when a message wakes a subagent that stopped, until it stops again',
    subagentStops: [['agy-subagent-1', true], ['agy-subagent-1', 'call'], ['agy-subagent-2', true]],
  },
  {
    done: true,
    invokeTwice: true,
    name: 'once a subagent a message woke has stopped again',
    subagentStops: [['agy-subagent-1', true], ['agy-subagent-1', 'call'], ['agy-subagent-2', true], ['agy-subagent-1', true]],
  },
  { done: false, name: 'not when its subagent goes back to work after it stopped', subagentStops: [['agy-subagent-1', true], ['agy-subagent-1', false]] },
  // A loop of the session whose model call never reached the file still ends with its own Stop.
  {
    done: false,
    name: 'not when the session says work goes on after its last subagent stopped, with no model call of that loop seen',
    subagentStops: [['agy-subagent-1', true], ['session', false]],
  },
  // Hook events do not say which conversation started which: a subagent running beside one whose Stop
  // says work goes on may be the session's, and tells nothing about that work.
  {
    done: false,
    invokeTwice: true,
    name: 'not once the other subagent stops, when the first said work of its own goes on while that one was running',
    subagentStops: [['agy-subagent-1', true], ['agy-subagent-1', false], ['agy-subagent-2', true]],
  },
  {
    done: true,
    invokeTwice: true,
    name: 'once a subagent that said work of its own goes on while another was running has run again and stopped',
    subagentStops: [['agy-subagent-1', true], ['agy-subagent-1', false], ['agy-subagent-2', true], ['agy-subagent-1', 'call'], ['agy-subagent-1', true]],
  },
  {
    done: false,
    name: 'not while the subagent its subagent started is running',
    subagentStops: [['agy-subagent-leaf', 'call'], ['agy-subagent-1', false]],
  },
  {
    done: true,
    name: 'once the subagent its subagent started has stopped, after the first said work of its own goes on',
    subagentStops: [['agy-subagent-leaf', 'call'], ['agy-subagent-1', false], ['agy-subagent-leaf', true]],
  },
  // A subagent first seen while the session's loop runs, or while several subagents run, could be anyone's.
  {
    done: false,
    name: 'not once the subagent its subagent started has stopped, when it started while a loop of the session ran',
    subagentStops: [['session', 'call'], ['agy-subagent-leaf', 'call'], ['session', false], ['agy-subagent-1', false], ['agy-subagent-leaf', true]],
  },
  {
    done: true,
    name: 'once its subagent runs again and stops, when the subagent that one started started while a loop of the session ran',
    subagentStops: [
      ['session', 'call'],
      ['agy-subagent-leaf', 'call'],
      ['session', false],
      ['agy-subagent-1', false],
      ['agy-subagent-leaf', true],
      ['agy-subagent-1', 'call'],
      ['agy-subagent-1', true],
    ],
  },
  {
    done: false,
    invokeTwice: true,
    name: 'not once the subagent its subagent started has stopped, when it started while another subagent ran',
    subagentStops: [['agy-subagent-leaf', 'call'], ['agy-subagent-1', false], ['agy-subagent-2', true], ['agy-subagent-leaf', true]],
  },
  {
    done: true,
    name: 'once the last of a chain of subagents its subagent started has stopped',
    subagentStops: [
      ['agy-subagent-leaf', 'call'],
      ['agy-subagent-1', false],
      ['agy-subagent-leaf2', 'call'],
      ['agy-subagent-leaf', false],
      ['agy-subagent-1', 'call'],
      ['agy-subagent-1', false],
      ['agy-subagent-leaf2', true],
    ],
  },
  {
    done: true,
    name: 'once the subagent its subagent started, which said work of its own goes on, runs again and stops',
    subagentStops: [
      ['agy-subagent-leaf', 'call'],
      ['agy-subagent-leaf', false],
      ['agy-subagent-1', false],
      ['agy-subagent-leaf', 'call'],
      ['agy-subagent-leaf', true],
    ],
  },
  // A subagent seen stopping before is not new when it calls the model again.
  {
    done: false,
    invokeTwice: true,
    name: 'not counting a subagent seen stopping before as one its running subagent started',
    subagentStops: [['agy-subagent-2', true], ['agy-subagent-3', true], ['agy-subagent-3', 'call'], ['agy-subagent-1', false], ['agy-subagent-3', true]],
  },
  {
    done: false,
    invokeTwice: true,
    name: 'not counting the subagent another subagent started for one that said work of its own goes on',
    subagentStops: [
      ['agy-subagent-2', true],
      ['agy-subagent-1', 'call'],
      ['agy-subagent-leaf', 'call'],
      ['agy-subagent-3', 'call'],
      ['agy-subagent-3', false],
      ['agy-subagent-leaf', true],
      ['agy-subagent-1', true],
    ],
  },
  // Whatever its call shows, a subagent seen before is not new; agy shows no steps only for a new one.
  {
    done: false,
    name: 'not counting a subagent seen before as one its running subagent started, whatever steps its call shows',
    subagentStops: [['agy-subagent-3', true], ['agy-subagent-3', 'fresh'], ['agy-subagent-1', false], ['agy-subagent-3', true]],
  },
  // A subagent is seen from its first model call: a later call that shows no steps either, before it
  // ever stopped, is not that of a new subagent, here one the subagent itself would have started.
  {
    done: false,
    invokeTwice: true,
    name: 'not when a subagent whose later call shows no steps either, as its first did, says work of its own goes on',
    subagentStops: [
      ['agy-subagent-3', 'call'],
      ['agy-subagent-1', true],
      ['agy-subagent-2', true],
      ['agy-subagent-3', 'fresh'],
      ['agy-subagent-3', false],
      ['agy-subagent-3', 'call'],
      ['agy-subagent-3', false],
    ],
  },
  // A subagent with earlier steps, as one from before a reload, is not taken for one a running subagent started.
  {
    done: false,
    name: 'not counting a subagent from before as one its running subagent started',
    subagentStops: [['agy-subagent-old', 'resumed'], ['agy-subagent-1', false], ['agy-subagent-old', true]],
  },
  // A subagent's later model calls do not make it a subagent of its own.
  {
    done: false,
    name: 'not when its subagent, after saying work of its own goes on with none running, runs again and says so again',
    subagentStops: [['agy-subagent-1', 'call'], ['agy-subagent-1', false], ['agy-subagent-1', 'call'], ['agy-subagent-1', false]],
  },
  {
    done: false,
    name: 'not when its subagent says work of its own goes on after the subagent it started has stopped',
    subagentStops: [['agy-subagent-leaf', 'call'], ['agy-subagent-leaf', true], ['agy-subagent-1', false]],
  },
  {
    done: true,
    name: 'once its subagent, after saying work of its own goes on with none running, runs again and stops',
    subagentStops: [['agy-subagent-leaf', 'call'], ['agy-subagent-leaf', true], ['agy-subagent-1', false], ['agy-subagent-1', 'call'], ['agy-subagent-1', true]],
  },
  { done: true, earlierWork: true, name: 'once its last subagent has stopped, counting only calls after earlier work ended' },
  { done: false, earlierWork: true, invokeTwice: true, name: 'not counting a subagent of earlier work as one of its own' },
  // A subagent whose Stop never reached the file is not waited for once the session said it was idle.
  {
    done: true,
    earlierStopLost: true,
    earlierWork: true,
    name: 'once its last subagent has stopped, when a subagent of earlier work lost its Stop',
  },
  // Anima handles the earlier work only once that work's Stop is on disk.
  {
    done: true,
    earlierWork: true,
    holdEarlierWork: true,
    name: 'once its last subagent has stopped, counting only calls after earlier work ended that Anima handled late',
  },
  {
    done: false,
    earlierWork: true,
    holdEarlierWork: true,
    invokeTwice: true,
    name: 'not counting a subagent of earlier work as one of its own when Anima handled that work late',
  },
  { done: true, invokeFails: true, name: 'once its last subagent has stopped, not waiting on a call that failed to start one' },
  { done: false, invokeFails: true, invokeTwice: true, name: 'not while another subagent it invoked is still running, beside a call that failed' },
  // The failure comes outside any loop, so its turn ends only after the quiet period.
  { done: true, invokeFails: 'afterStop', name: 'once a call left open fails after the last subagent has stopped', quietMs: 150 },
]) {
  test(`antigravity-cli ends background work ${variant.name}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-late-'));
    let runtime: AntigravityCliAgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const triggerPath = join(stateDir, 'wake-trigger');
        await installFakeAgy(stateDir);
        const ctx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000043.000001');
        runtime = new AntigravityCliAgentRuntime(
          {
            env: agyEnv(
              stateDir,
              {
                batch: variant.batch === true,
                earlierStopLost: variant.earlierStopLost === true,
                earlierWork: variant.earlierWork === true,
                invokeFails: variant.invokeFails,
                invokeTitle: variant.invokeTitle,
                invokeTwice: variant.invokeTwice === true,
                lateStart: variant.lateStart === true,
                lateSubagentStop: variant.lateSubagentStop ?? true,
                openTool: variant.openTool === true,
                sessionCall: variant.sessionCall === true,
                subagentBusy: variant.subagentBusy === true,
                subagentStops: variant.subagentStops,
                wake: true,
                wakeLeavesWork: variant.wakeLeavesWork === true,
              },
              { WAKE_TRIGGER_PATH: triggerPath },
            ),
            kind: 'antigravity-cli',
            providerChildIdleTimeoutMs: 200,
          },
          'agy',
          [],
          { wake: { pollMs: 20, quietMs: variant.quietMs ?? 60_000, settleMs: 100, subagentsDoneMs: 800 } },
        );
        const active = runtime;
        const input = await runtimeInput(active, ctx, await loadState());
        let held = false;
        assert.equal((await active.run({
          ...input,
          effects: {
            ...input.effects,
            async recordToolStarted(payload) {
              if (variant.holdEarlierWork && payload['providerToolId'] === 'agy-helper-0') {
                await pollUntil(() => fileExists(`${triggerPath}.earlier`), 5_000);
                await realDelay(20);
                held = true;
              }
              return input.effects.recordToolStarted(payload);
            },
          },
        })).text, 'Started a subagent.');
        assert.equal(held, variant.holdEarlierWork === true);
        await writeFile(triggerPath, '');
        await pollUntil(() => fileExists(`${triggerPath}.stopped`), 5_000);
        await pollUntil(async () => allActivities(await loadState()).some((activity) =>
          activity.type === 'agent.text' && activity.payload?.['text'] === 'SUMMARY SAVED'), 5_000);
        // The turn's Stop still counts the subagent as running; the subagent's own Stop lands just after.
        await realDelay(400);
        if (variant.invokeFails === 'afterStop') {
          // The failure, after that Stop was applied, comes in a turn of its own that ends after the quiet period.
          await pollUntil(async () => allActivities(await loadState()).some((activity) =>
            activity.type === 'tool.call.failed' && activity.payload?.['providerToolId'] === 'agy-invoke-x'), 5_000);
          await pollUntil(() => active.health().providerWork?.state === 'background', 5_000);
        }
        assert.deepEqual(active.health().providerWork, { state: 'background' });
        assert.equal(active.health().child?.alive, true);
        if (variant.done) {
          await withTimeout(active.waitForProviderQuiescent(), 5_000);
          assert.equal(active.health().providerWork, undefined);
          await pollUntil(() => active.health().child === undefined, 5_000);
        } else {
          // The silence window has passed since agy's last hook, however late that hook ran.
          await pollUntil(() => fileExists(`${triggerPath}.hooks-done`), 5_000);
          await realDelay(1_200);
          assert.equal(active.isProviderQuiescent(), false);
          assert.deepEqual(active.health().providerWork, { state: 'background' });
          assert.equal(active.health().child?.alive, true);
        }
      });
    } finally {
      await runtime?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

for (const variant of [
  { late: false, name: 'read on time' },
  { late: true, name: 'read only after that prompt\'s Stop said the session was idle' },
  { late: true, name: 'read only after the session\'s own turn said it was idle', report: true },
  // The second prompt is the first one's text again (so the self-started turn's Stop carries
  // its digest), and that Stop is applied only when the second answer is read.
  { late: false, name: 'with the same text, ended by a turn of agy\'s own', report: true, sameText: true },
]) {
  test(`antigravity-cli ends the next prompt's background work once its subagent stops, not counting a call of an earlier prompt ${variant.name}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-rounds-'));
    let runtime: AntigravityCliAgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const triggerPath = join(stateDir, 'wake-trigger');
        const late = variant.late;
        await installFakeAgy(stateDir);
        const firstCtx = await ingestAgyEvent(stateDir, 'Have the reader check.', '1786000047.000001');
        const secondCtx = await ingestAgyEvent(stateDir, 'Have the writer start.', '1786000047.000002');
        runtime = new AntigravityCliAgentRuntime(
          {
            env: agyEnv(stateDir, { doneFirst: variant.report ? 'report' : true, readLate: late }, { WAKE_TRIGGER_PATH: triggerPath }),
            kind: 'antigravity-cli',
            providerChildIdleTimeoutMs: 200,
          },
          'agy',
          [],
          { wake: { pollMs: 20, quietMs: 60_000, settleMs: variant.sameText ? 1_000 : 100, subagentsDoneMs: 800 } },
        );
        const active = runtime;
        const firstInput = await runtimeInput(active, firstCtx, await loadState());
        let idleWhenHandled: boolean | undefined;
        const first = active.run({
          ...firstInput,
          effects: {
            ...firstInput.effects,
            async recordToolStarted(payload) {
              if (payload['providerToolId'] === 'agy-invoke-a') idleWhenHandled = await fileExists(`${triggerPath}.a-idle`);
              return firstInput.effects.recordToolStarted(payload);
            },
          },
        });
        if (late) {
          await pollUntil(() => fileExists(`${triggerPath}.about`), 5_000);
          // Anima reads nothing more until the prompt's Stop, saying the session is idle, is on disk.
          writeFileSync(`${triggerPath}.reading`, '');
          const end = Date.now() + 5_000;
          while (!existsSync(`${triggerPath}.a-idle`) && Date.now() < end) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
          }
        }
        assert.equal((await first).text, 'The reader is done.');
        if (late) assert.equal(idleWhenHandled, true);
        if (variant.report) {
          await pollUntil(() => fileExists(`${triggerPath}.a-idle`), 5_000);
          if (late) await pollUntil(() => active.health().providerWork === undefined, 5_000);
        }
        if (!variant.sameText) assert.equal(active.health().providerWork, undefined);
        const secondInput = await runtimeInput(active, secondCtx, await loadState());
        const second = variant.sameText ? { ...secondInput, prompt: firstInput.prompt, systemPrompt: firstInput.systemPrompt } : secondInput;
        assert.equal((await active.run(second)).text, 'Started another subagent.');
        if (variant.sameText) assert.equal(await readFile(`${triggerPath}.prompt2`, 'utf8'), await readFile(`${triggerPath}.prompt1`, 'utf8'));
        assert.deepEqual(active.health().providerWork, { state: 'background' });
        await withTimeout(active.waitForProviderQuiescent(), 5_000);
        assert.equal(active.health().providerWork, undefined);
        await pollUntil(() => active.health().child === undefined, 5_000);
      });
    } finally {
      await runtime?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

/**
 * The run's prompt is written only after agy has reported for the first item and said it is
 * idle (WAKE_TRIGGER_PATH.a-report, then .a-idle; see reportBeforeNext), and Anima reads
 * nothing of that until then: its event loop is held as the turn starts.
 */
function readingReportLate(input: AgentRuntimeInput, triggerPath: string): AgentRuntimeInput {
  return {
    ...input,
    effects: {
      ...input.effects,
      async recordEvent(payload) {
        await input.effects.recordEvent(payload);
        if (payload['eventType'] !== 'antigravity.turn.started') return;
        writeFileSync(`${triggerPath}.a-report`, '');
        const end = Date.now() + 5_000;
        while (!existsSync(`${triggerPath}.a-idle`) && Date.now() < end) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
      },
    },
  };
}

/** An agent the runtime host runs on Antigravity, with Slack connected. */
function antigravityHostAgent(homePath: string): AgentConfig {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    enabled: true,
    feishu: { appId: '', appSecret: '', connected: false, encryptKey: '', verificationToken: '' },
    homePath,
    id: 'anima',
    profile: { displayName: 'anima', role: 'general purpose' },
    provider: { env: {}, kind: 'antigravity-cli' },
    slack: {
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      connected: true,
      manifestVersion: 0,
      teamId: 'T-test',
      workspaceIconUrl: '',
      workspaceName: 'Test',
    },
    teamId: 'default',
  };
}

function itemsWith(activities: ReturnType<typeof allActivities>, type: string, field: string, value: string): unknown[] {
  return activities
    .filter((activity) => activity.type === type && String(activity.payload?.[field]).includes(value))
    .map((activity) => activity.payload?.['itemId']);
}

for (const late of [false, true]) {
  test(`antigravity-cli keeps a report agy wrote before the next prompt on the item it reports for, and ends the next item's work once its subagent stops, ${late ? 'with the report read only after its Stop said the session was idle' : 'with the report read on time'}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-report-before-next-'));
    let runtime: AntigravityCliAgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const triggerPath = join(stateDir, 'wake-trigger');
        await installFakeAgy(stateDir);
        const firstCtx = await ingestAgyEvent(stateDir, 'Have the reader check.', '1786000048.000001');
        const secondCtx = await ingestAgyEvent(stateDir, 'Have the writer start.', '1786000048.000002');
        runtime = new AntigravityCliAgentRuntime(
          {
            env: agyEnv(stateDir, { reportBeforeNext: true }, { WAKE_TRIGGER_PATH: triggerPath }),
            kind: 'antigravity-cli',
            providerChildIdleTimeoutMs: 200,
          },
          'agy',
          [],
          { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100, subagentsDoneMs: 800 } },
        );
        const active = runtime;
        assert.equal((await active.run(await runtimeInput(active, firstCtx, await loadState()))).text, 'Started a reader.');
        assert.deepEqual(active.health().providerWork, { state: 'background' });
        if (!late) {
          await writeFile(`${triggerPath}.a-report`, '');
          await pollUntil(() => active.health().providerWork === undefined, 5_000);
        }
        const secondInput = await runtimeInput(active, secondCtx, await loadState());
        const second = await active.run(late ? readingReportLate(secondInput, triggerPath) : secondInput);
        assert.equal(second.text, 'Started a writer.');
        assert.deepEqual(active.health().providerWork, { state: 'background' });
        await withTimeout(active.waitForProviderQuiescent(), 5_000);
        const activities = allActivities(await loadState());
        assert.deepEqual(itemsWith(activities, 'agent.text', 'text', 'REPORT FOR A ONLY.'), [firstCtx.item.id]);
        assert.deepEqual(itemsWith(activities, 'tool.call.started', 'providerToolId', 'agy-invoke-check'), [firstCtx.item.id]);
        assert.deepEqual(itemsWith(activities, 'tool.call.started', 'providerToolId', 'agy-invoke-b'), [secondCtx.item.id]);
        await pollUntil(() => active.health().child === undefined, 5_000);
      });
    } finally {
      await runtime?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

for (const repeat of [true, false]) {
  test(`antigravity-cli keeps the next prompt's subagent running when an earlier turn's Stop, started before that prompt, is written after it${repeat ? ', with the same text' : ''}`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-stop-crosses-'));
    let runtime: AntigravityCliAgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const triggerPath = join(stateDir, 'wake-trigger');
        await installFakeAgy(stateDir);
        const firstCtx = await ingestAgyEvent(stateDir, 'Have the reader check.', '1786000049.000001');
        const secondCtx = await ingestAgyEvent(stateDir, 'Have the writer start.', '1786000049.000002');
        runtime = new AntigravityCliAgentRuntime(
          {
            env: agyEnv(stateDir, { stopCrossesNext: true }, { WAKE_TRIGGER_PATH: triggerPath }),
            kind: 'antigravity-cli',
            providerChildIdleTimeoutMs: 200,
          },
          'agy',
          [],
          // settleMs outlasts the idle reset, so a prompt taken for quiescent lets the child go.
          { wake: { pollMs: 20, quietMs: 60_000, settleMs: 1_000, subagentsDoneMs: 800 } },
        );
        const active = runtime;
        const firstInput = await runtimeInput(active, firstCtx, await loadState());
        assert.equal((await active.run(firstInput)).text, 'Started a reader.');
        assert.deepEqual(active.health().providerWork, { state: 'background' });
        await writeFile(`${triggerPath}.a-report`, '');
        await pollUntil(() => fileExists(`${triggerPath}.a-stopping`), 5_000);
        const secondInput = await runtimeInput(active, secondCtx, await loadState());
        const second = repeat ? { ...secondInput, prompt: firstInput.prompt, systemPrompt: firstInput.systemPrompt } : secondInput;
        assert.equal((await active.run(second)).text, 'Started a writer.');
        assert.equal(
          (await readFile(`${triggerPath}.prompt2`, 'utf8')) === (await readFile(`${triggerPath}.prompt1`, 'utf8')),
          repeat,
        );
        assert.deepEqual(active.health().providerWork, { state: 'background' });
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.notEqual(active.health().child, undefined);
        await writeFile(`${triggerPath}.b-report`, '');
        await withTimeout(active.waitForProviderQuiescent(), 5_000);
        const activities = allActivities(await loadState());
        assert.deepEqual(itemsWith(activities, 'agent.text', 'text', 'REPORT-A.'), [firstCtx.item.id]);
        assert.deepEqual(itemsWith(activities, 'agent.text', 'text', 'REPORT-B.'), [secondCtx.item.id]);
        await pollUntil(() => active.health().child === undefined, 5_000);
      });
    } finally {
      await runtime?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

/** What a host test's `deliver` works with: the first worker, and what its runs returned. */
interface AntigravityHostItems {
  /** Ingests an item and has the first worker run it. */
  deliver(text: string, ts: string): Promise<Awaited<ReturnType<typeof ingestAgyEvent>>>;
  /** Has the first worker run what is queued; resolves to how many items it took. */
  drain(): Promise<number>;
  /** How many workers the host has started. */
  generation(): number;
  /** Ingests an item without running it. */
  ingest(text: string, ts: string): ReturnType<typeof ingestAgyEvent>;
  runtime(): AntigravityCliAgentRuntime;
  /** The text each run of the first worker returned, in order. */
  texts: string[];
  triggerPath: string;
}

/**
 * Runs the agent under the runtime host on the fake agy with `scenario`. `deliver` has the
 * first worker run items until agy's work is in the background; then a `reload` is asked for
 * and one more item comes. Returns once a second worker has started and handled that item,
 * which it can only do once the first worker counted agy's background work done.
 */
async function reloadsOnceWorkIsDone(
  reload: 'whenIdle' | 'provider-env',
  options: {
    /** Runs once the second worker has handled the next item. */
    afterReload?(items: AntigravityHostItems): Promise<void>;
    deliver(items: AntigravityHostItems): Promise<void>;
    /** Changes what the first worker's runs get; `index` counts from 1. */
    input?(input: AgentRuntimeInput, index: number, inputs: AgentRuntimeInput[], triggerPath: string): AgentRuntimeInput;
    scenario: Record<string, unknown>;
    wake: AntigravityWakeTiming;
    /** Runs once the reload is asked for and the next item is queued. */
    whileReloadWaits?(items: AntigravityHostItems): Promise<void>;
  },
): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-host-reload-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const triggerPath = join(stateDir, 'wake-trigger');
      await ensureTestAgentConfig({ agentId: 'anima', stateDir });
      await installFakeAgy(stateDir);
      const queue = new WakeQueueService('anima');
      const restartCommands = new AgentRestartCommandStore({ animaHome: stateDir });
      const logger = { error() {}, log() {} };
      let config = antigravityHostAgent(stateDir);
      let generation = 0;
      let worker: AgentRuntimeWorker | undefined;
      let runtime: AntigravityCliAgentRuntime | undefined;
      const texts: string[] = [];
      const host = new RuntimeHost({}, {
        animaHome: stateDir,
        loadAgents: async () => [config],
        logger,
        // A memory-coherence pass would be one more prompt to the scripted agy.
        memoryCoherenceScheduler: { async reconcile() {} },
        restartCommands,
        startAgent: async (): Promise<RunningAgentHandle> => {
          generation += 1;
          const active = new AntigravityCliAgentRuntime(
            {
              env: agyEnv(stateDir, generation === 1 ? options.scenario : {}, { WAKE_TRIGGER_PATH: triggerPath }),
              kind: 'antigravity-cli',
            },
            'agy',
            [],
            { wake: options.wake },
          );
          if (generation === 1) {
            const inputs: AgentRuntimeInput[] = [];
            const run = active.run.bind(active);
            active.run = async (input) => {
              inputs.push(input);
              const result = await run(options.input?.(input, inputs.length, inputs, triggerPath) ?? input);
              texts.push(result.text ?? '');
              return result;
            };
          }
          runtime = active;
          const started = new AgentRuntimeWorker(
            { agentId: 'anima', agentRuntime: active, homePath: stateDir, queue, stateDir },
            logger,
          );
          worker = started;
          return {
            hasPendingItems: () => started.hasPendingItems(),
            health: () => started.health(),
            isActive: () => started.isActive(),
            isProviderQuiescent: () => started.isProviderQuiescent(),
            setIntakePaused: (paused) => started.setIntakePaused(paused),
            stop: (options) => started.close(options),
            waitForProviderQuiescent: (signal) => started.waitForProviderQuiescent(signal),
          };
        },
        syncSlackDisplayInfo: async (agent) => agent,
        validateAgent: async () => {},
      });
      try {
        await host.reconcileOnce();
        const items: AntigravityHostItems = {
          async deliver(text, ts) {
            const ctx = await ingestAgyEvent(stateDir, text, ts);
            assert.equal(await worker!.drainOnce(), 1);
            return ctx;
          },
          drain: () => worker!.drainOnce(),
          generation: () => generation,
          ingest: (text, ts) => ingestAgyEvent(stateDir, text, ts),
          runtime: () => runtime!,
          texts,
          triggerPath,
        };
        await options.deliver(items);
        assert.equal(runtime!.isProviderQuiescent(), false);

        if (reload === 'whenIdle') await restartCommands.request('anima', { whenIdle: true });
        else config = { ...config, provider: { ...config.provider, env: { EXAMPLE_REVISION: 'next' } } };
        await host.reconcileOnce();
        const next = await ingestAgyEvent(stateDir, 'Anything new?', '1786000049.000009');
        await options.whileReloadWaits?.(items);
        await pollUntil(() => generation === 2, 5_000);
        await host.reconcileOnce();
        assert.equal(await worker!.drainOnce(), 1);
        assert.equal(await queue.find(next.item.id), undefined);
        assert.equal(itemsWith(allActivities(await loadState()), 'agent.text', 'itemId', next.item.id).length > 0, true);
        await options.afterReload?.(items);
      } finally {
        await host.stop();
      }
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
}

/**
 * Both kinds of reload wait on the runtime the same way (isProviderQuiescent, then
 * waitForProviderQuiescent), so past the first host scenario each runs with one kind.
 */
function reloadTest(
  reload: 'whenIdle' | 'provider-env',
  kind: 'whenIdle' | 'provider-env' | 'both',
  name: string,
  run: () => Promise<void>,
): void {
  if (kind === 'both' || kind === reload) test(name, run);
}

for (const reload of ['whenIdle', 'provider-env'] as const) {
  reloadTest(reload, 'both', `antigravity-cli lets a ${reload} reload go ahead once the next item's subagent stops, when agy's report before that item is read only after its Stop`, async () => {
    await reloadsOnceWorkIsDone(reload, {
      async deliver({ deliver, texts }) {
        const first = await deliver('Have the reader check.', '1786000049.000001');
        const second = await deliver('Have the writer start.', '1786000049.000002');
        assert.equal(texts[1], 'Started a writer.');
        const activities = allActivities(await loadState());
        assert.deepEqual(itemsWith(activities, 'agent.text', 'text', 'REPORT FOR A ONLY.'), [first.item.id]);
        assert.deepEqual(itemsWith(activities, 'agent.text', 'text', 'Started a writer.'), [second.item.id]);
      },
      input: (input, index, _inputs, triggerPath) => (index === 2 ? readingReportLate(input, triggerPath) : input),
      scenario: { reportBeforeNext: true },
      wake: { pollMs: 20, quietMs: 60_000, settleMs: 100, subagentsDoneMs: 800 },
    });
  });

  reloadTest(reload, 'provider-env', `antigravity-cli lets a ${reload} reload go ahead once the next item's subagent stops, when agy reads that item's prompt only after a turn of its own that started a subagent and ended idle`, async () => {
    await reloadsOnceWorkIsDone(reload, {
      async deliver({ deliver, texts }) {
        await deliver('Have the reader check.', '1786000049.000001');
        const second = await deliver('Have the writer start.', '1786000049.000002');
        // The request before the prompt was answered before agy said anything more, so all it said goes to the prompt.
        assert.equal(texts[1], 'REPORT FOR A ONLY.Started a writer.');
        assert.deepEqual(
          itemsWith(allActivities(await loadState()), 'tool.call.started', 'providerToolId', 'agy-invoke-check'),
          [second.item.id],
        );
      },
      scenario: { reportAfterBarrier: true },
      wake: { pollMs: 20, quietMs: 60_000, settleMs: 100, subagentsDoneMs: 800 },
    });
  });

  for (const repeat of [true, false]) {
    reloadTest(reload, repeat ? 'whenIdle' : 'provider-env', `antigravity-cli lets a ${reload} reload go ahead once the third item's subagent stops, when the second item's answer is read only after a turn agy started on its own, which started a subagent, ended idle${repeat ? ', and the second prompt has the first one\'s text' : ''}`, async () => {
      await reloadsOnceWorkIsDone(reload, {
        async deliver({ deliver, runtime, texts, triggerPath }) {
          await deliver('Have the reader check.', '1786000049.000001');
          const second = await deliver('Have the writer start.', '1786000049.000002');
          assert.equal(
            (await readFile(`${triggerPath}.prompt2`, 'utf8')) === (await readFile(`${triggerPath}.prompt1`, 'utf8')),
            repeat,
          );
          assert.equal(texts[1], 'B foreground.');
          await withTimeout(runtime().waitForProviderQuiescent(), 5_000);
          assert.deepEqual(itemsWith(allActivities(await loadState()), 'agent.text', 'text', 'B-SELF-REPORT.'), [second.item.id]);
          await deliver('Have the checker look.', '1786000049.000003');
          assert.equal(texts[2], 'C foreground.');
        },
        input: (input, index, inputs) => (repeat && index === 2
          ? { ...input, prompt: inputs[0]!.prompt, systemPrompt: inputs[0]!.systemPrompt }
          : input),
        scenario: { reportBeforeAnswer: true },
        wake: { pollMs: 20, quietMs: 300, settleMs: 100, subagentsDoneMs: 800 },
      });
    });
  }
}

for (const reload of ['whenIdle', 'provider-env'] as const) {
  const fast: AntigravityWakeTiming = { pollMs: 20, quietMs: 60_000, settleMs: 100, subagentsDoneMs: 800 };
  /** Past the silence window, the reload still waits; then `trigger` lets agy's last report come. */
  const waitsFor = (trigger: string) => async ({ generation, triggerPath }: AntigravityHostItems) => {
    await realDelay(1_500);
    assert.equal(generation(), 1);
    await writeFile(`${triggerPath}.${trigger}`, '');
  };
  const reportedOn = async (text: string) => itemsWith(allActivities(await loadState()), 'agent.text', 'text', text);

  for (const calls of ['one', 'split'] as const) {
    reloadTest(reload, calls === 'one' ? 'whenIdle' : 'provider-env', `antigravity-cli lets a ${reload} reload go ahead only once both subagents ${calls === 'one' ? 'one call' : 'two calls'} started have stopped, after the writer's report`, async () => {
      let first: string | undefined;
      await reloadsOnceWorkIsDone(reload, {
        async afterReload() {
          assert.deepEqual(await reportedOn('WRITER REPORT.'), [first]);
        },
        async deliver({ deliver, texts }) {
          first = (await deliver('Have a reader and a writer start.', '1786000049.000001')).item.id;
          assert.equal(texts[0], 'Started a reader and a writer.');
        },
        scenario: { twoSubagents: calls },
        wake: fast,
        whileReloadWaits: waitsFor('writer-go'),
      });
    });
  }

  reloadTest(reload, 'provider-env', `antigravity-cli lets a ${reload} reload go ahead only once a subagent a message woke has stopped again, after its second report`, async () => {
    let first: string | undefined;
    await reloadsOnceWorkIsDone(reload, {
      async afterReload() {
        assert.deepEqual(await reportedOn('READER SECOND REPORT.'), [first]);
      },
      async deliver({ deliver, texts }) {
        first = (await deliver('Have a reader and a writer start.', '1786000049.000001')).item.id;
        assert.equal(texts[0], 'The reader has a follow-up.');
      },
      scenario: { rewake: true },
      wake: fast,
      whileReloadWaits: waitsFor('reader-go'),
    });
  });

  reloadTest(reload, 'whenIdle', `antigravity-cli lets a ${reload} reload go ahead once a subagent the next prompt only woke has stopped, after its report`, async () => {
    let second: string | undefined;
    await reloadsOnceWorkIsDone(reload, {
      async afterReload() {
        assert.deepEqual(await reportedOn('READER SECOND REPORT.'), [second]);
      },
      async deliver({ deliver, runtime, texts }) {
        const first = await deliver('Have a reader start.', '1786000049.000001');
        await withTimeout(runtime().waitForProviderQuiescent(), 5_000);
        assert.deepEqual(await reportedOn('READER REPORT.'), [first.item.id]);
        second = (await deliver('Ask the reader again.', '1786000049.000002')).item.id;
        assert.equal(texts[1], 'Asked the reader again.');
      },
      scenario: { wakeOnly: true },
      wake: fast,
      whileReloadWaits: waitsFor('reader-go'),
    });
  });

  reloadTest(reload, 'provider-env', `antigravity-cli lets a ${reload} reload go ahead once the subagent a subagent started has stopped, after both the coordinator and the session said work goes on`, async () => {
    let first: string | undefined;
    await reloadsOnceWorkIsDone(reload, {
      async afterReload() {
        assert.deepEqual(await reportedOn('COORDINATOR REPORT.'), [first]);
      },
      async deliver({ deliver, texts }) {
        first = (await deliver('Have a coordinator start.', '1786000049.000003')).item.id;
        assert.equal(texts[0], 'Started a coordinator.');
      },
      scenario: { nested: true },
      wake: fast,
      whileReloadWaits: waitsFor('leaf-go'),
    });
  });

  reloadTest(reload, 'whenIdle', `antigravity-cli lets a ${reload} reload go ahead only once the coordinator runs again and stops, when it started its subagent while the session's loop ran`, async () => {
    let first: string | undefined;
    await reloadsOnceWorkIsDone(reload, {
      async afterReload() {
        assert.deepEqual(await reportedOn('COORDINATOR REPORT.'), [first]);
      },
      async deliver({ deliver, texts }) {
        first = (await deliver('Have a coordinator start.', '1786000049.000003')).item.id;
        assert.equal(texts[0], 'Started a coordinator.');
      },
      scenario: { nested: 'inLoop' },
      wake: fast,
      // That subagent could be the session's, so its stop does not end the coordinator's work.
      async whileReloadWaits(items) {
        await waitsFor('leaf-go')(items);
        await waitsFor('coordinator-go')(items);
      },
    });
  });

  reloadTest(reload, 'provider-env', `antigravity-cli lets a ${reload} reload go ahead only once a subagent that said work of its own goes on while another ran has run again and stopped, after its report`, async () => {
    let first: string | undefined;
    await reloadsOnceWorkIsDone(reload, {
      async afterReload() {
        assert.deepEqual(await reportedOn('READER COMMAND REPORT.'), [first]);
      },
      async deliver({ deliver, texts }) {
        first = (await deliver('Have a reader and a writer start.', '1786000049.000001')).item.id;
        assert.equal(texts[0], 'Started a reader and a writer.');
      },
      scenario: { peerWork: true },
      wake: fast,
      whileReloadWaits: waitsFor('reader-go'),
    });
  });

  // Subagents keep who they are across background periods: the writer is the reader's sibling, not its subagent.
  reloadTest(reload, 'whenIdle', `antigravity-cli lets a ${reload} reload go ahead only once a subagent the next prompt woke says work of its own goes on and runs again, when it woke a sibling from before`, async () => {
    let second: string | undefined;
    await reloadsOnceWorkIsDone(reload, {
      async afterReload() {
        assert.deepEqual(await reportedOn('READER COMMAND REPORT.'), [second]);
      },
      async deliver({ deliver, runtime, texts }) {
        const first = await deliver('Have a reader and a writer start.', '1786000049.000001');
        assert.equal(texts[0], 'Started a reader and a writer.');
        await withTimeout(runtime().waitForProviderQuiescent(), 5_000);
        assert.deepEqual(await reportedOn('READER AND WRITER REPORT.'), [first.item.id]);
        second = (await deliver('Ask the reader again.', '1786000049.000002')).item.id;
        assert.equal(texts[1], 'Asked the reader again.');
      },
      scenario: { peerRewake: true },
      wake: fast,
      whileReloadWaits: waitsFor('reader-go'),
    });
  });

  reloadTest(reload, 'provider-env', `antigravity-cli lets a ${reload} reload go ahead once the subagent a coordinator started earlier has stopped, when the next prompt woke the coordinator and it woke that subagent`, async () => {
    let second: string | undefined;
    await reloadsOnceWorkIsDone(reload, {
      async afterReload() {
        assert.equal(itemsWith(allActivities(await loadState()), 'agent.text', 'itemId', second ?? assert.fail('B was delivered')).length, 1);
      },
      async deliver({ deliver, runtime, texts }) {
        const first = await deliver('Have a coordinator start.', '1786000049.000003');
        assert.equal(texts[0], 'Started a coordinator.');
        await withTimeout(runtime().waitForProviderQuiescent(), 5_000);
        assert.deepEqual(await reportedOn('COORDINATOR REPORT.'), [first.item.id]);
        second = (await deliver('Ask the coordinator again.', '1786000049.000004')).item.id;
        assert.equal(texts[1], 'Asked the coordinator again.');
      },
      scenario: { nestedAgain: true },
      wake: fast,
      whileReloadWaits: waitsFor('leaf-go'),
    });
  });

  // What is known of a subagent outlasts work that ended because its subagents stopped, too.
  reloadTest(reload, 'whenIdle', `antigravity-cli lets a ${reload} reload go ahead once the subagent a coordinator started earlier has stopped, when the next prompt woke the coordinator and it woke that subagent, after the earlier work ended with no Stop of the session's own`, async () => {
    let second: string | undefined;
    await reloadsOnceWorkIsDone(reload, {
      async afterReload() {
        assert.equal(itemsWith(allActivities(await loadState()), 'agent.text', 'itemId', second ?? assert.fail('B was delivered')).length, 1);
      },
      async deliver({ deliver, runtime, texts }) {
        const first = await deliver('Have a coordinator start.', '1786000049.000005');
        assert.equal(texts[0], 'Started a coordinator.');
        await withTimeout(runtime().waitForProviderQuiescent(), 5_000);
        assert.deepEqual(await reportedOn('COORDINATOR REPORT.'), [first.item.id]);
        second = (await deliver('Ask the coordinator again.', '1786000049.000006')).item.id;
        assert.equal(texts[1], 'Asked the coordinator again.');
      },
      scenario: { nestedAgain: 'reportFirst' },
      wake: fast,
      whileReloadWaits: waitsFor('leaf-go'),
    });
  });

  for (const [next, ownTool] of [['fail', false], ['append', false], ['fail', true], ['append', true]] as const) {
    const failure = next === 'fail' ? 'fails' : 'is cancelled for a follow-up';
    const name = ownTool
      ? `once its subagent has stopped, not waiting on a call the next prompt started before it ${failure}`
      : `only once a command an earlier prompt left running has ended, after its report, when the next prompt ${failure}`;
    reloadTest(reload, (next === 'fail') === ownTool ? 'whenIdle' : 'provider-env', `antigravity-cli lets a ${reload} reload go ahead ${name}`, async () => {
      let first: string | undefined;
      let second: string | undefined;
      await reloadsOnceWorkIsDone(reload, {
        async afterReload() {
          const a = first ?? assert.fail('A was delivered');
          const b = second ?? assert.fail('B was delivered');
          const activities = allActivities(await loadState());
          if (!ownTool) assert.deepEqual(await reportedOn('COMMAND A FINISHED.'), [a]);
          // B's own result: the reply to it and the follow-up, or its failure.
          if (next === 'append') assert.deepEqual(await reportedOn('HANDLED B AND THE FOLLOW-UP.'), [b]);
          else assert.equal(itemsWith(activities, 'agent.text', 'itemId', b).length, 0);
          assert.deepEqual(itemsWith(activities, 'runtime.failed', 'itemId', b), next === 'fail' ? [b] : []);
          assert.deepEqual(itemsWith(activities, 'runtime.failed', 'itemId', a), []);
        },
        async deliver({ deliver, drain, ingest, texts, triggerPath }) {
          first = (await deliver('Start a command and a reader.', '1786000049.000001')).item.id;
          assert.equal(texts[0], ownTool ? 'Started a reader.' : 'Started a command and a reader.');
          const ctx = await ingest('Answer something else.', '1786000049.000002');
          second = ctx.item.id;
          if (next === 'fail') {
            assert.equal(await drain(), 1);
            assert.deepEqual(texts.slice(1), []);
            return;
          }
          const drained = drain();
          await pollUntil(() => fileExists(`${triggerPath}.b-start`), 5_000);
          await ingest('Also cover the follow-up.', '1786000049.000003');
          assert.equal(await withTimeout(drained, 5_000) >= 1, true);
          assert.deepEqual(texts.slice(1), ['HANDLED B AND THE FOLLOW-UP.']);
        },
        scenario: { commandThen: next, ownTool },
        wake: fast,
        ...(ownTool ? {} : { whileReloadWaits: waitsFor('command-go') }),
      });
    });
  }

  // New hook events wait for the settle time before they are applied.
  const settling: AntigravityWakeTiming = { pollMs: 20, quietMs: 60_000, settleMs: 400, subagentsDoneMs: 800 };
  for (const [when, scenario, kind] of [
    ['after its subagent stopped', { reportLoop: 'afterStop' }, 'whenIdle'],
    ['before its subagent stopped', { reportLoop: 'beforeStop' }, 'provider-env'],
    ['600ms after its subagent stopped, so that call is still settling when the silence window ends', { callAfterMs: 600, reportLoop: 'afterStop' }, 'whenIdle'],
  ] as const) {
    reloadTest(reload, kind, `antigravity-cli lets a ${reload} reload go ahead only once the session's report loop that called the model ${when} has stopped`, async () => {
      let first: string | undefined;
      await reloadsOnceWorkIsDone(reload, {
        async afterReload() {
          assert.deepEqual(await reportedOn('PRIMARY REPORT.'), [first]);
        },
        async deliver({ deliver, texts }) {
          first = (await deliver('Have a reader start.', '1786000049.000001')).item.id;
          assert.equal(texts[0], 'Started a reader.');
        },
        scenario,
        wake: settling,
        whileReloadWaits: waitsFor('report-go'),
      });
    });
  }
}

for (const failure of ['before', 'after'] as const) {
  test(`antigravity-cli keeps background work for the session's report when an invoke_subagent call fails ${failure} the subagent's and the session's Stops`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-fail-'));
    let runtime: AntigravityCliAgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const triggerPath = join(stateDir, 'wake-trigger');
        await installFakeAgy(stateDir);
        const ctx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000048.000001');
        runtime = new AntigravityCliAgentRuntime(
          {
            env: agyEnv(stateDir, { failsAround: failure }, { WAKE_TRIGGER_PATH: triggerPath }),
            kind: 'antigravity-cli',
            providerChildIdleTimeoutMs: 200,
          },
          'agy',
          [],
          { wake: { pollMs: 20, quietMs: 150, settleMs: 100, subagentsDoneMs: 800 } },
        );
        const active = runtime;
        assert.equal((await active.run(await runtimeInput(active, ctx, await loadState()))).text, 'Started a subagent.');
        await pollUntil(async () => allActivities(await loadState()).some((activity) =>
          activity.type === 'tool.call.failed' && activity.payload?.['providerToolId'] === 'agy-invoke-x'), 5_000);
        // The subagent stopped before the session's last Stop, which said work goes on: the
        // session still owes its report, however long the silence.
        await realDelay(1_500);
        assert.deepEqual(active.health().providerWork, { state: 'background' });
        assert.equal(active.health().child?.alive, true);
        await writeFile(triggerPath, '');
        const reported = async () => allActivities(await loadState())
          .filter((activity) => activity.type === 'agent.text' && activity.payload?.['text'] === 'FINAL REPORT.')
          .map((activity) => activity.payload?.['itemId']);
        await pollUntil(async () => (await reported()).length > 0, 5_000);
        assert.deepEqual(await reported(), [ctx.item.id]);
        await withTimeout(active.waitForProviderQuiescent(), 5_000);
      });
    } finally {
      await runtime?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

test('antigravity-cli keeps a Stop for the settle time, so output of its turn that Anima reads late stays in that turn', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-settle-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const triggerPath = join(stateDir, 'wake-trigger');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000035.000001');
      runtime = new AntigravityCliAgentRuntime(
        { env: agyEnv(stateDir, { replyAfterStop: true, wake: true }, { WAKE_TRIGGER_PATH: triggerPath }), kind: 'antigravity-cli' },
        'agy',
        [],
        // The reply comes 300ms after the Stop; the poll applies the Stop only once it is 2s old.
        { wake: { pollMs: 20, quietMs: 60_000, settleMs: 2_000 } },
      );
      const active = runtime;
      const input = await runtimeInput(active, ctx, await loadState());
      let replied = false;
      let quiescentEarly = false;
      const reply = await active.run({
        ...input,
        effects: {
          ...input.effects,
          async recordAgentText(text, payload) {
            if (text === 'SUMMARY SAVED') replied = true;
            return input.effects.recordAgentText(text, payload);
          },
        },
      });
      assert.equal(reply.text, 'Started a subagent.');
      const sampler = setInterval(() => {
        if (!replied && active.isProviderQuiescent() === true) quiescentEarly = true;
      }, 5);
      try {
        await writeFile(triggerPath, '');
        await pollUntil(() => replied || quiescentEarly, 5_000);
        assert.equal(quiescentEarly, false, 'the work stays until the reply before the Stop is handled');
        await pollUntil(() => active.isProviderQuiescent() === true, 5_000);
      } finally {
        clearInterval(sampler);
      }
      await pollUntil(async () => allActivities(await loadState()).some((activity) =>
        activity.type === 'agent.text'
          && activity.payload?.['text'] === 'SUMMARY SAVED'
          && activity.payload?.['itemId'] === ctx.item.id), 5_000);
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli does not let a settled Stop overtake output it has read but not yet handled', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-drain-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const triggerPath = join(stateDir, 'wake-trigger');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000036.000001');
      runtime = new AntigravityCliAgentRuntime(
        { env: agyEnv(stateDir, { wake: true }, { WAKE_TRIGGER_PATH: triggerPath }), kind: 'antigravity-cli' },
        'agy',
        [],
        { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100 } },
      );
      const active = runtime;
      const input = await runtimeInput(active, ctx, await loadState());
      const held = deferred();
      const release = deferred();
      const reply = await active.run({
        ...input,
        effects: {
          ...input.effects,
          async recordToolStarted(payload) {
            if (payload['providerToolId'] === 'agy-wake-tool') {
              held.resolve();
              await release.promise;
            }
            return input.effects.recordToolStarted(payload);
          },
        },
      });
      assert.equal(reply.text, 'Started a subagent.');
      await writeFile(triggerPath, '');
      let drained = false;
      let waiting: Promise<void> | undefined;
      try {
        await withTimeout(held.promise, 5_000);
        await pollUntil(() => fileExists(`${triggerPath}.stopped`), 5_000);
        waiting = active.waitForProviderQuiescent().then(() => {
          drained = true;
        });
        // Well past settleMs: the Stop is settled, but the output before it is not handled yet.
        await realDelay(400);
        assert.equal(active.isProviderQuiescent(), false);
        assert.equal(drained, false);
      } finally {
        release.resolve();
      }
      await withTimeout(waiting, 5_000);
      assert.equal(active.isProviderQuiescent(), true);
      await pollUntil(async () => allActivities(await loadState()).some((activity) =>
        activity.type === 'agent.text'
          && activity.payload?.['text'] === 'SUMMARY SAVED'
          && activity.payload?.['itemId'] === ctx.item.id), 5_000);
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

for (const wait of ['quiescence', 'close'] as const) {
  test(`antigravity-cli lets ${wait} wait until a self-started turn's text is stored`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-store-'));
    let runtime: AntigravityCliAgentRuntime | undefined;
    try {
      await withAnimaHome(stateDir, async () => {
        const triggerPath = join(stateDir, 'wake-trigger');
        await installFakeAgy(stateDir);
        const ctx = await ingestAgyEvent(stateDir, 'Delegate the reading.', '1786000039.000001');
        runtime = new AntigravityCliAgentRuntime(
          { env: agyEnv(stateDir, { wake: true }, { WAKE_TRIGGER_PATH: triggerPath }), kind: 'antigravity-cli' },
          'agy',
          [],
          { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100 } },
        );
        const active = runtime;
        const input = await runtimeInput(active, ctx, await loadState());
        const held = deferred();
        const release = deferred();
        const reply = await active.run({
          ...input,
          effects: {
            ...input.effects,
            async recordAgentText(text, payload) {
              if (text === 'SUMMARY SAVED') {
                held.resolve();
                await release.promise;
              }
              return input.effects.recordAgentText(text, payload);
            },
          },
        });
        assert.equal(reply.text, 'Started a subagent.');
        await writeFile(triggerPath, '');
        let done = false;
        let waiting: Promise<void> | undefined;
        try {
          await withTimeout(held.promise, 5_000);
          waiting = (wait === 'close' ? active.close() : active.waitForProviderQuiescent()).then(() => {
            done = true;
          });
          await realDelay(300);
          assert.equal(done, false, `${wait} waits for the write`);
          assert.equal(active.isProviderQuiescent() === true, false);
        } finally {
          release.resolve();
        }
        await withTimeout(waiting, 5_000);
        const stored = allActivities(await loadState()).filter((activity) =>
          activity.type === 'agent.text' && activity.payload?.['text'] === 'SUMMARY SAVED');
        assert.deepEqual(stored.map((activity) => activity.payload?.['itemId']), [ctx.item.id]);
      });
    } finally {
      await runtime?.close();
      await rm(stateDir, { force: true, recursive: true });
    }
  });
}

test('antigravity-cli is not quiescent while it handles output read after a turn ended', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-late-output-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'A plain question.', '1786000037.000001');
      runtime = new AntigravityCliAgentRuntime(
        { env: agyEnv(stateDir, { lateUsage: true }), kind: 'antigravity-cli' },
        'agy',
        [],
        { wake: { pollMs: 20, quietMs: 60_000, settleMs: 100 } },
      );
      const active = runtime;
      const input = await runtimeInput(active, ctx, await loadState());
      const held = deferred();
      const release = deferred();
      let drained = false;
      let waiting: Promise<void> | undefined;
      try {
        const reply = await withTimeout(active.run({
          ...input,
          effects: {
            ...input.effects,
            async recordEvent(event) {
              if (event['eventType'] === 'antigravity.context.stats' && event['currentContextTokens'] === 7000) {
                held.resolve();
                await release.promise;
              }
              return input.effects.recordEvent(event);
            },
          },
        }), 5_000);
        assert.equal(reply.text, 'reply 1');
        await withTimeout(held.promise, 5_000);
        assert.equal(active.isProviderQuiescent(), false);
        const abort = new AbortController();
        const aborted = active.waitForProviderQuiescent(abort.signal);
        abort.abort();
        await assert.rejects(withTimeout(aborted, 1_000), (error: unknown) => (error as { name?: string }).name === 'AbortError');
        waiting = active.waitForProviderQuiescent().then(() => {
          drained = true;
        });
        await realDelay(200);
        assert.equal(drained, false);
      } finally {
        release.resolve();
      }
      await withTimeout(waiting, 5_000);
      assert.equal(active.isProviderQuiescent(), true);
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('antigravity-cli ends a turn agy starts on its own after a quiet period when agy runs no hooks', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-agy-wake-nohook-'));
  let runtime: AntigravityCliAgentRuntime | undefined;
  try {
    await withAnimaHome(stateDir, async () => {
      const triggerPath = join(stateDir, 'wake-trigger');
      await installFakeAgy(stateDir);
      const ctx = await ingestAgyEvent(stateDir, 'Delegate without hooks.', '1786000031.000001');
      runtime = new AntigravityCliAgentRuntime(
        {
          env: agyEnv(stateDir, { agents: 'none', appendSystemPrompt: true, wake: true }, { WAKE_TRIGGER_PATH: triggerPath }),
          kind: 'antigravity-cli',
        },
        'agy',
        [],
        { wake: { pollMs: 20, quietMs: 1_000 } },
      );
      const active = runtime;
      assert.equal((await active.run(await runtimeInput(active, ctx, await loadState()))).text, 'Started a subagent.');
      assert.equal(active.isProviderQuiescent(), true, 'without hooks nothing reports background work');

      await writeFile(triggerPath, '');
      await pollUntil(async () => allActivities(await loadState()).some((activity) =>
        activity.type === 'tool.call.started' && activity.payload?.['providerToolId'] === 'agy-wake-tool'), 5_000);
      assert.equal(active.isProviderQuiescent(), false, 'the self-started turn is still open');
      assert.deepEqual(active.health().providerWork, { state: 'working' });
      await pollUntil(() => active.isProviderQuiescent() === true, 5_000);
      await pollUntil(async () => allActivities(await loadState()).some((activity) =>
        activity.type === 'agent.text'
          && activity.payload?.['text'] === 'SUMMARY SAVED'
          && activity.payload?.['itemId'] === ctx.item.id), 5_000);
    });
  } finally {
    await runtime?.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

function agyEnv(
  stateDir: string,
  scenario: Record<string, unknown>,
  extra: Record<string, string> = {},
): Record<string, string> {
  return runtimeTestEnv(stateDir, {
    AGY_CONFIG_OPTIONS: JSON.stringify(CONFIG_OPTIONS),
    AGY_SCENARIO: JSON.stringify(scenario),
    CALLS_PATH: join(stateDir, 'calls.jsonl'),
    ...extra,
  });
}

async function installFakeAgy(stateDir: string): Promise<void> {
  const path = join(stateDir, 'agy');
  await writeFile(path, ['#!/usr/bin/env node', ...FAKE_AGY].join('\n'), 'utf8');
  await chmod(path, 0o755);
}

/**
 * `agy` as a shell script that waits for the fake CLI (`agy-cli`) on `agy agents`, the
 * way a wrapper does, and execs it otherwise. Its own pid goes to WRAPPER_PID_PATH.
 */
async function installWrappedFakeAgy(stateDir: string): Promise<void> {
  const cli = join(stateDir, 'agy-cli');
  await writeFile(cli, ['#!/usr/bin/env node', ...FAKE_AGY].join('\n'), 'utf8');
  await chmod(cli, 0o755);
  const path = join(stateDir, 'agy');
  await writeFile(path, [
    '#!/bin/sh',
    'case "$*" in',
    `  *agents) echo $$ > "$WRAPPER_PID_PATH"; ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@" ;;`,
    `  *) exec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@" ;;`,
    'esac',
    '',
  ].join('\n'), 'utf8');
  await chmod(path, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function readPid(path: string): Promise<number> {
  const pid = Number((await readFile(path, 'utf8')).trim());
  // pid 0 or below would address a process group.
  assert.ok(Number.isInteger(pid) && pid > 0, `pid in ${path}`);
  return pid;
}

function killLeftovers(pids: number[]): void {
  for (const pid of pids) if (pid > 0 && processAlive(pid)) process.kill(pid, 'SIGKILL');
}

async function ingestAgyEvent(stateDir: string, text: string, ts: string) {
  return ingestEvent(
    makeSlackEvent({
      channelId: 'D-antigravity',
      teamId: 'T-demo',
      text,
      ts,
      userId: 'U1',
    }),
    { agentId: 'anima', stateDir },
  );
}

function methodsOf(calls: Array<Record<string, unknown>>): string[] {
  return calls.filter((call) => typeof call.method === 'string').map((call) => call.method as string);
}

function promptTexts(calls: Array<Record<string, unknown>>): string[] {
  return calls
    .filter((call) => call.method === 'session/prompt')
    .map((call) => ((call.params as Record<string, unknown>)?.prompt as Array<{ text?: string }>)[0]?.text ?? '');
}

async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The prompt's result reported 100 input and 20 output tokens; they count once. */
async function assertUsageRecordedOnce(): Promise<void> {
  const usage = await agentTokenUsageServiceForAgent('anima').summary({
    agentName: 'Anima',
    from: '2000-01-01',
    through: '2100-01-01',
    timezone: 'UTC',
  });
  assert.equal(usage.reportedRuns, 1);
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.totalTokens, 120);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fileExists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, () => false);
}

// Real-time waits for tests that mock setTimeout; setInterval is left real.
function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setInterval(() => {
      clearInterval(handle);
      resolve();
    }, ms);
  });
}

async function pollUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${predicate.toString()}`);
    await realDelay(10);
  }
}
