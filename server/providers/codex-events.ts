import { asRecord, singleLine, singleLineForActivity, stringField } from '../json.js';
import { exposedReasoningEvent } from './reasoning-events.js';
import { isFirstClassAnimaCliCommand, truncateForActivity } from '../activities/format.js';

export interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export function recordParam(params: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return asRecord(params?.[key]);
}

export function stringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function providerToolCallsFromAppServerItem(item: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!item) return [];
  const id = stringField(item, 'id');
  const itemType = stringField(item, 'type');
  const subagentLinkage = codexSubagentLinkageFromRecord(item);
  if (itemType === 'commandExecution') {
    const command = stripShellWrapper(stringField(item, 'command') ?? '');
    if (!command) return [];
    if (isFirstClassAnimaCliCommand(command)) return [];
    return [{
      ...subagentLinkage,
      ...(id ? { providerToolId: id } : {}),
      provider: 'codex-cli',
      providerToolName: 'shell',
      command: singleLineForActivity(command),
      target: singleLineForActivity(command),
      tool: 'codex.shell',
    }];
  }
  if (itemType === 'fileChange') {
    return [{
      ...subagentLinkage,
      ...(id ? { providerToolId: id } : {}),
      provider: 'codex-cli',
      providerToolName: 'Edit',
      target: fileChangeTarget(item),
      tool: 'codex.fileChange',
    }];
  }
  if (itemType === 'mcpToolCall') {
    const server = stringField(item, 'server');
    const tool = stringField(item, 'tool');
    const name = [server, tool].filter(Boolean).join('.');
    if (!name) return [];
    return [{
      ...subagentLinkage,
      ...(id ? { providerToolId: id } : {}),
      provider: 'codex-cli',
      providerToolName: tool ?? name,
      target: name,
      tool: `codex.mcp.${name}`,
    }];
  }
  if (itemType === 'webSearch') {
    const details = webSearchDetails(item);
    return [{
      ...subagentLinkage,
      ...(id ? { providerToolId: id } : {}),
      provider: 'codex-cli',
      providerToolName: 'webSearch',
      ...details,
      tool: 'codex.webSearch',
    }];
  }
  return [];
}

export function runtimeEventFromAppServerItem(
  method: string | undefined,
  item: Record<string, unknown> | undefined,
  runtimeKind: string,
): Record<string, unknown> | undefined {
  const itemType = stringField(item ?? {}, 'type');
  if (itemType === 'reasoning') {
    return {
      eventType: method === 'item/started' ? 'codex.reasoning.started' : 'codex.reasoning.completed',
      runtimeKind,
      ...codexItemIdentity(item),
      ...codexSubagentLinkageFromRecord(item),
      ...codexReasoningItemPayload(item),
    };
  }
  if (itemType !== 'contextCompaction') return undefined;
  if (method === 'item/started') {
    return { eventType: 'codex.compact.started', runtimeKind, ...codexSubagentLinkageFromRecord(item) };
  }
  if (method !== 'item/completed') return undefined;
  const error = providerToolErrorFromAppServerItem(item ?? {});
  if (error) {
    return {
      error,
      eventType: 'codex.compact.failed',
      runtimeKind,
      ...codexSubagentLinkageFromRecord(item),
    };
  }
  return { eventType: 'codex.compact.completed', runtimeKind, ...codexSubagentLinkageFromRecord(item) };
}

