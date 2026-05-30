import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentRuntimeEffects } from './contract.js';
import type { ProviderSessionRecord } from './contract.js';
import { exposedReasoningEvent, notExposedReasoningEvent } from './reasoning-events.js';
import { isFirstClassAnimaCliCommand, truncateForActivity } from '../activities/format.js';
import {
  copyActivityPreview,
  copyBoolean,
  copyNumber,
  copyString,
} from '../activities/format.js';
import { nowIso } from '../ids.js';
import { isNonEmptyString, isRecord, singleLine, singleLineForActivity, stringField } from '../json.js';

export function createClaudeJsonlActivityMapper(effects: AgentRuntimeEffects, runtimeKind: string): {
  accept(chunk: string): Promise<void>;
  flush(): Promise<void>;
} {
  return createJsonlActivityMapper(effects, runtimeKind);
}

export function parseClaudeRuntimeOutput(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  let textResult: string | undefined;
  for (const line of trimmed.split(/\r?\n/).filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { text: trimmed };
    }
    if (isRecord(parsed) && typeof parsed['result'] === 'string') {
      textResult = parsed['result'];
      continue;
    }
    const text = textFromJsonEvent(parsed);
    if (text) textResult = text;
  }
  return textResult ? { text: textResult } : { text: trimmed };
}

function createJsonlActivityMapper(
  effects: AgentRuntimeEffects,
  runtimeKind: string,
): {
  accept(chunk: string): Promise<void>;
  flush(): Promise<void>;
} {
  let buffer = '';
  let reasoningExposed = false;
  let flushed = false;
  const state: ClaudeJsonlMapperState = {
    context: {},
    emittedSubagentTextKeys: new Set(),
    emittedSubagentToolIds: new Set(),
    ingestedSubagentLogs: new Set(),
    pendingAgentToolIds: new Set(),
    pendingSubagentResultsByAgentId: new Map(),
    pendingUnlinkedTexts: [],
    pendingUnlinkedToolsById: new Map(),
    providerToolsById: new Map(),
    subagentIdByToolId: new Map(),
    subagentMetadataByKey: new Map(),
  };
  return {
    async accept(chunk: string): Promise<void> {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        reasoningExposed = (await recordJsonlLine(effects, runtimeKind, line, state)) || reasoningExposed;
      }
    },
    async flush(): Promise<void> {
      if (flushed) return;
      flushed = true;
      if (buffer.trim()) {
        reasoningExposed = (await recordJsonlLine(effects, runtimeKind, buffer, state)) || reasoningExposed;
        buffer = '';
      }
      await flushPendingUnlinkedClaudeEvents(effects, runtimeKind, state);
      if (!reasoningExposed) {
        await effects.recordEvent(notExposedReasoningEvent({ provider: 'claude', runtimeKind }));
      }
    },
  };
}

async function recordJsonlLine(
  effects: AgentRuntimeEffects,
  runtimeKind: string,
  line: string,
  state: ClaudeJsonlMapperState,
): Promise<boolean> {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    await effects.recordOutput('stdout', trimmed);
    return false;
  }

  let reasoningExposed = false;
  updateClaudeJsonlContext(parsed, state.context);
  const compactEvent = compactForActivity(parsed);
  const eventType = eventTypeFromJson(parsed);
  const subagentLinkage = await subagentActivityLinkageFromClaudeJson(parsed, state);
  const runtimeEvents = runtimeEventsFromClaudeJson(parsed, runtimeKind);
  for (const event of runtimeEvents) {
    await effects.recordEvent(event);
    if (event['eventType'] === 'claude.thinking.delta') {
      reasoningExposed = true;
      await effects.recordEvent(exposedReasoningEvent({
        provider: 'claude',
        runtimeKind,
        sourceEventType: 'claude.thinking.delta',
        text: stringField(event, 'text'),
        textKind: 'raw',
      }));
    }
  }
  const providerSession = claudeSessionMetaFromJson(parsed);
  if (providerSession) {
    await effects.persistProviderSession(providerSession);
    return reasoningExposed;
  }

  const providerTools = providerToolCallsFromClaudeEvent(parsed, subagentLinkage);
  for (const tool of providerTools) {
    const providerToolId = stringField(tool, 'providerToolId');
    if (providerToolId) state.providerToolsById.set(providerToolId, tool);
    await recordClaudeToolStarted(effects, tool, state);
  }

  const providerToolFailures = providerToolFailuresFromClaudeEvent(parsed, runtimeKind, state.providerToolsById, eventType, subagentLinkage);
  for (const failure of providerToolFailures) {
    await effects.recordToolFailed(failure);
  }
  if (providerToolFailures.length > 0) return reasoningExposed;

  await recordClaudeSubagentResults(effects, runtimeKind, parsed, state);

  if (providerFailureFromJsonEvent(parsed, eventType)) {
    await effects.recordEvent({
      error: truncateForActivity(errorMessageFromJsonEvent(parsed) ?? compactEvent),
      eventType,
      runtimeKind,
    });
    return reasoningExposed;
  }

  const text = textFromClaudeJsonEvent(parsed);
  if (text) {
    const payload = {
      eventType,
      ...subagentLinkage,
    };
    if (shouldBufferUnlinkedClaudeText(payload, state)) {
      state.pendingUnlinkedTexts.push({ payload, text });
    } else {
      await effects.recordAgentText(text, payload);
    }
    return reasoningExposed;
  }
  return reasoningExposed;
}

