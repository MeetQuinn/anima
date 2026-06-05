export type FeishuPostInlineItem =
  | { tag: 'text'; text: string; style?: string[] }
  | { tag: 'a'; text: string; href: string }
  | { tag: 'code_block'; language: string; text: string };

export type FeishuPostParagraph = FeishuPostInlineItem[];

export interface FeishuPostContent {
  zh_cn: {
    title: string;
    content: FeishuPostParagraph[];
  };
}

/**
 * Parses inline Markdown spans within a single line of text and returns an
 * array of FeishuPostInlineItem values.  Patterns handled (left-to-right,
 * greedy, `**` before `*`):
 *   **text** / __text__  → bold text
 *   *text*  / _text_    → italic text
 *   `code`              → inline_code text
 *   [text](url)         → link
 */
function parseInline(line: string): FeishuPostInlineItem[] {
  const items: FeishuPostInlineItem[] = [];
  let i = 0;

  while (i < line.length) {
    const ch = line[i]!;

    // ---- bold: **text** or __text__ ----
    if (
      (ch === '*' && line[i + 1] === '*') ||
      (ch === '_' && line[i + 1] === '_')
    ) {
      const delim = line.slice(i, i + 2);
      const end = line.indexOf(delim, i + 2);
      if (end !== -1) {
        const text = line.slice(i + 2, end);
        items.push({ tag: 'text', text, style: ['bold'] });
        i = end + 2;
        continue;
      }
    }

    // ---- inline code: `code` ----
    if (ch === '`') {
      const end = line.indexOf('`', i + 1);
      if (end !== -1) {
        const text = line.slice(i + 1, end);
        items.push({ tag: 'text', text, style: ['inline_code'] });
        i = end + 1;
        continue;
      }
    }

    // ---- link: [text](url) ----
    if (ch === '[') {
      const closeBracket = line.indexOf(']', i + 1);
      if (closeBracket !== -1 && line[closeBracket + 1] === '(') {
        const closeParen = line.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const text = line.slice(i + 1, closeBracket);
          const href = line.slice(closeBracket + 2, closeParen);
          items.push({ tag: 'a', text, href });
          i = closeParen + 1;
          continue;
        }
      }
    }

    // ---- italic: *text* or _text_ (single delimiter) ----
    if (ch === '*' || ch === '_') {
      const end = line.indexOf(ch, i + 1);
      if (end !== -1) {
        const text = line.slice(i + 1, end);
        items.push({ tag: 'text', text, style: ['italic'] });
        i = end + 1;
        continue;
      }
    }

    // ---- plain text: accumulate until the next possible span opener ----
    let j = i + 1;
    while (j < line.length) {
      const next = line[j]!;
      if (next === '*' || next === '_' || next === '`' || next === '[') break;
      j++;
    }
    const text = line.slice(i, j);
    if (text) items.push({ tag: 'text', text });
    i = j;
  }

  return items;
}

/**
 * Converts a Markdown string to Feishu's "post" rich-text format.
 *
 * Supported constructs:
 *   - Fenced code blocks (``` … ```)
 *   - Headings (# / ## / ###) → bold text paragraph
 *   - Bullet lists (- / *)
 *   - Numbered lists (1. / 2. …)
 *   - Inline bold, italic, inline-code, links
 *   - Empty lines → empty paragraph separator
 */
export function markdownToFeishuPost(text: string): FeishuPostContent {
  const paragraphs: FeishuPostParagraph[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    // Safe: guarded by `i < lines.length`
    const line = lines[i]!;

    // ---- fenced code block ----
    if (/^```/.test(line)) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // consume the closing ```
      paragraphs.push([
        {
          tag: 'code_block',
          language: 'PLAIN_TEXT',
          text: codeLines.join('\n'),
        },
      ]);
      continue;
    }

    // ---- empty line ----
    if (line.trim() === '') {
      paragraphs.push([]);
      i++;
      continue;
    }

    // ---- heading: # / ## / ### ----
    const headingMatch = /^#{1,3} (.+)$/.exec(line);
    if (headingMatch) {
      const headingText = headingMatch[1] ?? '';
      const inlineItems = parseInline(headingText);
      const boldItems: FeishuPostInlineItem[] = inlineItems.map((item) => {
        if (item.tag === 'text') {
          return { tag: 'text' as const, text: item.text, style: ['bold'] };
        }
        return item;
      });
      paragraphs.push(boldItems);
      i++;
      continue;
    }

    // ---- bullet list: - or * ----
    const bulletMatch = /^[*-] (.*)$/.exec(line);
    if (bulletMatch) {
      const rest = bulletMatch[1] ?? '';
      const bulletItem: FeishuPostInlineItem = { tag: 'text', text: '• ' };
      const inlineItems = parseInline(rest);
      paragraphs.push([bulletItem, ...inlineItems]);
      i++;
      continue;
    }

    // ---- numbered list: 1. / 2. … ----
    const numberedMatch = /^(\d+)\. (.*)$/.exec(line);
    if (numberedMatch) {
      const num = numberedMatch[1] ?? '';
      const rest = numberedMatch[2] ?? '';
      const numItem: FeishuPostInlineItem = { tag: 'text', text: `${num}. ` };
      const inlineItems = parseInline(rest);
      paragraphs.push([numItem, ...inlineItems]);
      i++;
      continue;
    }

    // ---- regular text line ----
    const inlineItems = parseInline(line);
    paragraphs.push(inlineItems);
    i++;
  }

  return {
    zh_cn: {
      title: '',
      content: paragraphs,
    },
  };
}
