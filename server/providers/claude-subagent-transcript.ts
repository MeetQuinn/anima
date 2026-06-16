// Subagent transcript reading and activity linkage for Claude Code runs.
//
// Claude writes each spawned subagent's turns to a sidecar transcript under
// ~/.claude/projects/<project>/<session>/subagents/. This module resolves those
// transcript/metadata paths, parses their lines, and derives the parent->child
// linkage stamped onto subagent activities. It is the pure/state-reading layer:
// it never emits activities. The emitting orchestration (ingest/record/flush)
// lives in claude-events.ts, which imports from here.

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isRecord, stringField } from '../json.js';

export interface ClaudeSubagentResult {
  agentId: string;
  agentType?: string;
  parentToolCallId: string;
}

interface ClaudeJsonlMapperContext {
  cwd?: string;
  sessionId?: string;
}

interface PendingClaudeAgentText {
  payload: Record<string, unknown>;
  text: string;
}

export interface ClaudeJsonlMapperState {
  context: ClaudeJsonlMapperContext;
  emittedSubagentTextKeys: Set<string>;
  emittedSubagentToolIds: Set<string>;
  ingestedSubagentLogs: Set<string>;
  pendingAgentToolIds: Set<string>;
  pendingSubagentResultsByAgentId: Map<string, ClaudeSubagentResult>;
  pendingUnlinkedTexts: PendingClaudeAgentText[];
  pendingUnlinkedToolsById: Map<string, Record<string, unknown>>;
  providerToolsById: Map<string, Record<string, unknown>>;
  subagentIdByToolId: Map<string, { agentId: string; model?: string }>;
  subagentMetadataByKey: Map<string, Record<string, unknown> | undefined>;
}

export function hasSubagentLinkage(payload: Record<string, unknown>): boolean {
  return Boolean(stringField(payload, 'parentToolCallId') && stringField(payload, 'subRunId'));
}

export function updateClaudeJsonlContext(value: unknown, context: ClaudeJsonlMapperContext): void {
  if (!isRecord(value)) return;
  const cwd = stringField(value, 'cwd');
  if (cwd) context.cwd = cwd;
  const sessionId = stringField(value, 'sessionId') ?? stringField(value, 'session_id');
  if (sessionId) context.sessionId = sessionId;
}

export function claudeSubagentResultsFromClaudeJson(value: unknown): ClaudeSubagentResult[] {
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

export function claudeSubagentModelFromContents(contents: string): string | undefined {
  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseClaudeJsonlLine(line);
    if (!parsed) continue;
    const message = isRecord(parsed['message']) ? parsed['message'] : undefined;
    const model = stringField(message, 'model') ?? stringField(parsed, 'model');
    if (model) return model;
  }
  return undefined;
}

export function parseClaudeJsonlLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function claudeSubagentTextKey(agentId: string, value: Record<string, unknown>, text: string): string {
  return [
    agentId,
    stringField(value, 'uuid') ?? stringField(value, 'timestamp') ?? text,
  ].join('\u0000');
}

export async function subagentActivityLinkageFromClaudeJson(
  value: unknown,
  state: ClaudeJsonlMapperState,
): Promise<Record<string, unknown>> {
  if (!isRecord(value)) return {};
  const toolUseResult = isRecord(value['toolUseResult']) ? value['toolUseResult'] : undefined;
  const subagentInfo = await claudeSubagentInfoFromToolIds(value, state);
  const agentId =
    stringField(value, 'agentId') ??
    stringField(value, 'agent_id') ??
    stringField(toolUseResult, 'agentId') ??
    stringField(toolUseResult, 'agent_id') ??
    subagentInfo?.agentId;
  const metadata = await claudeSubagentMetadata(value, agentId, state);
  const linkage = claudeSubagentLinkage(value, agentId, metadata);
  if (subagentInfo?.model) linkage['model'] = subagentInfo.model;
  return linkage;
}

export function claudeSubagentLinkage(
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

async function claudeSubagentInfoFromToolIds(
  value: Record<string, unknown>,
  state: ClaudeJsonlMapperState,
): Promise<{ agentId: string; model?: string } | undefined> {
  const cwd = stringField(value, 'cwd') ?? state.context.cwd;
  const sessionId = stringField(value, 'sessionId') ?? stringField(value, 'session_id') ?? state.context.sessionId;
  if (!cwd || !sessionId) return undefined;
  for (const toolId of claudeToolIdsFromJson(value)) {
    const cacheKey = `${cwd}\u0000${sessionId}\u0000${toolId}`;
    const cached = state.subagentIdByToolId.get(cacheKey);
    if (cached) return cached;
    const info = await readClaudeSubagentInfoForToolId(cwd, sessionId, toolId);
    if (info) {
      state.subagentIdByToolId.set(cacheKey, info);
      return info;
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

export async function readClaudeSubagentMetadata(
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

async function readClaudeSubagentInfoForToolId(
  cwd: string,
  sessionId: string,
  toolId: string,
): Promise<{ agentId: string; model?: string } | undefined> {
  try {
    const dir = claudeSubagentsDir(cwd, sessionId);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = /^agent-(.+)\.jsonl$/.exec(entry.name);
      if (!match) continue;
      const agentId = match[1];
      if (!agentId) continue;
      const path = join(dir, entry.name);
      const contents = await readFile(path, 'utf8');
      if (contents.includes(toolId)) {
        return { agentId, model: claudeSubagentModelFromContents(contents) };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function claudeSubagentsDir(cwd: string, sessionId: string): string {
  return join(claudeProjectsRoot(), claudeProjectNameForCwd(cwd), sessionId, 'subagents');
}

export function claudeTranscriptPath(cwd: string, sessionId: string): string {
  return join(claudeProjectsRoot(), claudeProjectNameForCwd(cwd), `${sessionId}.jsonl`);
}

function claudeProjectsRoot(): string {
  return process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
}

function claudeProjectNameForCwd(cwd: string): string {
  return (cwd.replace(/\/+$/, '') || '/').replaceAll('/', '-');
}