export function codexRuntimeEventFromNotification(
  message: JsonRpcMessage,
  runtimeKind: string,
): Record<string, unknown> | undefined {
  const params = message.params;
  if (!params) return undefined;
  switch (message.method) {
    case 'item/reasoning/summaryPartAdded':
      return {
        eventType: 'codex.reasoning.summary_part_added',
        runtimeKind,
        ...codexNotificationIdentity(params),
        ...numberPayload(params, 'summaryIndex'),
      };
    case 'item/reasoning/summaryTextDelta':
      return {
        eventType: 'codex.reasoning.summary_delta',
        runtimeKind,
        ...codexNotificationIdentity(params),
        ...numberPayload(params, 'summaryIndex'),
        ...textPayload(params, 'delta'),
      };
    case 'item/reasoning/textDelta':
      return {
        eventType: 'codex.reasoning.text_delta',
        runtimeKind,
        ...codexNotificationIdentity(params),
        ...numberPayload(params, 'contentIndex'),
        ...textPayload(params, 'delta'),
      };
    case 'turn/plan/updated':
      return {
        eventType: 'codex.plan.updated',
        runtimeKind,
        ...codexNotificationIdentity(params),
        ...(stringField(params, 'explanation') ? { explanation: truncateForActivity(stringField(params, 'explanation') ?? '') } : {}),
        ...(Array.isArray(params['plan']) ? { plan: sanitizePlan(params['plan']) } : {}),
      };
    case 'turn/diff/updated': {
      const diff = stringField(params, 'diff');
      return {
        eventType: 'codex.diff.updated',
        runtimeKind,
        ...codexNotificationIdentity(params),
        ...(diff ? { diff: truncateForActivity(diff), diffLength: diff.length } : {}),
      };
    }
    case 'item/commandExecution/outputDelta':
    case 'command/exec/outputDelta':
    case 'process/outputDelta':
      return {
        eventType: `codex.${message.method.replaceAll('/', '.')}`,
        runtimeKind,
        ...codexNotificationIdentity(params),
        ...textPayload(params, 'delta'),
        ...textPayload(params, 'output'),
        ...textPayload(params, 'stream'),
      };
    case 'item/fileChange/patchUpdated':
    case 'item/fileChange/outputDelta':
      return {
        eventType: `codex.${message.method.replaceAll('/', '.')}`,
        runtimeKind,
        ...codexNotificationIdentity(params),
        ...textPayload(params, 'delta'),
        ...textPayload(params, 'patch'),
      };
    case 'item/mcpToolCall/progress':
      return {
        eventType: 'codex.mcp.progress',
        runtimeKind,
        ...codexNotificationIdentity(params),
        ...textPayload(params, 'message'),
        ...numberPayload(params, 'progress'),
        ...numberPayload(params, 'total'),
      };
    case 'rawResponseItem/completed':
      return {
        eventType: 'codex.raw_response_item.completed',
        runtimeKind,
        ...codexNotificationIdentity(params),
        ...sanitizeRawResponseItem(recordParam(params, 'item')),
      };
    case 'account/rateLimits/updated':
      return {
        eventType: 'codex.rate_limits.updated',
        runtimeKind,
        ...sanitizeRateLimits(recordParam(params, 'rateLimits')),
      };
    case 'model/rerouted':
      return {
        eventType: 'codex.model.rerouted',
        runtimeKind,
        ...codexNotificationIdentity(params),
        ...stringPayload(params, 'fromModel'),
        ...stringPayload(params, 'toModel'),
        ...stringPayload(params, 'reason'),
      };
    case 'model/verification':
      return {
        eventType: 'codex.model.verification',
        runtimeKind,
        ...codexNotificationIdentity(params),
        ...(Array.isArray(params['verifications']) ? { verifications: sanitizeJson(params['verifications']) } : {}),
      };
    case 'warning':
    case 'configWarning':
    case 'guardianWarning':
    case 'deprecationNotice':
      return {
        eventType: `codex.${message.method}`,
        runtimeKind,
        ...codexNotificationIdentity(params),
        ...textPayload(params, 'message'),
        ...textPayload(params, 'summary'),
        ...textPayload(params, 'details'),
      };
    default:
      return undefined;
  }
}

export function codexReasoningEventFromNotification(
  message: JsonRpcMessage,
  runtimeKind: string,
): Record<string, unknown> | undefined {
  const params = message.params;
  if (!params) return undefined;
  if (message.method === 'item/reasoning/summaryTextDelta') {
    return exposedReasoningEvent({
      identity: codexNotificationIdentity(params),
      provider: 'codex',
      runtimeKind,
      sourceEventType: 'codex.reasoning.summary_delta',
      text: stringField(params, 'delta'),
      textKind: 'summary',
    });
  }
  if (message.method === 'item/reasoning/textDelta') {
    return exposedReasoningEvent({
      identity: codexNotificationIdentity(params),
      provider: 'codex',
      runtimeKind,
      sourceEventType: 'codex.reasoning.text_delta',
      text: stringField(params, 'delta'),
      textKind: 'raw',
    });
  }
  return undefined;
}

