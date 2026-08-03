export interface SlackMessageTextInput {
  blocks?: unknown;
  text?: string;
}

// Slack's top-level text is an accessibility/notification fallback. For rich
// messages it can be shorter than the body Slack renders from blocks, so
// preserve every renderable block and degrade unsupported nodes locally.
export function slackVisibleMessageText(input: SlackMessageTextInput): string | undefined {
  return slackMessageTextFromBlocks(input.blocks) ?? input.text;
}

/**
 * Apply blocks→visible text before routing/decide so mention detection and the
 * final inbox item share one canonical representation. No Slack API fetch.
 */
export function withCanonicalSlackVisibleText<T extends SlackMessageTextInput>(input: T): T {
  const visible = slackVisibleMessageText(input);
  if (visible === undefined || visible === input.text) return input;
  return { ...input, text: visible };
}

/**
 * True when the event **addresses** `userId` as a Slack mention entity.
 *
 * Per-block protocol (not message-global):
 * - `rich_text`: only structured `type: "user"` elements (never plain text nodes,
 *   never the canonical rendering of rich_text).
 * - Textual mrkdwn: top-level `markdown` blocks and nested `{ type: "mrkdwn" }`
 *   text objects (section/context/…): `<@U…>` tokens outside inline/fenced code.
 * - Raw top-level fallback: only when no authoritative structured body supplies
 *   address semantics (no rich_text and no mrkdwn-protocol blocks).
 */
export function slackEventMentionsUserId(
  input: SlackMessageTextInput,
  userId: string | undefined,
): boolean {
  if (!userId) return false;
  if (Array.isArray(input.blocks) && input.blocks.length > 0) {
    if (blocksContainUserEntity(input.blocks, userId)) return true;
    if (mrkdwnProtocolMentionsUserOutsideCode(input.blocks, userId)) return true;
    // Structured body already defined address protocol — do not regex its render.
    if (blocksSupplyAddressProtocol(input.blocks)) return false;
  }
  return slackMrkdwnMentionsUserIdOutsideCode(input.text, userId);
}

/** Mention tokens in mrkdwn outside inline/fenced code (`<@U…>` only). */
export function slackTextMentionsUserId(text: string | undefined, userId: string | undefined): boolean {
  if (!userId) return false;
  return slackMrkdwnMentionsUserIdOutsideCode(text, userId);
}

function slackMrkdwnMentionsUserIdOutsideCode(
  text: string | undefined,
  userId: string,
): boolean {
  if (!text) return false;
  return mentionTokenPattern(userId).test(stripSlackCodeRegions(text));
}

/**
 * Scan textual mrkdwn sources only: `markdown` blocks and nested `{ type: "mrkdwn" }`
 * objects. Never treat rich_text text nodes as mrkdwn.
 */
function mrkdwnProtocolMentionsUserOutsideCode(blocks: unknown[], userId: string): boolean {
  const walk = (value: unknown, insideRichText: boolean): boolean => {
    if (Array.isArray(value)) {
      return value.some((item) => walk(item, insideRichText));
    }
    const node = record(value);
    if (!node) return false;
    if (node['type'] === 'rich_text') {
      return walk(node['elements'], true);
    }
    if (!insideRichText) {
      if (node['type'] === 'markdown') {
        if (slackMrkdwnMentionsUserIdOutsideCode(stringField(node, 'text'), userId)) return true;
      }
      if (node['type'] === 'mrkdwn') {
        if (slackMrkdwnMentionsUserIdOutsideCode(stringField(node, 'text'), userId)) return true;
      }
    }
    // Nested containers (section.text, context.elements, fields, accessory…).
    if (walk(node['text'], insideRichText)) return true;
    if (walk(node['elements'], insideRichText)) return true;
    if (walk(node['fields'], insideRichText)) return true;
    if (walk(node['accessory'], insideRichText)) return true;
    if (walk(node['rows'], insideRichText)) return true;
    return false;
  };
  return walk(blocks, false);
}

