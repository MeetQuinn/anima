export interface FrontmatterEntry {
  key: string;
  /** Inline scalar value, e.g. `name: foo`. Null when the value is a block. */
  value: string | null;
  /** Indented/list lines that follow a bare `key:` (nested map or list). */
  block: string[] | null;
}

export function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseTopLevelYaml(inner: string): FrontmatterEntry[] {
  const lines = inner.split('\n');
  const entries: FrontmatterEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    // A top-level key has no leading indentation.
    const match = /^([A-Za-z0-9_][\w .-]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!match || /^\s/.test(line)) {
      i++;
      continue;
    }
    const key = match[1];
    const inlineVal = (match[2] ?? '').trim();
    if (inlineVal !== '') {
      entries.push({ key, value: stripQuotes(inlineVal), block: null });
      i++;
      continue;
    }
    // Bare `key:` — collect the following indented or list lines as its block.
    const block: string[] = [];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === '') {
        i++;
        continue;
      }
      if (/^\s/.test(next) || /^-[ \t]/.test(next)) {
        block.push(next);
        i++;
        continue;
      }
      break;
    }
    entries.push({ key, value: null, block: block.length > 0 ? block : null });
  }
  return entries;
}

export function parseFrontmatter(content: string): { entries: FrontmatterEntry[] | null; body: string } {
  const fenced = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!fenced) return { entries: null, body: content };
  const entries = parseTopLevelYaml(fenced[1]);
  if (entries.length === 0) return { entries: null, body: content };
  return { entries, body: content.slice(fenced[0].length) };
}

export function dedentBlock(block: string[]): string[] {
  const indents = block
    .filter((line) => line.trim() !== '')
    .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return block.map((line) => line.slice(common));
}
