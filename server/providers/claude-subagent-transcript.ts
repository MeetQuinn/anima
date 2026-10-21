// Subagent transcript reading and activity linkage for Claude Code runs.
//
// Claude writes each spawned subagent's turns to a sidecar transcript under
// ~/.claude/projects/<project>/<session>/subagents/. This module resolves those
// transcript/metadata paths, parses their lines, and derives the parent->child
// linkage stamped onto subagent activities. It is the pure/state-reading layer:
// it never emits activities. The emitting orchestration (ingest/record/flush)
// lives in claude-events.ts, which imports from here.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
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

interface ClaudeSubagentInfo {
  agentId: string;
  model?: string;
}

interface ClaudeSubagentTranscriptFile {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  contentHash: string;
  offset: number;
  info: ClaudeSubagentInfo;
  toolIds: Set<string>;
}

interface ClaudeSubagentTranscriptIndex {
  files: Map<string, ClaudeSubagentTranscriptFile>;
  byToolId: Map<string, ClaudeSubagentInfo>;
  dirty: boolean;
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
  subagentMetadataByKey: Map<string, Record<string, unknown>>;
}

/**
 * Claude stream-json marks root messages with a null parent; native transcript
 * rows use isSidechain=false. A line without either marker may belong to a
 * subagent.
 */
export function isClaudeRootLine(value: unknown): boolean {
  return isRecord(value) && (value['parent_tool_use_id'] === null || value['isSidechain'] === false);
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
  const explicitAgentId =
    stringField(value, 'agentId') ??
    stringField(value, 'agent_id') ??
    stringField(toolUseResult, 'agentId') ??
    stringField(toolUseResult, 'agent_id');
  const explicitLinkage = claudeSubagentLinkage(value, explicitAgentId, undefined);
  // A line marked as root needs no historical ownership search.
  if (!explicitAgentId && !hasSubagentLinkage(explicitLinkage) && isClaudeRootLine(value)) return {};

  const knownAgentId = explicitAgentId ?? stringField(explicitLinkage, 'subRunId');
  const subagentInfo = knownAgentId
    ? await claudeSubagentInfoForAgent(value, knownAgentId, state)
    : await claudeSubagentInfoFromToolIds(value, state);
  const agentId = knownAgentId ?? subagentInfo?.agentId;
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
  if (metadata) state.subagentMetadataByKey.set(cacheKey, metadata);
  return metadata;
}

async function claudeSubagentInfoForAgent(
  value: Record<string, unknown>,
  agentId: string,
  state: ClaudeJsonlMapperState,
): Promise<ClaudeSubagentInfo> {
  const message = isRecord(value['message']) ? value['message'] : undefined;
  const model = stringField(message, 'model') ?? stringField(value, 'model');
  // toolUseResult.agentId identifies a delegated child; the enclosing message's
  // model can still be the parent's, so only trust an explicitly child-owned row.
  if (model && (stringField(value, 'agentId') === agentId ||
    stringField(value, 'agent_id') === agentId ||
    hasSubagentLinkage(claudeSubagentLinkage(value, undefined, undefined)))) return { agentId, model };
  const cwd = stringField(value, 'cwd') ?? state.context.cwd;
  const sessionId = stringField(value, 'sessionId') ?? stringField(value, 'session_id') ?? state.context.sessionId;
  if (!cwd || !sessionId) return { agentId };
  const dir = claudeSubagentsDir(cwd, sessionId);
  const name = `agent-${agentId}.jsonl`;
  return withClaudeSubagentTranscriptIndex(dir, async (index) => {
    await refreshClaudeSubagentTranscriptFile(dir, name, agentId, index);
    return index.files.get(name)?.info ?? { agentId };
  });
}