export function codexContextStatsFromTokenUsage(
  tokenUsage: Record<string, unknown> | undefined,
  runtimeKind: string,
): Record<string, unknown> | undefined {
  if (!tokenUsage) return undefined;
  const last = asRecord(tokenUsage['last']);
  const total = asRecord(tokenUsage['total']);
  const stats: Record<string, unknown> = {
    eventType: 'codex.context.stats',
    runtimeKind,
  };
  copyNumberAliases([last], stats, ['inputTokens', 'input_tokens'], 'inputTokens');
  copyNumberAliases([last], stats, ['cachedInputTokens', 'cached_input_tokens'], 'cacheReadInputTokens');
  copyNumberAliases([last], stats, ['outputTokens', 'output_tokens'], 'outputTokens');
  copyNumberAliases([last], stats, ['reasoningOutputTokens', 'reasoning_output_tokens'], 'reasoningOutputTokens');
  copyNumberAliases([last], stats, ['totalTokens', 'total_tokens'], 'currentContextTokens');
  copyNumberAliases([tokenUsage], stats, ['modelContextWindow', 'model_context_window'], 'contextWindow');
  copyNumberAliases([total], stats, ['totalTokens', 'total_tokens'], 'sessionTotalTokens');
  return Object.keys(stats).length > 2 ? stats : undefined;
}

export function codexSessionStatsFromTurn(turn: Record<string, unknown> | undefined, runtimeKind: string): Record<string, unknown> | undefined {
  if (!turn) return undefined;
  const usage = asRecord(turn['usage']);
  const stats: Record<string, unknown> = {
    eventType: 'codex.session.stats',
    runtimeKind,
  };
  copyStringAliases([turn, usage], stats, ['model', 'modelId'], 'model');
  copyStringAliases([turn], stats, ['terminalReason', 'reason', 'status'], 'terminalReason');
  copyNumberAliases([usage, turn], stats, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'], 'inputTokens');
  copyNumberAliases([usage, turn], stats, ['cachedInputTokens', 'cacheReadInputTokens', 'cached_input_tokens'], 'cacheReadInputTokens');
  copyNumberAliases([usage, turn], stats, ['cacheCreationInputTokens', 'cache_creation_input_tokens'], 'cacheCreationInputTokens');
  copyNumberAliases([usage, turn], stats, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'], 'outputTokens');
  copyNumberAliases([usage, turn], stats, ['totalTokens', 'total_tokens'], 'totalTokens');
  copyNumberAliases([usage, turn], stats, ['contextWindow', 'context_window'], 'contextWindow');
  copyNumberAliases([turn], stats, ['durationMs', 'duration_ms'], 'durationMs');
  const error = codexTurnError(turn);
  if (error) stats['error'] = error;
  return Object.keys(stats).length > 2 ? stats : undefined;
}

export function providerToolFailuresFromAppServerItem(
  item: Record<string, unknown> | undefined,
  providerToolsById: Map<string, Record<string, unknown>>,
  runtimeKind: string,
): Record<string, unknown>[] {
  if (!item) return [];
  const error = providerToolErrorFromAppServerItem(item);
  if (!error) return [];
  const providerToolId = stringField(item, 'id');
  const startedTool = providerToolId ? providerToolsById.get(providerToolId) : undefined;
  const fallbackTool = providerToolCallsFromAppServerItem(item)[0];
  return [{
    ...(fallbackTool ?? {}),
    ...(startedTool ?? {}),
    error,
    ...(providerToolId ? { providerToolId } : {}),
    runtimeKind,
  }];
}

export function codexSubagentLinkageFromRecord(record: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!record) return {};
  const source = asRecord(record['source']);
  const subagent = asRecord(source?.['subagent']);
  const threadSpawn = asRecord(subagent?.['thread_spawn']);
  const sources = [record, subagent, threadSpawn];
  const parentToolCallId = firstStringAlias(sources, [
    'parentToolCallId',
    'parent_tool_call_id',
    'parentToolUseId',
    'parent_tool_use_id',
  ]);
  let subRunId = firstStringAlias(sources, [
    'subRunId',
    'sub_run_id',
    'subagentRunId',
    'subagent_run_id',
    'agentId',
    'agent_id',
  ]);
  if (!subRunId && isCodexSubagentRecord(record)) {
    subRunId = stringField(record, 'threadId') ?? stringField(record, 'thread_id');
  }
  if (!parentToolCallId || !subRunId) return {};

  const output: Record<string, unknown> = {
    depth: 1,
    parentToolCallId,
    subRunId,
  };
  copyStringAliases(sources, output, ['name', 'agentName', 'agent_name', 'agentNickname', 'agent_nickname'], 'name');
  copyStringAliases(sources, output, ['role', 'agentRole', 'agent_role'], 'role');
  copyNumberAliases(sources, output, ['depth'], 'depth');
  return output;
}

function codexNotificationIdentity(params: Record<string, unknown>): Record<string, unknown> {
  return {
    ...stringPayload(params, 'threadId'),
    ...stringPayload(params, 'turnId'),
    ...stringPayload(params, 'itemId'),
    ...codexSubagentLinkageFromRecord(params),
  };
}

function codexItemIdentity(item: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!item) return {};
  return {
    ...stringPayload(item, 'id', 'itemId'),
    ...stringPayload(item, 'type', 'itemType'),
  };
}

