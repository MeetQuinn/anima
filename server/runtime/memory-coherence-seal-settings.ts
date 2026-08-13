// Write Claude Code settings + write-fence hook for memory-coherence seal.
// Used only when ANIMA_MEMORY_COHERENCE_SEAL=1 on Claude launches.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Build Claude settings JSON that runs the write-fence PreToolUse hook for
 * Write|Edit|MultiEdit. Hook path is absolute; home is passed via env prefix.
 */
export function memoryCoherenceSealSettingsJson(homePath: string, hookPath: string): string {
  const command = `ANIMA_MEMORY_COHERENCE_HOME=${shellSingleQuote(homePath)} node ${shellSingleQuote(hookPath)}`;
  return `${JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit',
          hooks: [
            {
              type: 'command',
              command,
              timeout: 10,
            },
          ],
        },
      ],
    },
  }, null, 2)}\n`;
}

/** Inline hook source so dist packaging does not need a separate .mjs copy step. */
export const MEMORY_COHERENCE_WRITE_FENCE_HOOK_SOURCE = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const HOME_ENV = 'ANIMA_MEMORY_COHERENCE_HOME';

function isAllowedWritePath(homePath, targetPath) {
  if (!homePath?.trim() || !targetPath?.trim()) return false;
  const home = resolve(homePath);
  const target = resolve(home, targetPath);
  const memoryMd = resolve(home, 'MEMORY.md');
  const notesRoot = resolve(home, 'notes');
  if (target === memoryMd || target === notesRoot) return true;
  const rel = relative(notesRoot, target);
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !rel.startsWith('../');
}

function writePaths(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const name = String(toolName || '').toLowerCase();
  if (!['write', 'edit', 'multiedit', 'notebookedit'].includes(name)) return [];
  const paths = [];
  const single = toolInput.file_path ?? toolInput.filePath ?? toolInput.path;
  if (typeof single === 'string' && single.trim()) paths.push(single);
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (!edit || typeof edit !== 'object') continue;
      const p = edit.file_path ?? edit.filePath ?? edit.path;
      if (typeof p === 'string' && p.trim()) paths.push(p);
    }
  }
  return paths;
}

function deny(reason) {
  process.stderr.write(reason + '\\n');
  process.exit(2);
}

function main() {
  const home = process.env[HOME_ENV]?.trim();
  if (!home) deny('memory coherence seal: ' + HOME_ENV + ' is not set');
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); }
  catch (error) { deny('memory coherence seal: failed to read PreToolUse payload: ' + error); }
  let payload;
  try { payload = JSON.parse(raw || '{}'); }
  catch (error) { deny('memory coherence seal: invalid PreToolUse JSON: ' + error); }
  const toolName = payload.tool_name ?? payload.toolName ?? '';
  const toolInput = payload.tool_input ?? payload.toolInput ?? {};
  for (const p of writePaths(toolName, toolInput)) {
    if (!isAllowedWritePath(home, p)) {
      deny(
        'memory coherence seal: write path denied (' + p + '); '
          + 'only MEMORY.md and notes/ under the agent home may be written',
      );
    }
  }
  process.exit(0);
}
main();
`;

export async function writeMemoryCoherenceSealSettings(input: {
  homePath: string;
  settingsPath: string;
}): Promise<{ hookPath: string; settingsPath: string }> {
  await mkdir(dirname(input.settingsPath), { recursive: true });
  const hookPath = join(dirname(input.settingsPath), 'memory-coherence-write-fence-hook.mjs');
  await writeFile(hookPath, MEMORY_COHERENCE_WRITE_FENCE_HOOK_SOURCE, 'utf8');
  await writeFile(
    input.settingsPath,
    memoryCoherenceSealSettingsJson(input.homePath, hookPath),
    'utf8',
  );
  return { hookPath, settingsPath: input.settingsPath };
}

/** Settings path under the same run dir as the system prompt file. */
export function memoryCoherenceSealSettingsPath(
  systemPromptFilePath: string | undefined,
  agentId: string,
): string {
  if (systemPromptFilePath) {
    return join(dirname(systemPromptFilePath), 'memory-coherence-seal-settings.json');
  }
  return join('/tmp', `anima-memory-coherence-seal-${agentId}.json`);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
