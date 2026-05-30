import { isRecord, stringField } from '../json.js';
import {
  copyActivityPreview,
  copyBoolean,
  copyNumber,
  copyString,
} from '../activities/format.js';
import type { AgentRuntimeInput } from './contract.js';
import { exposedReasoningEvent } from './reasoning-events.js';

export async function recordKimiWireEvent(
  input: AgentRuntimeInput,
  wireType: string | undefined,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!wireType) return;
  if (wireType === 'CompactionBegin') {
    await input.effects.recordEvent({ eventType: 'kimi.compact.started', runtimeKind: 'kimi-cli' });
    return;
  }
  if (wireType === 'CompactionEnd') {
    await input.effects.recordEvent({ eventType: 'kimi.compact.completed', runtimeKind: 'kimi-cli' });
    return;
  }
  if (wireType === 'TurnBegin') {
    await input.effects.recordEvent({
      eventType: 'kimi.turn.started',
      runtimeKind: 'kimi-cli',
      userInputLength: contentLength(payload['user_input']),
    });
    return;
  }
  if (wireType === 'TurnEnd') {
    await input.effects.recordEvent({ eventType: 'kimi.turn.completed', runtimeKind: 'kimi-cli' });
    return;
  }
  if (wireType === 'StepBegin') {
    const event: Record<string, unknown> = { eventType: 'kimi.step.started', runtimeKind: 'kimi-cli' };
    copyNumber(payload, event, 'n', 'step');
    await input.effects.recordEvent(event);
    return;
  }
  if (wireType === 'StatusUpdate') {
    const event: Record<string, unknown> = { eventType: 'kimi.context.stats', runtimeKind: 'kimi-cli' };
    copyNumber(payload, event, 'context_tokens', 'currentContextTokens');
    copyNumber(payload, event, 'max_context_tokens', 'contextWindow');
    copyNumber(payload, event, 'context_usage', 'contextUsage');
    copyString(payload, event, 'message_id', 'messageId');
    copyBoolean(payload, event, 'plan_mode', 'planMode');
    const tokenUsage = isRecord(payload['token_usage']) ? payload['token_usage'] : undefined;
    copyNumber(tokenUsage, event, 'input_other', 'inputTokens');
    copyNumber(tokenUsage, event, 'output', 'outputTokens');
    copyNumber(tokenUsage, event, 'input_cache_read', 'cacheReadInputTokens');
    copyNumber(tokenUsage, event, 'input_cache_creation', 'cacheCreationInputTokens');
    await input.effects.recordEvent(event);
    return;
  }
  if (wireType === 'ContentPart') {
    const partType = stringField(payload, 'type');
    if (partType === 'think') {
      const event: Record<string, unknown> = { eventType: 'kimi.thinking.delta', runtimeKind: 'kimi-cli' };
      copyActivityPreview(payload, event, 'think', 'text');
      if (stringField(payload, 'encrypted')) event['encryptedPresent'] = true;
      await input.effects.recordEvent(event);
      await input.effects.recordEvent(exposedReasoningEvent({
        provider: 'kimi',
        runtimeKind: 'kimi-cli',
        sourceEventType: 'kimi.thinking.delta',
        text: stringField(payload, 'think'),
        textKind: 'think',
      }));
      return;
    }
    if (partType && partType !== 'text') {
      await input.effects.recordEvent({ eventType: 'kimi.content.part', partType, runtimeKind: 'kimi-cli' });
    }
    return;
  }
  if (wireType === 'ToolCallPart') {
    const event: Record<string, unknown> = { eventType: 'kimi.tool.call.part', runtimeKind: 'kimi-cli' };
    copyActivityPreview(payload, event, 'arguments', 'arguments');
    await input.effects.recordEvent(event);
    return;
  }
  if (wireType === 'ToolResult') {
    const event: Record<string, unknown> = { eventType: 'kimi.tool_result', runtimeKind: 'kimi-cli' };
    copyString(payload, event, 'tool_call_id', 'providerToolId');
    const returnValue = isRecord(payload['return_value']) ? payload['return_value'] : undefined;
    copyBoolean(returnValue, event, 'is_error', 'isError');
    copyActivityPreview(returnValue, event, 'output', 'output');
    copyActivityPreview(returnValue, event, 'message', 'message');
    await input.effects.recordEvent(event);
    return;
  }
  if (wireType === 'SteerInput') {
    await input.effects.recordEvent({
      eventType: 'kimi.steer.consumed',
      runtimeKind: 'kimi-cli',
      userInputLength: contentLength(payload['user_input']),
    });
    return;
  }
  if (wireType === 'PlanDisplay') {
    const event: Record<string, unknown> = { eventType: 'kimi.plan.display', runtimeKind: 'kimi-cli' };
    copyString(payload, event, 'file_path', 'filePath');
    copyActivityPreview(payload, event, 'content', 'content');
    await input.effects.recordEvent(event);
    return;
  }
  if (wireType === 'HookTriggered') {
    const event: Record<string, unknown> = { eventType: 'kimi.hook.triggered', runtimeKind: 'kimi-cli' };
    copyString(payload, event, 'event', 'hookEvent');
    copyString(payload, event, 'target', 'target');
    copyNumber(payload, event, 'hook_count', 'hookCount');
    await input.effects.recordEvent(event);
    return;
  }
  if (wireType === 'HookResolved') {
    const event: Record<string, unknown> = { eventType: 'kimi.hook.resolved', runtimeKind: 'kimi-cli' };
    copyString(payload, event, 'event', 'hookEvent');
    copyString(payload, event, 'target', 'target');
    copyString(payload, event, 'action', 'action');
    copyActivityPreview(payload, event, 'reason', 'reason');
    copyNumber(payload, event, 'duration_ms', 'durationMs');
    await input.effects.recordEvent(event);
    return;
  }
  if (wireType === 'ApprovalResponse') {
    const event: Record<string, unknown> = { eventType: 'kimi.approval.response', runtimeKind: 'kimi-cli' };
    copyString(payload, event, 'request_id', 'requestId');
    copyString(payload, event, 'response', 'response');
    copyActivityPreview(payload, event, 'feedback', 'feedback');
    await input.effects.recordEvent(event);
    return;
  }
  if (wireType === 'SubagentEvent') {
    const nested = isRecord(payload['event']) ? payload['event'] : undefined;
    const event: Record<string, unknown> = { eventType: 'kimi.subagent.event', runtimeKind: 'kimi-cli' };
    copyString(payload, event, 'parent_tool_call_id', 'parentToolCallId');
    copyString(payload, event, 'agent_id', 'agentId');
    copyString(payload, event, 'subagent_type', 'subagentType');
    copyString(nested, event, 'type', 'nestedEventType');
    await input.effects.recordEvent(event);
  }
}