/** Structured rich_text `user` elements only — never text/code content. */
function blocksContainUserEntity(blocks: unknown[], userId: string): boolean {
  const wanted = userId.toUpperCase();
  const walk = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(walk);
    const node = record(value);
    if (!node) return false;
    if (node['type'] === 'user') {
      const id = stringField(node, 'user_id');
      return Boolean(id && id.toUpperCase() === wanted);
    }
    // Containers only — do not treat `text` fields as mention entities.
    if (walk(node['elements'])) return true;
    if (walk(node['rows'])) return true;
    if (walk(node['fields'])) return true;
    if (walk(node['accessory'])) return true;
    return false;
  };
  return walk(blocks);
}

/** rich_text and/or mrkdwn-protocol blocks already define how address is read. */
function blocksSupplyAddressProtocol(blocks: unknown[]): boolean {
  const walk = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(walk);
    const node = record(value);
    if (!node) return false;
    const type = node['type'];
    if (type === 'rich_text' || type === 'markdown' || type === 'mrkdwn') return true;
    if (walk(node['text'])) return true;
    if (walk(node['elements'])) return true;
    if (walk(node['fields'])) return true;
    if (walk(node['accessory'])) return true;
    return false;
  };
  return walk(blocks);
}

/** Remove fenced and inline code so literal `<@U…>` inside code cannot false-wake. */
function stripSlackCodeRegions(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ');
}

function mentionTokenPattern(userId: string): RegExp {
  const escaped = userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<@${escaped}(?:\\|[^>]*)?>`, 'i');
}

export function slackMessageTextFromBlocks(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined;
  const rendered: string[] = [];
  for (const block of blocks) {
    const text = renderBlock(block);
    if (text.length > 0) rendered.push(text);
  }
  return rendered.length > 0 ? rendered.join('\n\n') : undefined;
}

function renderBlock(value: unknown): string {
  const block = record(value);
  if (!block) return unsupported('block', value);
  switch (block['type']) {
    case 'actions':
      return '';
    case 'divider':
      return '---';
    case 'header':
      return readableNodeText(block) ?? unsupported('block', block);
    case 'markdown':
      return stringField(block, 'text') ?? unsupported('block', block);
    case 'rich_text':
      return renderRichTextElements(block['elements']);
    case 'table':
      return renderTable(block['rows']);
    default:
      return readableNodeText(block) ?? unsupported('block', block);
  }
}

function renderRichTextElements(value: unknown): string {
  if (!Array.isArray(value)) return unsupported('rich text element', value);
  let output = '';
  let previousWasBlock = false;
  for (const element of value) {
    const text = renderRichTextElement(element);
    const currentWasBlock = record(element)?.['type'] !== 'rich_text_section';
    if (
      output.length > 0
      && !output.endsWith('\n')
      && !text.startsWith('\n')
      && (previousWasBlock || currentWasBlock)
    ) {
      output += '\n';
    }
    output += text;
    previousWasBlock = currentWasBlock;
  }
  return output;
}

function renderRichTextElement(value: unknown): string {
  const element = record(value);
  if (!element) return unsupported('rich text element', value);
  switch (element['type']) {
    case 'rich_text_section':
      return renderInlineElements(element['elements']);
    case 'rich_text_list':
      return renderList(element);
    case 'rich_text_preformatted': {
      const text = renderInlineElements(element['elements']);
      return `\`\`\`\n${text}\n\`\`\``;
    }
    case 'rich_text_quote': {
      const text = renderInlineElements(element['elements']);
      return text.split('\n').map((line) => `> ${line}`).join('\n');
    }
    default:
      return readableNodeText(element) ?? unsupported('rich text element', element);
  }
}

function renderInlineElements(value: unknown): string {
  if (!Array.isArray(value)) return unsupported('inline element', value);
  const parts: string[] = [];
  for (const element of value) {
    parts.push(renderInlineElement(element));
  }
  return parts.join('');
}