function providerToolFailuresFromClaudeEvent(
  value: unknown,
  runtimeKind: string,
  providerToolsById: Map<string, Record<string, unknown>>,
  eventType: string,
  subagentLinkage: Record<string, unknown> = {},
): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const message = value['message'];
  if (!isRecord(message) || !Array.isArray(message['content'])) return [];
  return message['content']
    .map((item) => providerToolFailureFromClaudeContent(item, providerToolsById, eventType, runtimeKind, subagentLinkage))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function providerToolFailureFromClaudeContent(
  value: unknown,
  providerToolsById: Map<string, Record<string, unknown>>,
  eventType: string,
  runtimeKind: string,
  subagentLinkage: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  if (!isRecord(value) || stringField(value, 'type') !== 'tool_result' || value['is_error'] !== true) return undefined;
  const providerToolId = stringField(value, 'tool_use_id');
  const startedTool = providerToolId ? providerToolsById.get(providerToolId) : undefined;
  const error = textFromJsonValue(value['content'], new Set()) ?? compactForActivity(value);
  return {
    ...subagentLinkage,
    ...(startedTool ?? {}),
    error: truncateForActivity(error),
    eventType,
    ...(providerToolId ? { providerToolId } : {}),
    runtimeKind,
  };
}

function claudeSessionMetaFromJson(value: unknown): ProviderSessionRecord | undefined {
  if (!isRecord(value)) return undefined;
  const type = stringField(value, 'type');
  const subtype = stringField(value, 'subtype');
  if (!(type === 'system' && subtype === 'init') && type !== 'result') return undefined;
  const id = stringField(value, 'session_id');
  if (!id) return undefined;
  return {
    id,
    updatedAt: nowIso(),
  };
}

function runtimeEventsFromClaudeJson(value: unknown, runtimeKind: string): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const type = stringField(value, 'type');
  const subtype = stringField(value, 'subtype');
  if (type === 'system' && subtype === 'init') {
    return [claudeSystemInitEvent(value, runtimeKind)];
  }
  if (type === 'system' && subtype === 'status') {
    const status = stringField(value, 'status');
    if (status === 'compacting') {
      return [{ eventType: 'claude.compact.started', runtimeKind }];
    }
    const compactResult = stringField(value, 'compact_result');
    if (compactResult === 'failed') {
      return [{
        error: truncateForActivity(stringField(value, 'compact_error') ?? compactForActivity(value)),
        eventType: 'claude.compact.failed',
        runtimeKind,
      }];
    }
    if (status) {
      return [{ eventType: 'claude.system.status', runtimeKind, status }];
    }
  }
  if (type === 'system' && subtype === 'compact_boundary') {
    return [{ eventType: 'claude.compact.completed', runtimeKind }];
  }
  if (type === 'stream_event') {
    return claudeStreamEvents(value, runtimeKind);
  }
  if (type === 'rate_limit_event') {
    return [claudeRateLimitEvent(value, runtimeKind)];
  }
  if (type === 'user') {
    return claudeToolResultEvents(value, runtimeKind);
  }
  if (type === 'assistant') {
    const stats = claudeContextStatsFromAssistant(value, runtimeKind);
    return stats ? [stats] : [];
  }
  if (type === 'result') {
    const stats = claudeSessionStatsFromResult(value, runtimeKind);
    return stats ? [stats] : [];
  }
  return [];
}

function claudeSystemInitEvent(value: Record<string, unknown>, runtimeKind: string): Record<string, unknown> {
  const event: Record<string, unknown> = {
    eventType: 'claude.system.init',
    runtimeKind,
  };
  copyString(value, event, 'session_id', 'providerSessionId');
  copyString(value, event, 'cwd', 'cwd');
  copyString(value, event, 'model', 'model');
  copyString(value, event, 'permissionMode', 'permissionMode');
  copyString(value, event, 'claude_code_version', 'claudeCodeVersion');
  copyString(value, event, 'apiKeySource', 'apiKeySource');
  copyString(value, event, 'output_style', 'outputStyle');
  copyString(value, event, 'fast_mode_state', 'fastModeState');
  copyStringArraySummary(value, event, 'tools', 'tools');
  copyStringArraySummary(value, event, 'mcp_servers', 'mcpServers');
  copyStringArraySummary(value, event, 'slash_commands', 'slashCommands');
  copyStringArraySummary(value, event, 'agents', 'agents');
  copyStringArraySummary(value, event, 'skills', 'skills');
  copyStringArraySummary(value, event, 'plugins', 'plugins');
  if (Array.isArray(value['memory_paths'])) event['memoryPathCount'] = value['memory_paths'].length;
  return event;
}

