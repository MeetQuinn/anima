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

// `|` keeps line breaks, `>` folds them; optional chomping (+/-) and an
// explicit indentation digit may follow in either order, then a comment.
const BLOCK_SCALAR_HEADER = /^([|>])(?:([1-9])[+-]?|[+-]([1-9])?)?(?:[ \t]+#.*)?$/;

function leadingWidth(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

/** Lines after a top-level key that belong to its value: blank or indented. */
function takeIndented(lines: string[], start: number): { taken: string[]; next: number } {
  let end = start;
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end++;
  let last = end;
  while (last > start && lines[last - 1].trim() === '') last--;
  return { taken: lines.slice(start, last), next: end };
}

/**
 * YAML folding for display: adjacent lines join with a space, each blank line
 * becomes a line break, and more-indented lines keep the breaks around them.
 */
function foldLines(lines: string[]): string {
  let out = '';
  let prev: 'none' | 'text' | 'more' = 'none';
  let blanks = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blanks++;
      continue;
    }
    const kind = /^[ \t]/.test(line) ? 'more' : 'text';
    if (prev !== 'none') {
      out += prev === 'text' && kind === 'text' ? (blanks > 0 ? '\n'.repeat(blanks) : ' ') : '\n'.repeat(blanks + 1);
    }
    out += line;
    prev = kind;
    blanks = 0;
  }
  return out;
}

function blockScalarValue(style: string, explicitIndent: number | null, lines: string[]): string {
  const firstText = lines.find((line) => line.trim() !== '');
  const indent = explicitIndent ?? (firstText ? leadingWidth(firstText) : 0);
  const body = lines.map((line) => line.slice(Math.min(indent, leadingWidth(line))));
  while (body.length > 0 && body[0].trim() === '') body.shift();
  // Chomping only changes trailing newlines, which a table cell never shows.
  return style === '|' ? body.join('\n') : foldLines(body);
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
    const header = BLOCK_SCALAR_HEADER.exec(inlineVal);
    if (header) {
      // `key: >-` / `key: |`: the value is the indented text below the header.
      const { taken, next } = takeIndented(lines, i + 1);
      const explicitIndent = header[2] ?? header[3];
      entries.push({
        key,
        value: blockScalarValue(header[1], explicitIndent ? Number(explicitIndent) : null, taken),
        block: null,
      });
      i = next;
      continue;
    }
    if (inlineVal !== '') {
      // A plain or quoted scalar may continue on indented lines; YAML folds them.
      const { taken, next } = takeIndented(lines, i + 1);
      const folded = foldLines([inlineVal, ...taken.map((line) => line.trim())]);
      entries.push({ key, value: stripQuotes(folded), block: null });
      i = next;
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