async function claudeSubagentInfoFromToolIds(
  value: Record<string, unknown>,
  state: ClaudeJsonlMapperState,
): Promise<ClaudeSubagentInfo | undefined> {
  const cwd = stringField(value, 'cwd') ?? state.context.cwd;
  const sessionId = stringField(value, 'sessionId') ?? stringField(value, 'session_id') ?? state.context.sessionId;
  if (!cwd || !sessionId) return undefined;
  const toolIds = claudeToolIdsFromJson(value);
  if (toolIds.length === 0) return undefined;
  const dir = claudeSubagentsDir(cwd, sessionId);
  return withClaudeSubagentTranscriptIndex(dir, async (index) => {
    await refreshClaudeSubagentTranscriptIndex(dir, index);
    for (const toolId of toolIds) {
      const info = index.byToolId.get(toolId);
      if (info) return info;
    }
    return undefined;
  });
}

function claudeToolIdsFromJson(value: Record<string, unknown>): string[] {
  const message = value['message'];
  if (!isRecord(message) || !Array.isArray(message['content'])) return [];
  const ids: string[] = [];
  for (const item of message['content']) {
    if (!isRecord(item)) continue;
    const type = stringField(item, 'type');
    const id = type === 'tool_use' ? stringField(item, 'id')
      : type === 'tool_result' ? stringField(item, 'tool_use_id') : undefined;
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
    const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Subagent dirs whose transcript index stays in memory between runs. A
 * session with 190 transcripts and 100,000 tool IDs holds about 11MB.
 */
const SHARED_SUBAGENT_INDEX_LIMIT = 8;

interface SharedClaudeSubagentTranscriptIndex {
  index: ClaudeSubagentTranscriptIndex;
  /** Settles when the latest queued use of `index` finishes. */
  idle: Promise<void>;
}

/**
 * Transcript indexes shared by every mapper in the process, newest use last.
 * Each run gets a new mapper, and a session's subagents dir can hold hundreds
 * of transcripts, so an index per mapper re-read all of them on the first
 * lookup of every run. Each use still refreshes from readdir and stat first,
 * so sharing changes what is re-read, not what a lookup sees.
 */
const sharedSubagentTranscriptIndexes = new Map<string, SharedClaudeSubagentTranscriptIndex>();

/** Tests: drop shared indexes, so the next lookup builds from the files alone. */
export function resetClaudeSubagentTranscriptIndexesForTests(): void {
  sharedSubagentTranscriptIndexes.clear();
}

/** Run `use` on the shared index for `dir`, after any earlier use of it finishes. */
function withClaudeSubagentTranscriptIndex<T>(
  dir: string,
  use: (index: ClaudeSubagentTranscriptIndex) => Promise<T>,
): Promise<T> {
  const shared = sharedSubagentTranscriptIndexes.get(dir) ?? {
    index: { files: new Map(), byToolId: new Map(), dirty: false },
    idle: Promise.resolve(),
  };
  sharedSubagentTranscriptIndexes.delete(dir);
  sharedSubagentTranscriptIndexes.set(dir, shared);
  for (const oldest of sharedSubagentTranscriptIndexes.keys()) {
    if (sharedSubagentTranscriptIndexes.size <= SHARED_SUBAGENT_INDEX_LIMIT) break;
    sharedSubagentTranscriptIndexes.delete(oldest);
  }
  // Refreshes update files in place, so two at once on one index would race.
  const result = shared.idle.then(() => use(shared.index));
  shared.idle = result.then(() => undefined, () => undefined);
  return result;
}

async function refreshClaudeSubagentTranscriptIndex(
  dir: string,
  index: ClaudeSubagentTranscriptIndex,
): Promise<void> {
  const names = new Set<string>();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = /^agent-(.+)\.jsonl$/.exec(entry.name);
      if (!match) continue;
      const agentId = match[1];
      if (!agentId) continue;
      names.add(entry.name);
      await refreshClaudeSubagentTranscriptFile(dir, entry.name, agentId, index);
    }
  } catch {
    if (index.files.size > 0) index.dirty = true;
    index.files.clear();
  }
  for (const name of index.files.keys()) {
    if (!names.has(name)) {
      index.files.delete(name);
      index.dirty = true;
    }
  }
  // An absent ID is a miss against this snapshot, not a permanent negative:
  // stat/new-file checks above make later appends visible without rereading history.
  if (!index.dirty) return;
  index.byToolId.clear();
  for (const file of index.files.values()) {
    for (const toolId of file.toolIds) index.byToolId.set(toolId, file.info);
  }
  index.dirty = false;
}

