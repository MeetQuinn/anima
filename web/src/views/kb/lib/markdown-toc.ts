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

export function uniqueHeadingId(text: string, counts: Map<string, number>): string {
  const base = slugify(text);
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

export function markdownHeadingText(text: string): string {
  return text.replace(/\s+#+\s*$/, '').trim();
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
      const text = markdownHeadingText(match[2]);
      entries.push({ depth, text, id: uniqueHeadingId(text, counts), line: index + 1 });
    }
  }
  return entries;
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
