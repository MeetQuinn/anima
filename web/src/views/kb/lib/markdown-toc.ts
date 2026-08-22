export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-') || 'section';
}

export interface TocEntry {
  depth: number;
  text: string;
  id: string;
  line: number;
}

export type HeadingNode = {
  position?: {
    start?: {
      line?: number;
    };
  };
};

// Pandoc / VS Code style: `## Title {#custom-id}` — keep the visible title,
// use the brace id as the heading anchor when present.
const EXPLICIT_HEADING_ID_RE = /\s*\{#([A-Za-z0-9._:-]+)\}\s*$/;

export function parseHeadingLabel(raw: string): { text: string; explicitId: string | null } {
  const cleaned = markdownHeadingText(raw);
  const match = EXPLICIT_HEADING_ID_RE.exec(cleaned);
  if (!match) return { text: cleaned, explicitId: null };
  return {
    text: cleaned.slice(0, match.index).trimEnd(),
    explicitId: match[1],
  };
}

export function uniqueHeadingId(text: string, counts: Map<string, number>): string {
  const base = slugify(text);
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

export function markdownHeadingText(text: string): string {
  return text.replace(/\s+#+\s*$/, '').trim();
}

/**
 * Resolve an in-document hash to a heading id.
 *
 * Exact match wins. Otherwise, accept a unique prefix form used by hand-written
 * TOCs (e.g. `#000439` → heading id `000439-a-a` from `## 00:04:39 · …`).
 * Ambiguous prefixes return null so we never jump to the wrong section.
 */
export function resolveHeadingId(hash: string, ids: Iterable<string>): string | null {
  if (!hash) return null;
  const list = Array.from(ids);
  if (list.includes(hash)) return hash;
  const prefixed = list.filter((id) => id.startsWith(`${hash}-`));
  return prefixed.length === 1 ? prefixed[0] : null;
}

export function replaceLocationHash(id: string): void {
  if (window.location.hash === `#${id}`) return;
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}#${id}`,
  );
}

export function extractToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const counts = new Map<string, number>();
  const lines = markdown.split('\n');
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      const depth = match[1].length;
      const { text, explicitId } = parseHeadingLabel(match[2]);
      const id = explicitId ?? uniqueHeadingId(text, counts);
      if (explicitId) {
        // Reserve the explicit id so a *later* auto-slug won't collide with it.
        // Does not guard the reverse: `## Foo` (auto `foo`) then `## Bar {#foo}`
        // still emits a duplicate — author error; getElementById picks the first.
        const used = counts.get(explicitId) ?? 0;
        counts.set(explicitId, used + 1);
      }
      entries.push({ depth, text, id, line: index + 1 });
    }
  }
  return entries;
}

/**
 * Strip `{#id}` markers from heading lines so they don't render as prose.
 * Only real heading lines that carry the marker are rewritten. Non-marker
 * lines stay byte-identical, and fenced code is skipped entirely so a shell
 * snippet like `# step {#v1.2}` is not eaten as authoring syntax.
 */
export function stripExplicitHeadingIds(markdown: string): string {
  const lines = markdown.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (/^(`{3,}|~{3,})/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const match = line.match(/^(#{1,6}\s+)(.+)$/);
      if (!match) return line;
      const { text, explicitId } = parseHeadingLabel(match[2]);
      if (!explicitId) return line;
      return `${match[1]}${text}`;
    })
    .join('\n');
}

export function headingHref(id: string): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#${id}`;
}

// Parse a `#L<n>` line anchor from a location hash.
export function lineFromHash(hash: string): number | null {
  const m = /^#L(\d+)$/.exec(hash);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}