function claudeStreamEvents(value: Record<string, unknown>, runtimeKind: string): Record<string, unknown>[] {
  const event = isRecord(value['event']) ? value['event'] : undefined;
  if (!event) return [];
  const streamType = stringField(event, 'type');
  if (!streamType) return [];
  if (streamType === 'message_start') {
    const message = isRecord(event['message']) ? event['message'] : undefined;
    const usage = isRecord(message?.['usage']) ? message['usage'] : undefined;
    const output: Record<string, unknown> = {
      eventType: 'claude.stream.message_start',
      runtimeKind,
    };
    copyString(message, output, 'id', 'messageId');
    copyString(message, output, 'model', 'model');
    copyNumber(value, output, 'ttft_ms', 'ttftMs');
    copyNumber(usage, output, 'input_tokens', 'inputTokens');
    copyNumber(usage, output, 'cache_read_input_tokens', 'cacheReadInputTokens');
    copyNumber(usage, output, 'cache_creation_input_tokens', 'cacheCreationInputTokens');
    copyNumber(usage, output, 'output_tokens', 'outputTokens');
    return [output];
  }
  if (streamType === 'content_block_start') {
    const block = isRecord(event['content_block']) ? event['content_block'] : undefined;
    const blockType = block ? stringField(block, 'type') : undefined;
    if (!blockType) return [];
    const output: Record<string, unknown> = {
      eventType: 'claude.stream.content_block_start',
      runtimeKind,
      blockType,
    };
    copyNumber(event, output, 'index', 'index');
    copyString(block, output, 'id', 'providerToolId');
    copyString(block, output, 'name', 'providerToolName');
    const caller = isRecord(block?.['caller']) ? block['caller'] : undefined;
    copyString(caller, output, 'type', 'callerType');
    return [output];
  }
  if (streamType === 'content_block_delta') {
    return claudeStreamDeltaEvents(event, runtimeKind);
  }
  if (streamType === 'content_block_stop') {
    const output: Record<string, unknown> = {
      eventType: 'claude.stream.content_block_stop',
      runtimeKind,
    };
    copyNumber(event, output, 'index', 'index');
    return [output];
  }
  if (streamType === 'message_delta') {
    const delta = isRecord(event['delta']) ? event['delta'] : undefined;
    const usage = isRecord(event['usage']) ? event['usage'] : undefined;
    const contextManagement = isRecord(delta?.['context_management']) ? delta['context_management'] : undefined;
    const appliedEdits = Array.isArray(contextManagement?.['applied_edits']) ? contextManagement['applied_edits'] : undefined;
    const output: Record<string, unknown> = {
      eventType: 'claude.stream.message_delta',
      runtimeKind,
    };
    copyString(delta, output, 'stop_reason', 'stopReason');
    copyNumber(usage, output, 'output_tokens', 'outputTokens');
    if (appliedEdits) output['appliedEditCount'] = appliedEdits.length;
    return [output];
  }
  if (streamType === 'message_stop') {
    return [{ eventType: 'claude.stream.message_stop', runtimeKind }];
  }
  if (streamType.endsWith('_hook_started') || streamType.endsWith('_hook_completed')) {
    return [sanitizeClaudeHookEvent(event, streamType, runtimeKind)];
  }
  return [];
}

function claudeStreamDeltaEvents(event: Record<string, unknown>, runtimeKind: string): Record<string, unknown>[] {
  const delta = isRecord(event['delta']) ? event['delta'] : undefined;
  const deltaType = delta ? stringField(delta, 'type') : undefined;
  if (!delta || !deltaType) return [];
  if (!deltaType.includes('thinking')) return [];
  const output: Record<string, unknown> = {
    deltaType,
    eventType: 'claude.thinking.delta',
    runtimeKind,
  };
  copyNumber(event, output, 'index', 'index');
  const text = stringField(delta, 'thinking') ?? stringField(delta, 'text');
  if (text) output['text'] = truncateForActivity(text);
  if (stringField(delta, 'signature')) output['signaturePresent'] = true;
  return [output];
}

function sanitizeClaudeHookEvent(event: Record<string, unknown>, streamType: string, runtimeKind: string): Record<string, unknown> {
  const output: Record<string, unknown> = {
    eventType: `claude.hook.${streamType}`,
    runtimeKind,
  };
  copyString(event, output, 'hook_event_name', 'hookEventName');
  copyString(event, output, 'tool_name', 'toolName');
  copyString(event, output, 'session_id', 'providerSessionId');
  copyString(event, output, 'permission_mode', 'permissionMode');
  return output;
}

function claudeRateLimitEvent(value: Record<string, unknown>, runtimeKind: string): Record<string, unknown> {
  const info = isRecord(value['rate_limit_info']) ? value['rate_limit_info'] : undefined;
  const event: Record<string, unknown> = {
    eventType: 'claude.rate_limit',
    runtimeKind,
  };
  copyString(info, event, 'status', 'status');
  copyString(info, event, 'rateLimitType', 'rateLimitType');
  copyString(info, event, 'resetsAt', 'resetsAt');
  copyNumber(info, event, 'utilization', 'utilization');
  copyBoolean(info, event, 'isUsingOverage', 'isUsingOverage');
  return event;
}