export function kimiInitializeEvent(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const protocolVersion = stringField(result, 'protocol_version');
  const server = isRecord(result['server']) ? result['server'] : undefined;
  if (!protocolVersion || !server) return undefined;
  const event: Record<string, unknown> = {
    eventType: 'kimi.system.init',
    protocolVersion,
    runtimeKind: 'kimi-cli',
  };
  copyString(server, event, 'name', 'serverName');
  copyString(server, event, 'version', 'serverVersion');
  const slashCommands = Array.isArray(result['slash_commands']) ? result['slash_commands'] : undefined;
  if (slashCommands) {
    event['slashCommandsCount'] = slashCommands.length;
    const names = slashCommands
      .map((command) => isRecord(command) ? stringField(command, 'name') : undefined)
      .filter((name): name is string => Boolean(name))
      .slice(0, 50);
    if (names.length > 0) event['slashCommands'] = names;
  }
  const capabilities = isRecord(result['capabilities']) ? result['capabilities'] : undefined;
  copyBoolean(capabilities, event, 'supports_question', 'supportsQuestion');
  const hooks = isRecord(result['hooks']) ? result['hooks'] : undefined;
  if (Array.isArray(hooks?.['supported_events'])) event['hookEventCount'] = hooks['supported_events'].length;
  return event;
}

function contentLength(value: unknown): number | undefined {
  if (typeof value === 'string') return value.length;
  if (!Array.isArray(value)) return undefined;
  return value.reduce((sum, item) => {
    if (!isRecord(item)) return sum;
    const text = stringField(item, 'text') ?? stringField(item, 'think');
    return sum + (text?.length ?? 0);
  }, 0);
}
