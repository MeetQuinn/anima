// Renders Slack mrkdwn / agent GFM as React nodes.
//
// Two passes. A line-based block pass handles what agents actually send
// (outbound records store the agent's original GFM — totoday 08-30): fenced
// code, `#` headings, `>` blockquotes, and pipe tables. Everything else flows
// to the inline pass: **bold**, *bold*, _italic_, `code`, ~~strike~~,
// [label](url) links, Slack links/channels/users/usergroups/date/special
// mentions, Unicode emoji shortcodes, and bare http(s) URLs in plain text
// (outbound agent text never went through Slack's linkifier, so it carries no
// <url> entities). Inline patterns are matched in one pass; overlapping markup
// is not supported (same as Slack). Lists stay plain text: their markers read
// fine, and real list layout would fight the pre-wrap wrapper for no gain.

import type { ReactNode } from 'react';
import { emojiGlyph } from './emoji';

const TOKEN_RE =
  /```([\s\S]*?)```|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`|<!date\^[^|>]*(?:\|([^>]*))?>|<!subteam\^([A-Z0-9]+)(?:\|([^>]*))?>|<!(channel|here|everyone)>|<(https?:\/\/[^|>\s]+)\|([^>]+)>|<(https?:\/\/[^>\s]+)>|<#([A-Z0-9]+)\|([^>]+)>|<@([A-Z0-9]+)(?:\|([^>]*))?>|:([a-z0-9_+-]+):|~~([^~\n]+)~~|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

const LINK_CLASS = 'text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent';
const CODE_BLOCK_CLASS = 'mt-1 overflow-x-auto rounded bg-surface-elevated px-2 py-1.5 font-mono text-[12px]';
const CELL_CLASS = 'border border-border-soft px-2 py-0.5 text-left align-top';

const FENCE_RE = /^\s*```/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;

