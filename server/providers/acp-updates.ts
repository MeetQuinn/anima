import { truncateForActivity } from '../activities/format.js';
import { isRecord, stringField } from '../json.js';

// Session-update parsing shared by the Grok, Kimi and OpenCode ACP adapters.
// Each CLI spells update types differently (`agent_message_chunk`,
// `agentMessageChunk`, or a single-key wrapper object), so updates are reduced
// to one snake_case type before the adapter maps them to Anima events.

export function extractSessionId(result: Record<string, unknown> | undefined): string | undefined {
  return stringField(result, 'sessionId') ?? stringField(result, 'session_id');
}

export function copyNumberLike(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  from: string[],
  to: string,
): void {
  for (const key of from) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      target[to] = value;
      return;
    }
  }
}

export function normalizeAcpUpdate(value: unknown): { data: Record<string, unknown>; type: string } {
  if (isRecord(value)) {
    const sessionUpdate = stringField(value, 'sessionUpdate') ?? stringField(value, 'type');
    if (sessionUpdate) return { data: value, type: normalizeAcpUpdateType(sessionUpdate) };
    const entries = Object.entries(value);
    if (entries.length === 1) {
      const [key, data] = entries[0] ?? [];
      return { data: isRecord(data) ? data : {}, type: normalizeAcpUpdateType(key ?? '') };
    }
    return { data: value, type: '' };
  }
  return { data: {}, type: '' };
}

function normalizeAcpUpdateType(type: string): string {
  const key = type.trim().toLowerCase().replace(/[_-]/g, '');
  switch (key) {
    case 'agentmessagechunk':
      return 'agent_message_chunk';
    case 'agentthoughtchunk':
      return 'agent_thought_chunk';
    case 'toolcall':
      return 'tool_call';
    case 'toolcallupdate':
      return 'tool_call_update';
    case 'usageupdate':
      return 'usage_update';
    case 'turnend':
    case 'endturn':
      return 'turn_end';
    default:
      return '';
  }
}

export function extractAcpText(data: Record<string, unknown>): string | undefined {
  if (typeof data['text'] === 'string') return data['text'];
  if (typeof data['delta'] === 'string') return data['delta'];
  const content = data['content'];
  if (typeof content === 'string') return content;
  if (isRecord(content)) {
    return stringField(content, 'text') ?? stringField(content, 'delta');
  }
  return undefined;
}

export function toolCallId(data: Record<string, unknown>): string | undefined {
  return stringField(data, 'toolCallId') ?? stringField(data, 'tool_call_id') ?? stringField(data, 'id');
}

export function toolInput(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const rawInput = data['rawInput'] ?? data['input'] ?? data['parameters'];
  return isRecord(rawInput) ? rawInput : undefined;
}

export function extractAcpToolCallText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'content') {
      const inner = block['content'];
      if (typeof inner === 'string') {
        parts.push(inner);
        continue;
      }
      if (isRecord(inner) && stringField(inner, 'type') === 'text') {
        const text = stringField(inner, 'text');
        if (text) parts.push(text);
      }
      continue;
    }
    if (block['type'] === 'diff') {
      const path = stringField(block, 'path');
      if (!path) continue;
      const oldText = typeof block['oldText'] === 'string' ? block['oldText'] : '';
      const newText = typeof block['newText'] === 'string' ? block['newText'] : '';
      parts.push(`--- ${path}\n+++ ${path}\n${oldText ? `(edited: ${oldText.length} -> ${newText.length} bytes)` : `(new file, ${newText.length} bytes)`}`);
    }
  }
  return parts.join('\n');
}

export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw.trim() ? { text: truncateForActivity(raw) } : {};
  }
}