function codexReasoningItemPayload(item: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!item) return {};
  const summary = stringArrayPayload(item['summary']);
  const content = stringArrayPayload(item['content']);
  return {
    ...(summary.length > 0 ? { summary, summaryCount: summary.length } : {}),
    ...(content.length > 0 ? { content, contentCount: content.length } : {}),
  };
}

function sanitizePlan(value: unknown[]): Array<Record<string, unknown>> {
  return value
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return undefined;
      return {
        ...textPayload(record, 'step'),
        ...stringPayload(record, 'status'),
      };
    })
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function sanitizeRawResponseItem(item: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!item) return {};
  const type = stringField(item, 'type');
  const payload: Record<string, unknown> = {
    ...(type ? { itemType: type } : {}),
  };
  copyStringAliases([item], payload, ['role', 'name', 'namespace', 'status', 'call_id'], 'label');
  const encrypted = item['encrypted_content'];
  if (typeof encrypted === 'string' && encrypted.length > 0) payload['encryptedContentPresent'] = true;
  const argumentsValue = item['arguments'];
  if (typeof argumentsValue === 'string') payload['argumentsLength'] = argumentsValue.length;
  const output = item['output'];
  if (typeof output === 'string') payload['outputLength'] = output.length;
  const summary = Array.isArray(item['summary']) ? item['summary'] : undefined;
  if (summary) payload['summaryCount'] = summary.length;
  const content = Array.isArray(item['content']) ? item['content'] : undefined;
  if (content) payload['contentCount'] = content.length;
  const tools = Array.isArray(item['tools']) ? item['tools'] : undefined;
  if (tools) payload['toolCount'] = tools.length;
  return payload;
}

function sanitizeRateLimits(rateLimits: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!rateLimits) return {};
  return {
    ...stringPayload(rateLimits, 'limitId'),
    ...stringPayload(rateLimits, 'limitName'),
    ...stringPayload(rateLimits, 'planType'),
    ...stringPayload(rateLimits, 'rateLimitReachedType'),
    ...(asRecord(rateLimits['primary']) ? { primary: sanitizeRateLimitWindow(asRecord(rateLimits['primary']) ?? {}) } : {}),
    ...(asRecord(rateLimits['secondary']) ? { secondary: sanitizeRateLimitWindow(asRecord(rateLimits['secondary']) ?? {}) } : {}),
  };
}

function sanitizeRateLimitWindow(window: Record<string, unknown>): Record<string, unknown> {
  return {
    ...numberPayload(window, 'usedPercent'),
    ...numberPayload(window, 'windowDurationMins'),
    ...numberPayload(window, 'resetsAt'),
  };
}

function sanitizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  const record = asRecord(value);
  if (!record) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === 'encrypted_content' || key === 'encryptedContent' || key === 'arguments') {
      sanitized[`${key}Present`] = entry !== undefined && entry !== null;
      continue;
    }
    sanitized[key] = typeof entry === 'string' ? truncateForActivity(entry) : sanitizeJson(entry);
  }
  return sanitized;
}

function stringPayload(
  record: Record<string, unknown>,
  from: string,
  to = from,
): Record<string, unknown> {
  const value = stringField(record, from);
  return value ? { [to]: value } : {};
}

function textPayload(
  record: Record<string, unknown>,
  from: string,
  to = from,
): Record<string, unknown> {
  const value = stringField(record, from);
  return value ? { [to]: truncateForActivity(value) } : {};
}

function numberPayload(
  record: Record<string, unknown>,
  from: string,
  to = from,
): Record<string, unknown> {
  const value = record[from];
  return typeof value === 'number' && Number.isFinite(value) ? { [to]: value } : {};
}