async function refreshClaudeSubagentTranscriptFile(
  dir: string,
  name: string,
  agentId: string,
  index: ClaudeSubagentTranscriptIndex,
): Promise<void> {
  const path = join(dir, name);
  try {
    const previous = index.files.get(name);
    const snapshot = await fs.stat(path);
    if (previous && previous.dev === snapshot.dev && previous.ino === snapshot.ino &&
      previous.size === snapshot.size && previous.mtimeMs === snapshot.mtimeMs) return;
    const handle = await fs.open(path, 'r');
    try {
      const current = await handle.stat();
      const buffer = Buffer.alloc(64 * 1024);
      let hash = createHash('sha256');
      let append = false;
      if (previous && previous.dev === current.dev && previous.ino === current.ino && previous.size < current.size) {
        // The same inode can be truncated and rewritten to a larger size. Verify
        // the entire cached prefix before retaining its tool IDs, model or offset.
        let position = 0;
        while (position < previous.size) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, previous.size - position), position);
          if (bytesRead === 0) throw new Error('Subagent transcript changed during prefix verification');
          hash.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        append = hash.copy().digest('hex') === previous.contentHash;
      }
      const hashOffset = append && previous ? previous.size : 0;
      if (!append) hash = createHash('sha256');
      const file = previous && append ? previous : {
        dev: current.dev,
        ino: current.ino,
        size: 0,
        mtimeMs: 0,
        contentHash: '',
        offset: 0,
        info: { agentId },
        toolIds: new Set<string>(),
      };
      let position = file.offset;
      let pending: Buffer[] = [];
      while (position < current.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, current.size - position), position);
        if (bytesRead === 0) throw new Error('Subagent transcript changed during indexing');
        if (position + bytesRead > hashOffset) {
          hash.update(buffer.subarray(Math.max(0, hashOffset - position), bytesRead));
        }
        let start = 0;
        for (let end = buffer.indexOf(10, start); end >= 0 && end < bytesRead; end = buffer.indexOf(10, start)) {
          const segment = buffer.subarray(start, end);
          const line = pending.length === 0 ? segment.toString('utf8')
            : Buffer.concat([...pending, segment]).toString('utf8');
          indexClaudeSubagentTranscriptLine(line, file);
          pending = [];
          start = end + 1;
          file.offset = position + start;
        }
        if (start < bytesRead) pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
        position += bytesRead;
      }
      // Keep the byte offset before the trailing line: a writer can leave JSON
      // (or a multibyte character) incomplete until the next append.
      if (pending.length > 0) indexClaudeSubagentTranscriptLine(Buffer.concat(pending).toString('utf8'), file);
      file.size = current.size;
      file.mtimeMs = current.mtimeMs;
      file.contentHash = hash.digest('hex');
      index.files.set(name, file);
      index.dirty = true;
    } finally {
      await handle.close();
    }
  } catch {
    // A missing/unreadable file must not poison other files or cache a failed read.
    if (index.files.delete(name)) index.dirty = true;
  }
}

function indexClaudeSubagentTranscriptLine(line: string, file: ClaudeSubagentTranscriptFile): void {
  const parsed = parseClaudeJsonlLine(line);
  if (!parsed) return;
  const message = isRecord(parsed['message']) ? parsed['message'] : undefined;
  const model = stringField(message, 'model') ?? stringField(parsed, 'model');
  if (!file.info.model && model) file.info.model = model;
  for (const toolId of claudeToolIdsFromJson(parsed)) file.toolIds.add(toolId);
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