function claudeToolResultEvents(value: Record<string, unknown>, runtimeKind: string): Record<string, unknown>[] {
  const message = value['message'];
  if (!isRecord(message) || !Array.isArray(message['content'])) return [];
  return message['content']
    .map((item) => claudeToolResultEvent(item, runtimeKind))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function claudeToolResultEvent(value: unknown, runtimeKind: string): Record<string, unknown> | undefined {
  if (!isRecord(value) || stringField(value, 'type') !== 'tool_result') return undefined;
  const toolUseResult = isRecord(value['tool_use_result']) ? value['tool_use_result'] : undefined;
  if (!toolUseResult && value['is_error'] !== true) return undefined;
  const event: Record<string, unknown> = {
    eventType: 'claude.tool_result',
    isError: value['is_error'] === true,
    runtimeKind,
  };
  copyString(value, event, 'tool_use_id', 'providerToolId');
  copyBoolean(toolUseResult, event, 'interrupted', 'interrupted');
  copyBoolean(toolUseResult, event, 'isImage', 'isImage');
  copyBoolean(toolUseResult, event, 'noOutputExpected', 'noOutputExpected');
  copyActivityPreview(toolUseResult, event, 'stdout', 'stdout');
  copyActivityPreview(toolUseResult, event, 'stderr', 'stderr');
  return event;
}

function claudeContextStatsFromAssistant(value: Record<string, unknown>, runtimeKind: string): Record<string, unknown> | undefined {
  const message = isRecord(value['message']) ? value['message'] : undefined;
  const usage = isRecord(message?.['usage']) ? message['usage'] : undefined;
  if (!usage) return undefined;
  const stats: Record<string, unknown> = {
    eventType: 'claude.context.stats',
    runtimeKind,
  };
  copyNumber(usage, stats, 'input_tokens', 'inputTokens');
  copyNumber(usage, stats, 'cache_read_input_tokens', 'cacheReadInputTokens');
  copyNumber(usage, stats, 'cache_creation_input_tokens', 'cacheCreationInputTokens');
  const currentContextTokens = inputSideTokens(stats);
  return currentContextTokens === undefined ? undefined : {
    ...stats,
    currentContextTokens,
  };
}

function claudeSessionStatsFromResult(value: Record<string, unknown>, runtimeKind: string): Record<string, unknown> | undefined {
  const usage = isRecord(value['usage']) ? value['usage'] : undefined;
  const stats: Record<string, unknown> = {
    eventType: 'claude.session.stats',
    runtimeKind,
  };
  const modelStats = claudeModelStats(value);
  const model = stringField(value, 'model') ?? (modelStats ? stringField(modelStats, 'model') : undefined);
  if (model) stats['model'] = model;
  copyNumber(usage, stats, 'input_tokens', 'inputTokens');
  copyNumber(usage, stats, 'cache_read_input_tokens', 'cacheReadInputTokens');
  copyNumber(usage, stats, 'cache_creation_input_tokens', 'cacheCreationInputTokens');
  copyNumber(usage, stats, 'output_tokens', 'outputTokens');
  copyNumber(value, stats, 'total_cost_usd', 'totalCostUsd');
  copyNumber(value, stats, 'duration_ms', 'durationMs');
  copyNumber(value, stats, 'duration_api_ms', 'durationApiMs');
  copyNumber(value, stats, 'ttft_ms', 'ttftMs');
  copyNumber(value, stats, 'num_turns', 'numTurns');
  copyString(value, stats, 'terminal_reason', 'terminalReason');
  copyString(value, stats, 'stop_reason', 'stopReason');
  copyString(value, stats, 'fast_mode_state', 'fastModeState');
  copyString(usage, stats, 'service_tier', 'serviceTier');
  const serverToolUse = isRecord(usage?.['server_tool_use']) ? usage['server_tool_use'] : undefined;
  copyNumber(serverToolUse, stats, 'web_search_requests', 'webSearchRequests');
  copyNumber(serverToolUse, stats, 'web_fetch_requests', 'webFetchRequests');
  copyNumber(modelStats, stats, 'contextWindow', 'contextWindow');
  copyNumber(modelStats, stats, 'maxOutputTokens', 'maxOutputTokens');
  copyNumber(modelStats, stats, 'costUSD', 'modelCostUsd');
  const permissionDenials = Array.isArray(value['permission_denials']) ? value['permission_denials'] : undefined;
  if (permissionDenials) stats['permissionDenialCount'] = permissionDenials.length;
  return Object.keys(stats).length > 2 ? stats : undefined;
}

function claudeModelStats(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const modelUsage = value['modelUsage'];
  if (!isRecord(modelUsage)) return undefined;
  const [model, stats] = Object.entries(modelUsage)[0] ?? [];
  if (!model || !isRecord(stats)) return undefined;
  return { ...stats, model };
}

function copyStringArraySummary(source: Record<string, unknown>, target: Record<string, unknown>, from: string, to: string): void {
  const value = source[from];
  if (!Array.isArray(value)) return;
  const names = value.filter(isNonEmptyString);
  target[`${to}Count`] = value.length;
  if (names.length > 0) target[to] = names.slice(0, 50);
}

function inputSideTokens(stats: Record<string, unknown>): number | undefined {
  const parts = [
    stats['inputTokens'],
    stats['cacheReadInputTokens'],
    stats['cacheCreationInputTokens'],
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (parts.length === 0) return undefined;
  return parts.reduce((sum, value) => sum + value, 0);
}

function providerFailureFromJsonEvent(value: unknown, eventType: string): boolean {
  const normalizedType = eventType.toLowerCase();
  if (normalizedType.includes('fail') || normalizedType.includes('error')) return true;
  if (!isRecord(value)) return false;
  if (value['is_error'] === true) return true;
  if (isNonEmptyString(value['error']) || isRecord(value['error'])) return true;

  const message = value['message'];
  if (isRecord(message) && Array.isArray(message['content'])) {
    return message['content'].some((item) => isRecord(item) && stringField(item, 'type') === 'tool_result' && item['is_error'] === true);
  }
  return false;
}

function errorMessageFromJsonEvent(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return stringField(value, 'result') ?? stringField(value, 'error');
}

function eventTypeFromJson(value: unknown): string {
  if (!isRecord(value)) return 'runtime.event';
  const type =
    stringField(value, 'type') ??
    stringField(value, 'event') ??
    stringField(value, 'kind') ??
    stringField(value, 'name') ??
    'runtime.event';
  const subtype = stringField(value, 'subtype');
  return subtype ? `${type}.${subtype}` : type;
}

function textFromJsonEvent(value: unknown): string | undefined {
  const visited = new Set<unknown>();
  return textFromJsonValue(value, visited);
}

function textFromClaudeJsonEvent(value: unknown): string | undefined {
  if (!isRecord(value) || stringField(value, 'type') !== 'assistant') return undefined;
  const message = value['message'];
  if (!isRecord(message)) return textFromJsonEvent(value);
  const content = message['content'];
  if (!Array.isArray(content)) return textFromJsonEvent(message);
  const parts = content
    .map((item) => {
      if (!isRecord(item)) return undefined;
      if (stringField(item, 'type') !== 'text') return undefined;
      return stringField(item, 'text');
    })
    .filter(isNonEmptyString);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function providerToolCallsFromClaudeEvent(value: unknown, subagentLinkage: Record<string, unknown> = {}): Record<string, unknown>[] {
  if (!isRecord(value) || stringField(value, 'type') !== 'assistant') return [];
  const message = value['message'];
  if (!isRecord(message) || !Array.isArray(message['content'])) return [];
  return message['content']
    .map((item) => providerToolCallFromClaudeContent(item, subagentLinkage))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function providerToolCallFromClaudeContent(
  value: unknown,
  subagentLinkage: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  if (!isRecord(value) || stringField(value, 'type') !== 'tool_use') return undefined;
  const name = stringField(value, 'name') ?? 'tool';
  const input = isRecord(value['input']) ? value['input'] : {};
  const summary = summarizeClaudeToolInput(name, input);
  if (isRedundantAnimaBashTool(name, summary)) return undefined;
  return {
    ...subagentLinkage,
    ...(stringField(value, 'id') ? { providerToolId: stringField(value, 'id') } : {}),
    provider: 'claude-code',
    providerToolName: name,
    ...(summary.command ? { command: summary.command } : {}),
    ...(summary.target ? { target: summary.target } : {}),
    tool: `claude.${name}`,
  };
}

function summarizeClaudeToolInput(
  name: string,
  input: Record<string, unknown>,
): { command?: string; target?: string } {
  if (name === 'Bash') {
    const description = stringField(input, 'description');
    const command = stringField(input, 'command');
    return {
      ...(command ? { command: singleLineForActivity(command) } : {}),
      ...(description
        ? { target: singleLine(description) }
        : command
          ? { target: singleLineForActivity(command) }
          : {}),
    };
  }
  const target =
    stringField(input, 'file_path') ??
    stringField(input, 'path') ??
    stringField(input, 'pattern') ??
    stringField(input, 'query') ??
    stringField(input, 'url');
  return {
    ...(target ? { target: singleLine(target) } : {}),
  };
}

function isRedundantAnimaBashTool(name: string, summary: { command?: string; target?: string }): boolean {
  if (name !== 'Bash') return false;
  return isFirstClassAnimaCliCommand(summary.command);
}

async function recordClaudeToolStarted(
  effects: AgentRuntimeEffects,
  tool: Record<string, unknown>,
  state: ClaudeJsonlMapperState,
): Promise<void> {
  const providerToolId = stringField(tool, 'providerToolId');
  if (isClaudeAgentSpawnTool(tool)) {
    if (providerToolId) state.pendingAgentToolIds.add(providerToolId);
    await effects.recordToolStarted(tool);
    return;
  }
  if (hasSubagentLinkage(tool)) {
    if (providerToolId) state.emittedSubagentToolIds.add(providerToolId);
    await effects.recordToolStarted(tool);
    return;
  }
  if (providerToolId && state.pendingAgentToolIds.size > 0) {
    state.pendingUnlinkedToolsById.set(providerToolId, tool);
    return;
  }
  await effects.recordToolStarted(tool);
}

function isClaudeAgentSpawnTool(tool: Record<string, unknown>): boolean {
  const name = stringField(tool, 'providerToolName')?.toLowerCase();
  return name === 'agent' || name === 'task';
}

function hasSubagentLinkage(payload: Record<string, unknown>): boolean {
  return Boolean(stringField(payload, 'parentToolCallId') && stringField(payload, 'subRunId'));
}

function shouldBufferUnlinkedClaudeText(payload: Record<string, unknown>, state: ClaudeJsonlMapperState): boolean {
  return state.pendingAgentToolIds.size > 0 && !hasSubagentLinkage(payload);
}

async function flushPendingUnlinkedClaudeEvents(
  effects: AgentRuntimeEffects,
  runtimeKind: string,
  state: ClaudeJsonlMapperState,
): Promise<void> {
  const transcriptScan = await ingestPendingClaudeSubagentResultsFromTranscript(effects, runtimeKind, state);
  for (const result of [...state.pendingSubagentResultsByAgentId.values()]) {
    if (await ingestClaudeSubagentLog(effects, runtimeKind, result, state)) {
      state.pendingSubagentResultsByAgentId.delete(result.agentId);
    }
  }
  if (state.pendingAgentToolIds.size > 0 || state.pendingSubagentResultsByAgentId.size > 0) {
    await effects.recordEvent({
      bufferedToolCount: state.pendingUnlinkedToolsById.size,
      eventType: 'claude.subagent.flush.unresolved',
      hasContext: Boolean(state.context.cwd && state.context.sessionId),
      pendingAgentToolCount: state.pendingAgentToolIds.size,
      pendingResultCount: state.pendingSubagentResultsByAgentId.size,
      runtimeKind,
      transcriptScan,
    });
  }
  for (const tool of state.pendingUnlinkedToolsById.values()) {
    await effects.recordToolStarted(tool);
  }
  state.pendingUnlinkedToolsById.clear();
  for (const item of state.pendingUnlinkedTexts) {
    await effects.recordAgentText(item.text, item.payload);
  }
  state.pendingUnlinkedTexts = [];
}

async function ingestPendingClaudeSubagentResultsFromTranscript(
  effects: AgentRuntimeEffects,
  runtimeKind: string,
  state: ClaudeJsonlMapperState,
): Promise<Record<string, unknown>> {
  const cwd = state.context.cwd;
  const sessionId = state.context.sessionId;
  if (!cwd || !sessionId || state.pendingAgentToolIds.size === 0) return { skipped: true };
  let contents: string;
  try {
    contents = await readFile(claudeTranscriptPath(cwd, sessionId), 'utf8');
  } catch {
    return { read: false };
  }

  let resultCount = 0;
  let ingestedCount = 0;
  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseClaudeJsonlLine(line);
    if (!parsed) continue;
    for (const result of claudeSubagentResultsFromClaudeJson(parsed)) {
      if (!state.pendingAgentToolIds.has(result.parentToolCallId)) continue;
      resultCount += 1;
      state.pendingAgentToolIds.delete(result.parentToolCallId);
      state.pendingSubagentResultsByAgentId.set(result.agentId, result);
      if (await ingestClaudeSubagentLog(effects, runtimeKind, result, state)) {
        state.pendingSubagentResultsByAgentId.delete(result.agentId);
        ingestedCount += 1;
      }
    }
  }
  return { ingestedCount, read: true, resultCount };
}

async function recordClaudeSubagentResults(
  effects: AgentRuntimeEffects,
  runtimeKind: string,
  value: unknown,
  state: ClaudeJsonlMapperState,
): Promise<void> {
  for (const result of claudeSubagentResultsFromClaudeJson(value)) {
    state.pendingAgentToolIds.delete(result.parentToolCallId);
    state.pendingSubagentResultsByAgentId.set(result.agentId, result);
    if (await ingestClaudeSubagentLog(effects, runtimeKind, result, state)) {
      state.pendingSubagentResultsByAgentId.delete(result.agentId);
    } else {
      await effects.recordEvent({
        agentId: result.agentId,
        eventType: 'claude.subagent.ingest.pending',
        hasContext: Boolean(state.context.cwd && state.context.sessionId),
        parentToolCallId: result.parentToolCallId,
        runtimeKind,
      });
    }
  }
}

interface ClaudeSubagentResult {
  agentId: string;
  agentType?: string;
  parentToolCallId: string;
}

function claudeSubagentResultsFromClaudeJson(value: unknown): ClaudeSubagentResult[] {
  if (!isRecord(value) || stringField(value, 'type') !== 'user') return [];
  const message = value['message'];
  if (!isRecord(message) || !Array.isArray(message['content'])) return [];
  const topLevelResult = isRecord(value['toolUseResult']) ? value['toolUseResult'] : undefined;
  const results: ClaudeSubagentResult[] = [];
  for (const item of message['content']) {
    if (!isRecord(item) || stringField(item, 'type') !== 'tool_result') continue;
    const itemResult = isRecord(item['tool_use_result']) ? item['tool_use_result'] : undefined;
    const parentToolCallId = stringField(item, 'tool_use_id');
    const agentId =
      stringField(itemResult, 'agentId') ??
      stringField(itemResult, 'agent_id') ??
      stringField(topLevelResult, 'agentId') ??
      stringField(topLevelResult, 'agent_id');
    if (!parentToolCallId || !agentId) continue;
    const agentType =
      stringField(itemResult, 'agentType') ??
      stringField(itemResult, 'agent_type') ??
      stringField(topLevelResult, 'agentType') ??
      stringField(topLevelResult, 'agent_type');
    results.push({
      agentId,
      ...(agentType ? { agentType } : {}),
      parentToolCallId,
    });
  }
  return results;
}

async function ingestClaudeSubagentLog(
  effects: AgentRuntimeEffects,
  runtimeKind: string,
  result: ClaudeSubagentResult,
  state: ClaudeJsonlMapperState,
): Promise<boolean> {
  const cwd = state.context.cwd;
  const sessionId = state.context.sessionId;
  if (!cwd || !sessionId) return false;
  const logKey = `${cwd}\u0000${sessionId}\u0000${result.agentId}`;
  if (state.ingestedSubagentLogs.has(logKey)) return true;

  const metadata = await readClaudeSubagentMetadata(cwd, sessionId, result.agentId) ?? {
    ...(result.agentType ? { agentType: result.agentType } : {}),
    toolUseId: result.parentToolCallId,
  };
  state.subagentMetadataByKey.set(logKey, metadata);

  let contents: string;
  try {
    contents = await readFile(join(claudeSubagentsDir(cwd, sessionId), `agent-${result.agentId}.jsonl`), 'utf8');
  } catch {
    return false;
  }
  let emitted = false;

  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseClaudeJsonlLine(line);
    if (!parsed) continue;
    const linkage = claudeSubagentLinkage(parsed, result.agentId, metadata, result.parentToolCallId);
    if (!hasSubagentLinkage(linkage)) continue;

    for (const tool of providerToolCallsFromClaudeEvent(parsed, linkage)) {
      const providerToolId = stringField(tool, 'providerToolId');
      if (providerToolId && state.emittedSubagentToolIds.has(providerToolId)) continue;
      if (providerToolId) {
        state.emittedSubagentToolIds.add(providerToolId);
        state.providerToolsById.set(providerToolId, tool);
        state.pendingUnlinkedToolsById.delete(providerToolId);
      }
      emitted = true;
      await effects.recordToolStarted(tool);
    }

    const failures = providerToolFailuresFromClaudeEvent(parsed, runtimeKind, state.providerToolsById, eventTypeFromJson(parsed), linkage);
    for (const failure of failures) {
      await effects.recordToolFailed(failure);
    }

    const text = textFromClaudeJsonEvent(parsed);
    if (text) {
      const textKey = claudeSubagentTextKey(result.agentId, parsed, text);
      if (state.emittedSubagentTextKeys.has(textKey)) continue;
      state.emittedSubagentTextKeys.add(textKey);
      removePendingUnlinkedClaudeText(text, state);
      emitted = true;
      await effects.recordAgentText(text, {
        eventType: eventTypeFromJson(parsed),
        ...linkage,
      });
    }
  }
  if (!emitted) {
    await effects.recordEvent({
      agentId: result.agentId,
      eventType: 'claude.subagent.ingest.empty',
      hasContents: Boolean(contents.trim()),
      parentToolCallId: result.parentToolCallId,
      runtimeKind,
    });
  }
  if (emitted) state.ingestedSubagentLogs.add(logKey);
  return emitted;
}

function parseClaudeJsonlLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function claudeSubagentTextKey(agentId: string, value: Record<string, unknown>, text: string): string {
  return [
    agentId,
    stringField(value, 'uuid') ?? stringField(value, 'timestamp') ?? text,
  ].join('\u0000');
}

function removePendingUnlinkedClaudeText(text: string, state: ClaudeJsonlMapperState): void {
  const index = state.pendingUnlinkedTexts.findIndex((item) => item.text === text);
  if (index !== -1) state.pendingUnlinkedTexts.splice(index, 1);
}

interface ClaudeJsonlMapperContext {
  cwd?: string;
  sessionId?: string;
}

interface PendingClaudeAgentText {
  payload: Record<string, unknown>;
  text: string;
}

interface ClaudeJsonlMapperState {
  context: ClaudeJsonlMapperContext;
  emittedSubagentTextKeys: Set<string>;
  emittedSubagentToolIds: Set<string>;
  ingestedSubagentLogs: Set<string>;
  pendingAgentToolIds: Set<string>;
  pendingSubagentResultsByAgentId: Map<string, ClaudeSubagentResult>;
  pendingUnlinkedTexts: PendingClaudeAgentText[];
  pendingUnlinkedToolsById: Map<string, Record<string, unknown>>;
  providerToolsById: Map<string, Record<string, unknown>>;
  subagentIdByToolId: Map<string, string>;
  subagentMetadataByKey: Map<string, Record<string, unknown> | undefined>;
}

function updateClaudeJsonlContext(value: unknown, context: ClaudeJsonlMapperContext): void {
  if (!isRecord(value)) return;
  const cwd = stringField(value, 'cwd');
  if (cwd) context.cwd = cwd;
  const sessionId = stringField(value, 'sessionId') ?? stringField(value, 'session_id');
  if (sessionId) context.sessionId = sessionId;
}

async function subagentActivityLinkageFromClaudeJson(
  value: unknown,
  state: ClaudeJsonlMapperState,
): Promise<Record<string, unknown>> {
  if (!isRecord(value)) return {};
  const toolUseResult = isRecord(value['toolUseResult']) ? value['toolUseResult'] : undefined;
  const agentId =
    stringField(value, 'agentId') ??
    stringField(value, 'agent_id') ??
    stringField(toolUseResult, 'agentId') ??
    stringField(toolUseResult, 'agent_id') ??
    await claudeSubagentIdFromToolIds(value, state);
  const metadata = await claudeSubagentMetadata(value, agentId, state);
  return claudeSubagentLinkage(value, agentId, metadata);
}

function claudeSubagentLinkage(
  value: Record<string, unknown>,
  agentId: string | undefined,
  metadata: Record<string, unknown> | undefined,
  parentToolCallIdOverride?: string,
): Record<string, unknown> {
  const parentToolCallId =
    parentToolCallIdOverride ??
    stringField(value, 'parentToolCallId') ??
    stringField(value, 'parent_tool_call_id') ??
    stringField(value, 'parentToolUseId') ??
    stringField(value, 'parent_tool_use_id') ??
    stringField(metadata, 'toolUseId') ??
    stringField(metadata, 'tool_use_id');
  const subRunId =
    stringField(value, 'subRunId') ??
    stringField(value, 'sub_run_id') ??
    stringField(value, 'subagentRunId') ??
    stringField(value, 'subagent_run_id') ??
    agentId;
  if (!parentToolCallId || !subRunId) return {};

  const output: Record<string, unknown> = {
    depth: 1,
    parentToolCallId,
    subRunId,
  };
  const role =
    stringField(value, 'role') ??
    stringField(value, 'agentRole') ??
    stringField(value, 'agent_role') ??
    stringField(value, 'attributionAgent') ??
    stringField(value, 'subagentType') ??
    stringField(value, 'subagent_type') ??
    stringField(metadata, 'agentType') ??
    stringField(metadata, 'agent_type');
  if (role) output['role'] = role;
  const name =
    stringField(value, 'name') ??
    stringField(value, 'agentName') ??
    stringField(value, 'agent_name') ??
    stringField(metadata, 'description') ??
    stringField(value, 'slug');
  if (name) output['name'] = name;
  const depth = value['depth'];
  if (typeof depth === 'number' && Number.isFinite(depth)) output['depth'] = depth;
  return output;
}

async function claudeSubagentMetadata(
  value: Record<string, unknown>,
  agentId: string | undefined,
  state: ClaudeJsonlMapperState,
): Promise<Record<string, unknown> | undefined> {
  if (!agentId) return undefined;
  const cwd = stringField(value, 'cwd') ?? state.context.cwd;
  const sessionId = stringField(value, 'sessionId') ?? stringField(value, 'session_id') ?? state.context.sessionId;
  if (!cwd || !sessionId) return undefined;
  const cacheKey = `${cwd}\u0000${sessionId}\u0000${agentId}`;
  if (state.subagentMetadataByKey.has(cacheKey)) return state.subagentMetadataByKey.get(cacheKey);
  const metadata = await readClaudeSubagentMetadata(cwd, sessionId, agentId);
  state.subagentMetadataByKey.set(cacheKey, metadata);
  return metadata;
}

async function claudeSubagentIdFromToolIds(
  value: Record<string, unknown>,
  state: ClaudeJsonlMapperState,
): Promise<string | undefined> {
  const cwd = stringField(value, 'cwd') ?? state.context.cwd;
  const sessionId = stringField(value, 'sessionId') ?? stringField(value, 'session_id') ?? state.context.sessionId;
  if (!cwd || !sessionId) return undefined;
  for (const toolId of claudeToolIdsFromJson(value)) {
    const cacheKey = `${cwd}\u0000${sessionId}\u0000${toolId}`;
    const cached = state.subagentIdByToolId.get(cacheKey);
    if (cached) return cached;
    const agentId = await readClaudeSubagentIdForToolId(cwd, sessionId, toolId);
    if (agentId) {
      state.subagentIdByToolId.set(cacheKey, agentId);
      return agentId;
    }
  }
  return undefined;
}

function claudeToolIdsFromJson(value: Record<string, unknown>): string[] {
  const message = value['message'];
  if (!isRecord(message) || !Array.isArray(message['content'])) return [];
  const ids: string[] = [];
  for (const item of message['content']) {
    if (!isRecord(item)) continue;
    const id = stringField(item, 'id') ?? stringField(item, 'tool_use_id');
    if (id) ids.push(id);
  }
  return ids;
}

async function readClaudeSubagentMetadata(
  cwd: string,
  sessionId: string,
  agentId: string,
): Promise<Record<string, unknown> | undefined> {
  const path = join(claudeSubagentsDir(cwd, sessionId), `agent-${agentId}.meta.json`);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readClaudeSubagentIdForToolId(
  cwd: string,
  sessionId: string,
  toolId: string,
): Promise<string | undefined> {
  try {
    const dir = claudeSubagentsDir(cwd, sessionId);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = /^agent-(.+)\.jsonl$/.exec(entry.name);
      if (!match) continue;
      const path = join(dir, entry.name);
      const contents = await readFile(path, 'utf8');
      if (contents.includes(toolId)) return match[1];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function claudeSubagentsDir(cwd: string, sessionId: string): string {
  return join(claudeProjectsRoot(), claudeProjectNameForCwd(cwd), sessionId, 'subagents');
}

function claudeTranscriptPath(cwd: string, sessionId: string): string {
  return join(claudeProjectsRoot(), claudeProjectNameForCwd(cwd), `${sessionId}.jsonl`);
}

function claudeProjectsRoot(): string {
  return process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
}

function claudeProjectNameForCwd(cwd: string): string {
  return (cwd.replace(/\/+$/, '') || '/').replaceAll('/', '-');
}

function textFromJsonValue(value: unknown, visited: Set<unknown>): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || visited.has(value)) return undefined;
  visited.add(value);

  if (Array.isArray(value)) {
    const parts = value.map((item) => textFromJsonValue(item, visited)).filter(isNonEmptyString);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  if (!isRecord(value)) return undefined;
  for (const key of ['text', 'content', 'message', 'delta', 'summary', 'output']) {
    const text = textFromJsonValue(value[key], visited);
    if (isNonEmptyString(text)) return text;
  }
  for (const key of ['item', 'data', 'payload', 'response']) {
    const text = textFromJsonValue(value[key], visited);
    if (isNonEmptyString(text)) return text;
  }
  return undefined;
}

function compactForActivity(value: unknown): string {
  return truncateForActivity(JSON.stringify(value));
}
