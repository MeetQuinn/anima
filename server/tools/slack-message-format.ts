const MARKDOWN_TEXT_LIMIT = 12_000;
const FALLBACK_TEXT_BYTE_LIMIT = 3500;

export interface SlackMarkdownBlock {
  text: string;
  type: 'markdown';
}

export type SlackMessageBlock = SlackMarkdownBlock;

export interface SlackMessageContent {
  blockCount: number;
  blocks: SlackMessageBlock[];
  format: 'markdown';
  text: string;
}

export function slackMessageContentForText(input: string): SlackMessageContent {
  const text = slackMarkdownBlockBreaks(input);
  const length = Array.from(text).length;
  if (length > MARKDOWN_TEXT_LIMIT) {
    throw new Error(`message is too long for Slack markdown block: ${length} characters, Slack allows ${MARKDOWN_TEXT_LIMIT}; send a file instead`);
  }
  return {
    blockCount: 1,
    blocks: [{ type: 'markdown', text }],
    format: 'markdown',
    text: fallbackText(text),
  };
}

function fallbackText(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= FALLBACK_TEXT_BYTE_LIMIT) return text;
  let end = 0;
  let bytes = Buffer.byteLength('…', 'utf8');
  for (const char of text) {
    const nextBytes = bytes + Buffer.byteLength(char, 'utf8');
    if (nextBytes > FALLBACK_TEXT_BYTE_LIMIT) break;
    bytes = nextBytes;
    end += char.length;
  }
  return `${text.slice(0, end)}…`;
}

// Slack's `markdown` block keeps single newlines inside a paragraph (verified
// on real Slack), but it follows CommonMark block rules: a plain line directly
// after a list item or blockquote line is a *lazy continuation* and renders
// inside that item/quote instead of as the paragraph the author meant
// (#agent-survey: hubby wrote a "blank line after lists" house rule for HubSpot
// link lists because of this). Insert the blank line the author forgot; leave
// everything else — including fenced code — untouched.
const FENCE_LINE = /^\s{0,3}(```|~~~)/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/;
const BLOCKQUOTE = /^\s{0,3}>/;
const INDENTED = /^(?: {2,}|\t)/;
const BLOCK_START = /^\s{0,3}(?:#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s|```|~~~|---+\s*$|\*\*\*+\s*$|___+\s*$|\|)/;

export function slackMarkdownBlockBreaks(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let inList = false;
  let inQuote = false;
  for (const line of lines) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      inList = false;
      inQuote = false;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (line.trim().length === 0) {
      inList = false;
      inQuote = false;
      out.push(line);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      inList = true;
      inQuote = false;
    } else if (BLOCKQUOTE.test(line)) {
      inQuote = true;
      inList = false;
    } else if ((inList && !INDENTED.test(line) && !BLOCK_START.test(line)) || (inQuote && !BLOCK_START.test(line))) {
      // Plain line that would lazily continue the open item/quote: end the block.
      out.push('');
      inList = false;
      inQuote = false;
    } else if (BLOCK_START.test(line) && !INDENTED.test(line)) {
      inList = false;
      inQuote = false;
    }
    out.push(line);
  }
  return out.join('\n');
}
