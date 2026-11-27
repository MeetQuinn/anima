import type { ReactNode } from 'react';

const INLINE_CODE_RE = /`([^`]+)`/g;

/**
 * Splits a plain-text string containing backticked inline commands (such as
 * `provider.installHint`) into text nodes and styled `<code>` elements, so
 * literal Markdown backticks never appear in the rendered UI.
 */
export function renderInlineCode(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_CODE_RE.lastIndex = 0;

  while ((match = INLINE_CODE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <code
        key={match.index}
        className="rounded-sm bg-surface-elevated px-1 py-px font-mono text-[0.95em]"
      >
        {match[1]}
      </code>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex === 0) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}