function stringArrayPayload(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .slice(0, 8)
    .map((entry) => truncateForActivity(entry));
}

function codexTurnError(turn: Record<string, unknown>): string | undefined {
  const error = turn['error'];
  if (typeof error === 'string' && error) return truncateForActivity(error);
  const message = stringField(asRecord(error) ?? {}, 'message');
  return message ? truncateForActivity(message) : undefined;
}

function copyNumberAliases(
  sources: Array<Record<string, unknown> | undefined>,
  target: Record<string, unknown>,
  aliases: string[],
  to: string,
): void {
  for (const source of sources) {
    if (!source) continue;
    for (const alias of aliases) {
      const value = source[alias];
      if (typeof value === 'number' && Number.isFinite(value)) {
        target[to] = value;
        return;
      }
    }
  }
}

function copyStringAliases(
  sources: Array<Record<string, unknown> | undefined>,
  target: Record<string, unknown>,
  aliases: string[],
  to: string,
): void {
  for (const source of sources) {
    if (!source) continue;
    for (const alias of aliases) {
      const value = source[alias];
      if (typeof value === 'string' && value) {
        target[to] = value;
        return;
      }
    }
  }
}

function firstStringAlias(sources: Array<Record<string, unknown> | undefined>, aliases: string[]): string | undefined {
  for (const source of sources) {
    if (!source) continue;
    for (const alias of aliases) {
      const value = stringField(source, alias);
      if (value) return value;
    }
  }
  return undefined;
}

function isCodexSubagentRecord(record: Record<string, unknown>): boolean {
  const source = asRecord(record['source']);
  return stringField(record, 'thread_source') === 'subagent' ||
    stringField(record, 'threadSource') === 'subagent' ||
    Boolean(asRecord(source?.['subagent']));
}

function providerToolErrorFromAppServerItem(item: Record<string, unknown>): string | undefined {
  const exitCode = item['exitCode'];
  if (typeof exitCode === 'number' && exitCode !== 0) {
    return truncateForActivity(stringField(item, 'aggregatedOutput') ?? `exit code ${String(exitCode)}`);
  }
  const status = stringField(item, 'status');
  if (status !== 'failed' && status !== 'errored') return undefined;
  const error = item['error'];
  if (typeof error === 'string') return truncateForActivity(error);
  const message = stringField(asRecord(error) ?? {}, 'message');
  return truncateForActivity(message ?? status);
}

function fileChangeTarget(item: Record<string, unknown>): string {
  const changes = Array.isArray(item['changes'])
    ? item['changes'].map((change) => asRecord(change)).filter((change): change is Record<string, unknown> => Boolean(change))
    : [];
  const onlyChange = changes[0];
  if (changes.length === 1 && onlyChange) {
    const path = stringField(onlyChange, 'path');
    const kind = stringField(onlyChange, 'kind');
    return singleLine([kind, path].filter(Boolean).join(' ') || 'file change');
  }
  return changes.length > 1 ? `${changes.length} file changes` : 'file change';
}

function webSearchDetails(item: Record<string, unknown>): Record<string, unknown> {
  const action = asRecord(item['action']);
  const directQuery = stringField(item, 'query');
  const actionQuery = stringField(action ?? {}, 'query');
  const query = directQuery ?? actionQuery ?? webSearchQueries(action).join(' / ');
  if (query) {
    const target = singleLine(query);
    return { query: target, target };
  }

  const url = stringField(action ?? item, 'url');
  const pattern = stringField(action ?? item, 'pattern');
  if (pattern && url) return { pattern: singleLine(pattern), target: singleLine(`${pattern} in ${url}`), url };
  if (url) return { target: singleLine(url), url };
  if (pattern) return { pattern: singleLine(pattern), target: singleLine(pattern) };
  return {};
}

function webSearchQueries(action: Record<string, unknown> | undefined): string[] {
  const queries = action?.['queries'];
  if (!Array.isArray(queries)) return [];
  return queries
    .filter((query): query is string => typeof query === 'string' && query.length > 0)
    .slice(0, 3)
    .map((query) => singleLine(query));
}

function stripShellWrapper(command: string): string {
  const match = command.match(/^\/\S+\s+-\S+\s+'([\s\S]*)'\s*$/) ?? command.match(/^\/\S+\s+-\S+\s+"([\s\S]*)"\s*$/);
  return match?.[1] ?? command;
}