function renderInlineElement(value: unknown): string {
  const element = record(value);
  if (!element) return unsupported('inline element', value);
  const type = element['type'];
  let text: string | undefined;
  switch (type) {
    case 'text':
      text = stringField(element, 'text');
      break;
    case 'user': {
      const userId = stringField(element, 'user_id');
      text = userId ? `<@${userId}>` : undefined;
      break;
    }
    case 'channel': {
      const channelId = stringField(element, 'channel_id');
      text = channelId ? `<#${channelId}>` : undefined;
      break;
    }
    case 'link': {
      const url = stringField(element, 'url');
      const label = stringField(element, 'text');
      if (url) text = label && label !== url ? `<${url}|${label}>` : `<${url}>`;
      break;
    }
    case 'emoji': {
      const name = stringField(element, 'name');
      text = name ? `:${name}:` : undefined;
      break;
    }
    case 'broadcast': {
      const range = stringField(element, 'range');
      text = range ? `<!${range}>` : undefined;
      break;
    }
    case 'usergroup': {
      const usergroupId = stringField(element, 'usergroup_id');
      text = usergroupId ? `<!subteam^${usergroupId}>` : undefined;
      break;
    }
    case 'date':
      text = stringField(element, 'fallback');
      break;
    case 'color':
      text = stringField(element, 'value');
      break;
    default:
      text = readableNodeText(element);
      break;
  }
  const rendered = text ?? readableNodeText(element) ?? unsupported('inline element', element);
  return applyStyle(rendered, element['style']);
}

function renderList(element: Record<string, unknown>): string {
  const entries = element['elements'];
  if (!Array.isArray(entries)) return unsupported('rich text element', element);
  const ordered = element['style'] === 'ordered';
  const indent = typeof element['indent'] === 'number' && Number.isFinite(element['indent'])
    ? Math.max(0, Math.floor(element['indent']))
    : 0;
  const prefixIndent = '  '.repeat(indent);
  const lines: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = renderRichTextElement(entries[index]);
    const marker = ordered ? `${index + 1}. ` : '- ';
    const continuationIndent = `${prefixIndent}${' '.repeat(marker.length)}`;
    const [first = '', ...rest] = entry.split('\n');
    lines.push(`${prefixIndent}${marker}${first}`);
    lines.push(...rest.map((line) => `${continuationIndent}${line}`));
  }
  return lines.join('\n');
}

function renderTable(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return unsupported('block', { type: 'table' });
  const rows: string[][] = [];
  for (const rawRow of value) {
    if (!Array.isArray(rawRow) || rawRow.length === 0) {
      rows.push([unsupported('table row', rawRow)]);
      continue;
    }
    const row: string[] = [];
    for (const cell of rawRow) {
      const rendered = renderBlock(cell);
      row.push(rendered.replace(/\|/g, '\\|').replace(/\n/g, '<br>'));
    }
    rows.push(row);
  }
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array<string>(width - row.length).fill('')]);
  const lines = normalized.map((row) => `| ${row.join(' | ')} |`);
  lines.splice(1, 0, `| ${Array<string>(width).fill('---').join(' | ')} |`);
  return lines.join('\n');
}

function readableNodeText(value: Record<string, unknown>): string | undefined {
  const directText = stringField(value, 'text');
  if (directText) return directText;
  const nestedText = record(value['text']);
  const nestedTextValue = nestedText && stringField(nestedText, 'text');
  if (nestedTextValue) return nestedTextValue;
  const altText = stringField(value, 'alt_text');
  if (altText) return altText;
  const url = stringField(value, 'url') ?? stringField(value, 'image_url');
  return url || undefined;
}

function unsupported(scope: string, value: unknown): string {
  const type = record(value)?.['type'];
  return `[unsupported ${scope}: ${typeof type === 'string' && type.length > 0 ? type : 'unknown'}]`;
}

function applyStyle(text: string, value: unknown): string {
  const style = record(value);
  if (!style) return text;
  let rendered = text;
  if (style['code'] === true) rendered = `\`${rendered}\``;
  if (style['bold'] === true) rendered = `**${rendered}**`;
  if (style['italic'] === true) rendered = `*${rendered}*`;
  if (style['strike'] === true) rendered = `~~${rendered}~~`;
  return rendered;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}
