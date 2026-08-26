const MARKDOWN_TEXT_LIMIT = 12_000;
const FALLBACK_TEXT_BYTE_LIMIT = 3500;

export interface SlackMarkdownBlock {
  text: string;
  type: "markdown";
}

export type SlackMessageBlock = SlackMarkdownBlock;

export interface SlackMessageContent {
  blockCount: number;
  blocks: SlackMessageBlock[];
  format: "markdown";
  text: string;
}

export function slackMessageContentForText(input: string): SlackMessageContent {
  const text = slackEmphasisFlanking(slackMarkdownBlockBreaks(input));
  const length = Array.from(text).length;
  if (length > MARKDOWN_TEXT_LIMIT) {
    throw new Error(
      `message is too long for Slack markdown block: ${length} characters, Slack allows ${MARKDOWN_TEXT_LIMIT}; send a file instead`,
    );
  }
  return {
    blockCount: 1,
    blocks: [{ type: "markdown", text }],
    format: "markdown",
    text: fallbackText(text),
  };
}

function fallbackText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= FALLBACK_TEXT_BYTE_LIMIT) return text;
  let end = 0;
  let bytes = Buffer.byteLength("…", "utf8");
  for (const char of text) {
    const nextBytes = bytes + Buffer.byteLength(char, "utf8");
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
const BLOCK_START =
  /^\s{0,3}(?:#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s|```|~~~|---+\s*$|\*\*\*+\s*$|___+\s*$|\|)/;

export function slackMarkdownBlockBreaks(text: string): string {
  const lines = text.split("\n");
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
    } else if (
      (inList && !INDENTED.test(line) && !BLOCK_START.test(line)) ||
      (inQuote && !BLOCK_START.test(line))
    ) {
      // Plain line that would lazily continue the open item/quote: end the block.
      out.push("");
      inList = false;
      inQuote = false;
    } else if (BLOCK_START.test(line) && !INDENTED.test(line)) {
      inList = false;
      inQuote = false;
    }
    out.push(line);
  }
  return out.join("\n");
}

// Slack's `markdown` block pairs `*`/`_` runs with CommonMark's flanking rules,
// but it only counts ASCII punctuation as punctuation (verified on real Slack).
// So `**支持 `CopyObject`**；单次` never closes: the run sits between a backtick
// (punctuation) and "；" (not punctuation to Slack, not whitespace), which is
// neither left- nor right-flanking. The literal `**` then pairs with the next
// run on a later line and bolds a paragraph the author never meant to. The
// same happens for an opener squeezed between a CJK character and a backtick,
// quote, or parenthesis. Slack does treat Unicode spaces as whitespace, so a
// hair space (U+200A, visually nothing) on the outer side of the run makes it
// flank correctly. Only runs that Slack would otherwise leave unpaired are
// touched; code spans and fenced code are left alone.
const HAIR_SPACE = "\u200A";
const ASCII_PUNCTUATION = /^[!-\/:-@[-`{-~]$/;
const CJK_OUTSIDE = /^[^\x00-\x7F\s]$/;

interface OpenRun {
  char: string;
  length: number;
}

export function slackEmphasisFlanking(text: string): string {
  const lines = text.split("\n");
  let inFence = false;
  let open: OpenRun[] = [];
  return lines
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        inFence = !inFence;
        open = [];
        return line;
      }
      if (inFence) return line;
      if (line.trim().length === 0) {
        open = [];
        return line;
      }
      return emphasisFlankingLine(line, open);
    })
    .join("\n");
}

function emphasisFlankingLine(line: string, open: OpenRun[]): string {
  const chars = Array.from(line);
  const out: string[] = [];
  let index = 0;
  while (index < chars.length) {
    const char = chars[index] ?? "";
    if (char === "`") {
      const end = codeSpanEnd(chars, index);
      if (end !== -1) {
        out.push(...chars.slice(index, end));
        index = end;
        continue;
      }
      out.push(char);
      index += 1;
      continue;
    }
    if (char !== "*" && char !== "_") {
      out.push(char);
      index += 1;
      continue;
    }
    let end = index;
    while (end < chars.length && chars[end] === char) end += 1;
    const run = chars.slice(index, end);
    const length = end - index;
    const prev = chars[index - 1] ?? "";
    const next = chars[end] ?? "";
    if (length > 2) {
      out.push(...run);
      index = end;
      continue;
    }
    const flank = slackFlanking(char, prev, next);
    const openIndex = findOpenRun(open, char, length);
    if (openIndex !== -1 && flank.canClose) {
      open.splice(openIndex);
      out.push(...run);
    } else if (
      openIndex !== -1 &&
      !flank.canClose &&
      ASCII_PUNCTUATION.test(prev) &&
      CJK_OUTSIDE.test(next)
    ) {
      // Intended closer: `...`code`**；` — a trailing hair space lets it close.
      open.splice(openIndex);
      out.push(...run, HAIR_SPACE);
    } else if (flank.canOpen) {
      open.push({ char, length });
      out.push(...run);
    } else if (
      openIndex === -1 &&
      CJK_OUTSIDE.test(prev) &&
      ASCII_PUNCTUATION.test(next)
    ) {
      // Intended opener: `中文**`code`...` — a leading hair space lets it open.
      open.push({ char, length });
      out.push(HAIR_SPACE, ...run);
    } else {
      out.push(...run);
    }
    index = end;
  }
  return out.join("");
}

function codeSpanEnd(chars: string[], start: number): number {
  let end = start;
  while (end < chars.length && chars[end] === "`") end += 1;
  const fence = end - start;
  let cursor = end;
  while (cursor < chars.length) {
    if (chars[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let close = cursor;
    while (close < chars.length && chars[close] === "`") close += 1;
    if (close - cursor === fence) return close;
    cursor = close;
  }
  return -1;
}

function findOpenRun(open: OpenRun[], char: string, length: number): number {
  for (let index = open.length - 1; index >= 0; index -= 1) {
    const run = open[index];
    if (run && run.char === char && run.length === length) return index;
  }
  return -1;
}

// Flanking as Slack computes it: line edges and Unicode spaces are whitespace,
// only ASCII characters are punctuation.
function slackFlanking(
  char: string,
  prev: string,
  next: string,
): { canClose: boolean; canOpen: boolean } {
  const prevSpace = prev === "" || /\s/.test(prev);
  const nextSpace = next === "" || /\s/.test(next);
  const prevPunct = ASCII_PUNCTUATION.test(prev);
  const nextPunct = ASCII_PUNCTUATION.test(next);
  const leftFlanking = !nextSpace && (!nextPunct || prevSpace || prevPunct);
  const rightFlanking = !prevSpace && (!prevPunct || nextSpace || nextPunct);
  if (char === "_") {
    return {
      canOpen: leftFlanking && (!rightFlanking || prevPunct),
      canClose: rightFlanking && (!leftFlanking || nextPunct),
    };
  }
  return { canOpen: leftFlanking, canClose: rightFlanking };
}