export function renderMrkdwn(text: string): ReactNode {
  if (!text) return null;
  const nodes = renderBlocks(decodeSlackEntities(text));
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0] as ReactNode;
  return <>{nodes}</>;
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.split('\n');
  const nodes: ReactNode[] = [];
  let key = 0;
  let plain: string[] = [];

  // Plain runs keep the exact pre-block-pass rendering (lines + <br>), so
  // block-free messages render byte-identically to the previous version.
  const flushPlain = () => {
    while (plain.length > 0 && plain.at(-1) === '') plain.pop();
    if (plain.length === 0) return;
    renderInline(nodes, plain.join('\n'), `p${key++}`);
    plain = [];
  };
  // A block element already breaks the line; a single blank line after it
  // would double the gap under the pre-wrap wrapper.
  const skipOneBlank = (index: number): number =>
    lines[index] === '' ? index + 1 : index;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;

    if (FENCE_RE.test(line)) {
      const rest = line.replace(FENCE_RE, '');
      flushPlain();
      if (rest.trim() !== '' && rest.trimEnd().endsWith('```')) {
        // One-line ```code``` fence.
        nodes.push(
          <pre key={`f${key++}`} className={CODE_BLOCK_CLASS}>
            <code>{rest.trimEnd().slice(0, -3).trim()}</code>
          </pre>,
        );
        i = skipOneBlank(i + 1);
        continue;
      }
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !FENCE_RE.test(lines[j] as string)) {
        body.push(lines[j] as string);
        j += 1;
      }
      nodes.push(
        <pre key={`f${key++}`} className={CODE_BLOCK_CLASS}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      i = skipOneBlank(j + 1);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPlain();
      const level = (heading[1] as string).length;
      nodes.push(
        <div
          key={`h${key++}`}
          className={`my-1 font-semibold ${level <= 2 ? 'text-[14px]' : 'text-[13px]'}`}
        >
          {renderInlineNode(heading[2] as string, `h${key}`)}
        </div>,
      );
      i = skipOneBlank(i + 1);
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flushPlain();
      const quoted: string[] = [];
      let j = i;
      while (j < lines.length) {
        const match = QUOTE_RE.exec(lines[j] as string);
        if (!match) break;
        quoted.push(match[1] as string);
        j += 1;
      }
      nodes.push(
        <blockquote
          key={`q${key++}`}
          className="my-1 border-l-2 border-border-soft pl-2 text-text-muted"
        >
          {renderInlineNode(quoted.join('\n'), `q${key}`)}
        </blockquote>,
      );
      i = skipOneBlank(j);
      continue;
    }

    if (TABLE_ROW_RE.test(line) && TABLE_SEPARATOR_RE.test(lines[i + 1] ?? '')) {
      flushPlain();
      const header = tableCells(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW_RE.test(lines[j] as string)) {
        rows.push(tableCells(lines[j] as string));
        j += 1;
      }
      const tableKey = key++;
      nodes.push(
        <table key={`t${tableKey}`} className="my-1 border-collapse text-[12px]">
          <thead>
            <tr>
              {header.map((cell, cellIndex) => (
                <th key={cellIndex} className={`${CELL_CLASS} font-semibold`}>
                  {renderInlineNode(cell, `t${tableKey}h${cellIndex}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className={CELL_CLASS}>
                    {renderInlineNode(cell, `t${tableKey}r${rowIndex}c${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      i = skipOneBlank(j);
      continue;
    }

    plain.push(line);
    i += 1;
  }
  flushPlain();
  return nodes;
}

function tableCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderInlineNode(text: string, keyPrefix: string): ReactNode {
  const nodes: ReactNode[] = [];
  renderInline(nodes, text, keyPrefix);
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0] as ReactNode;
  return <>{nodes}</>;
}

function renderInline(nodes: ReactNode[], mrkdwn: string, keyPrefix: string): void {
  let last = 0;
  let k = 0;
  const nextKey = () => `${keyPrefix}-${k++}`;

  for (const m of mrkdwn.matchAll(TOKEN_RE)) {
    const start = m.index!;
    if (start > last) addText(nodes, mrkdwn.slice(last, start), nextKey());

    if (m[1] !== undefined) {
      // One-line ```code block``` inside a paragraph (multi-line fences are
      // consumed by the block pass before this runs).
      nodes.push(
        <pre key={nextKey()} className={CODE_BLOCK_CLASS}>
          <code>{m[1].trim()}</code>
        </pre>,
      );
    } else if (m[2]) {
      nodes.push(
        <strong key={nextKey()} className="font-semibold">
          {m[2]}
        </strong>,
      );
    } else if (m[3]) {
      nodes.push(
        <strong key={nextKey()} className="font-semibold">
          {m[3]}
        </strong>,
      );
    } else if (m[4]) {
      nodes.push(<em key={nextKey()}>{m[4]}</em>);
    } else if (m[5]) {
      // `inline code` — border-border-soft makes the code span visually distinct
      // from surrounding prose; without it the bg-surface-elevated alone is too
      // subtle on the warm cream body background.
      nodes.push(
        <code
          key={nextKey()}
          className="rounded border border-border-soft bg-surface-elevated px-1 font-mono text-[0.9em]"
        >
          {m[5]}
        </code>,
      );
    } else if (m[6] !== undefined) {
      addText(nodes, m[6], nextKey());
    } else if (m[7]) {
      // <!subteam^S...|@group>
      nodes.push(
        <span key={nextKey()} className="font-medium text-accent">
          @{(m[8] || m[7]).replace(/^@/, '')}
        </span>,
      );
    } else if (m[9]) {
      nodes.push(
        <span key={nextKey()} className="font-medium text-accent">
          @{m[9]}
        </span>,
      );
    } else if (m[10] && m[11]) {
      // <url|label>
      nodes.push(
        <a key={nextKey()} href={m[10]} target="_blank" rel="noreferrer" className={LINK_CLASS}>
          {m[11]}
        </a>,
      );
    } else if (m[12]) {
      // bare <url>
      nodes.push(
        <a key={nextKey()} href={m[12]} target="_blank" rel="noreferrer" className={LINK_CLASS}>
          {m[12]}
        </a>,
      );
    } else if (m[13] && m[14]) {
      // <#channelId|name>
      nodes.push(
        <span key={nextKey()} className="font-medium text-accent">
          #{m[14]}
        </span>,
      );
    } else if (m[15]) {
      // <@userId|handle> or <@userId>
      const label = m[16] || m[15];
      nodes.push(
        <span key={nextKey()} className="font-medium text-accent">
          @{label}
        </span>,
      );
    } else if (m[17]) {
      nodes.push(emojiGlyph(m[17]) ?? `:${m[17]}:`);
    } else if (m[18]) {
      // ~~strikethrough~~
      nodes.push(
        <del key={nextKey()} className="opacity-70">
          {m[18]}
        </del>,
      );
    } else if (m[19] && m[20]) {
      // [label](url) — GFM link in outbound agent text
      nodes.push(
        <a key={nextKey()} href={m[20]} target="_blank" rel="noreferrer" className={LINK_CLASS}>
          {m[19]}
        </a>,
      );
    }

    last = start + m[0].length;
  }

  if (last < mrkdwn.length) addText(nodes, mrkdwn.slice(last), nextKey());
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

function addText(nodes: ReactNode[], text: string, keyBase: string): void {
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
