// Renders Slack mrkdwn as React nodes.
// Handles: ```block```, **bold**, *bold*, _italic_, `code`, Slack links,
// channels/users/usergroups/date/special mentions, Unicode emoji shortcodes,
// and bare http(s) URLs in plain text (outbound agent text never went through
// Slack's linkifier, so it carries no <url> entities — totoday 08-30).
// Patterns are matched in one pass; overlapping markup is not supported (same as Slack).

import type { ReactNode } from 'react';
import { emojiGlyph } from './emoji';

const TOKEN_RE =
  /```([\s\S]*?)```|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`|<!date\^[^|>]*(?:\|([^>]*))?>|<!subteam\^([A-Z0-9]+)(?:\|([^>]*))?>|<!(channel|here|everyone)>|<(https?:\/\/[^|>\s]+)\|([^>]+)>|<(https?:\/\/[^>\s]+)>|<#([A-Z0-9]+)\|([^>]+)>|<@([A-Z0-9]+)(?:\|([^>]*))?>|:([a-z0-9_+-]+):/g;

const LINK_CLASS = 'text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent';

export function renderMrkdwn(text: string): ReactNode {
  if (!text) return null;
  const mrkdwn = decodeSlackEntities(text);

  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;

  for (const m of mrkdwn.matchAll(TOKEN_RE)) {
    const start = m.index!;
    if (start > last) addText(nodes, mrkdwn.slice(last, start), k++);

    if (m[1] !== undefined) {
      // ```code block```
      nodes.push(
        <pre
          key={k++}
          className="mt-1 overflow-x-auto rounded bg-surface-elevated px-2 py-1.5 font-mono text-[12px]"
        >
          <code>{m[1].trim()}</code>
        </pre>,
      );
    } else if (m[2]) {
      nodes.push(
        <strong key={k++} className="font-semibold">
          {m[2]}
        </strong>,
      );
    } else if (m[3]) {
      nodes.push(
        <strong key={k++} className="font-semibold">
          {m[3]}
        </strong>,
      );
    } else if (m[4]) {
      nodes.push(<em key={k++}>{m[4]}</em>);
    } else if (m[5]) {
      // `inline code` — border-border-soft makes the code span visually distinct
      // from surrounding prose; without it the bg-surface-elevated alone is too
      // subtle on the warm cream body background.
      nodes.push(
        <code
          key={k++}
          className="rounded border border-border-soft bg-surface-elevated px-1 font-mono text-[0.9em]"
        >
          {m[5]}
        </code>,
      );
    } else if (m[6] !== undefined) {
      addText(nodes, m[6], k++);
    } else if (m[7]) {
      // <!subteam^S...|@group>
      nodes.push(
        <span key={k++} className="font-medium text-accent">
          @{(m[8] || m[7]).replace(/^@/, '')}
        </span>,
      );
    } else if (m[9]) {
      nodes.push(
        <span key={k++} className="font-medium text-accent">
          @{m[9]}
        </span>,
      );
    } else if (m[10] && m[11]) {
      // <url|label>
      nodes.push(
        <a
          key={k++}
          href={m[10]}
          target="_blank"
          rel="noreferrer"
          className={LINK_CLASS}
        >
          {m[11]}
        </a>,
      );
    } else if (m[12]) {
      // bare <url>
      nodes.push(
        <a
          key={k++}
          href={m[12]}
          target="_blank"
          rel="noreferrer"
          className={LINK_CLASS}
        >
          {m[12]}
        </a>,
      );
    } else if (m[13] && m[14]) {
      // <#channelId|name>
      nodes.push(
        <span key={k++} className="font-medium text-accent">
          #{m[14]}
        </span>,
      );
    } else if (m[15]) {
      // <@userId|handle> or <@userId>
      const label = m[16] || m[15];
      nodes.push(
        <span key={k++} className="font-medium text-accent">
          @{label}
        </span>,
      );
    } else if (m[17]) {
      nodes.push(emojiGlyph(m[17]) ?? `:${m[17]}:`);
    }

    last = start + m[0].length;
  }

  if (last < mrkdwn.length) addText(nodes, mrkdwn.slice(last), k);

  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0] as ReactNode;
  return <>{nodes}</>;
}

function decodeSlackEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// URL characters are ASCII-only: agent text is often Chinese, and a URL glued
// to CJK text („https://x，checks") must stop at the first non-ASCII char —
// the same place Slack's own linkifier stops.
const BARE_URL_RE = /https?:\/\/[a-zA-Z0-9\-._~:/?#@!$&'()*+,;=%[\]]+/g;

// Punctuation that ends a sentence around a URL, not the URL itself
// („see https://x/y." should link https://x/y). An ASCII `)` is kept only
// while the URL has an unmatched `(` (wikipedia-style paths).
function trimTrailingPunctuation(url: string): string {
  for (;;) {
    const ch = url.at(-1);
    if (!ch) return url;
    if (/[.,;:!?'"\]]/.test(ch)) {
      url = url.slice(0, -1);
      continue;
    }
    if (ch === ')') {
      const open = url.split('(').length - 1;
      const close = url.split(')').length - 1;
      if (close > open) {
        url = url.slice(0, -1);
        continue;
      }
    }
    return url;
  }
}

function addText(nodes: ReactNode[], text: string, keyBase: number): void {
  if (!text) return;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (i > 0) nodes.push(<br key={`${keyBase}-${i}`} />);
    if (!line) return;
    let last = 0;
    let j = 0;
    for (const m of line.matchAll(BARE_URL_RE)) {
      const url = trimTrailingPunctuation(m[0]);
      if (!url || url === 'http://' || url === 'https://') continue;
      const start = m.index!;
      if (start > last) nodes.push(line.slice(last, start));
      nodes.push(
        <a
          key={`${keyBase}-${i}-${j++}`}
          href={url}
          target="_blank"
          rel="noreferrer"
          className={LINK_CLASS}
        >
          {url}
        </a>,
      );
      last = start + url.length;
    }
    if (last < line.length) nodes.push(line.slice(last));
  });
}
