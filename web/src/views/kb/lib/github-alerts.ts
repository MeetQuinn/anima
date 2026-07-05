import { AlertTriangle, Info, Lightbulb, Megaphone, OctagonAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type AlertType = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export const ALERT_META: Record<AlertType, { label: string; Icon: LucideIcon }> = {
  note: { label: 'Note', Icon: Info },
  tip: { label: 'Tip', Icon: Lightbulb },
  important: { label: 'Important', Icon: Megaphone },
  warning: { label: 'Warning', Icon: AlertTriangle },
  caution: { label: 'Caution', Icon: OctagonAlert },
};

export const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;

// Minimal hast types — enough to walk/mutate without pulling in @types/hast.
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export function alertTypeFromClassName(className: unknown): AlertType | null {
  const list = Array.isArray(className) ? className : typeof className === 'string' ? className.split(/\s+/) : [];
  if (!list.includes('markdown-alert')) return null;
  for (const type of Object.keys(ALERT_META) as AlertType[]) {
    if (list.includes(`markdown-alert-${type}`)) return type;
  }
  return null;
}

// rehype transform: a blockquote whose first line is `[!NOTE]` (etc.) becomes a
// classed alert. We only tag the <blockquote> + strip the marker text; the React
// `blockquote` component renders the icon + title so the icon stays a real
// lucide glyph (not injected markup that sanitize would have to allow). Runs
// AFTER rehype-raw and BEFORE rehype-sanitize, which keeps the classes (allowlisted).
export function rehypeGithubAlerts() {
  function transform(bq: HastNode) {
    const firstPara = bq.children?.find((c) => c.type === 'element' && c.tagName === 'p');
    const lead = firstPara?.children?.[0];
    if (!firstPara || !lead || lead.type !== 'text' || typeof lead.value !== 'string') return;
    const m = ALERT_MARKER.exec(lead.value);
    if (!m) return;
    const type = m[1].toLowerCase() as AlertType;

    // Strip the marker (and an optional following newline) from the lead text.
    const rest = lead.value.slice(m[0].length).replace(/^[^\S\n]*\n?/, '');
    if (rest) {
      lead.value = rest;
    } else {
      // Marker was alone in its text node: drop it plus a trailing soft-break /
      // <br>, and remove the paragraph entirely if nothing remains.
      firstPara.children!.shift();
      const next = firstPara.children![0];
      if (next && next.type === 'text' && typeof next.value === 'string' && /^\s+$/.test(next.value)) {
        firstPara.children!.shift();
      } else if (next && next.type === 'element' && next.tagName === 'br') {
        firstPara.children!.shift();
      }
      if (firstPara.children!.length === 0) {
        bq.children = bq.children!.filter((c) => c !== firstPara);
      }
    }

    bq.properties = bq.properties ?? {};
    bq.properties.className = ['markdown-alert', `markdown-alert-${type}`];
  }

  function walk(node: HastNode) {
    if (!node.children) return;
    for (const child of node.children) {
      if (child.type === 'element' && child.tagName === 'blockquote') transform(child);
      walk(child);
    }
  }

  return (tree: HastNode) => walk(tree);
}
