export interface SlackMessageTextInput {
  blocks?: unknown;
  text?: string;
}

// Slack's top-level text is an accessibility/notification fallback. For rich
// messages it can be shorter than the body Slack renders from blocks, so use
// blocks only when every block is a supported message-content block.
export function slackVisibleMessageText(input: SlackMessageTextInput): string | undefined {
  return slackMessageTextFromBlocks(input.blocks) ?? input.text;
}

export function slackMessageTextFromBlocks(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined;
  const rendered: string[] = [];
  for (const block of blocks) {
    const text = renderBlock(block);
    if (text === undefined) return undefined;
    if (text.length > 0) rendered.push(text);
  }
  return rendered.length > 0 ? rendered.join('\n\n') : undefined;
}

function renderBlock(value: unknown): string | undefined {
  const block = record(value);
  if (!block) return undefined;
  if (block['type'] === 'markdown') return stringField(block, 'text');
  if (block['type'] === 'rich_text') return renderRichTextElements(block['elements']);
  if (block['type'] === 'table') return renderTable(block['rows']);
  return undefined;
}

function renderRichTextElements(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  let output = '';
  let previousWasBlock = false;
  for (const element of value) {
    const text = renderRichTextElement(element);
    if (text === undefined) return undefined;
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

function renderRichTextElement(value: unknown): string | undefined {
  const element = record(value);
  if (!element) return undefined;
  switch (element['type']) {
    case 'rich_text_section':
      return renderInlineElements(element['elements']);
    case 'rich_text_list':
      return renderList(element);
    case 'rich_text_preformatted': {
      const text = renderInlineElements(element['elements']);
      return text === undefined ? undefined : `\`\`\`\n${text}\n\`\`\``;
    }
    case 'rich_text_quote': {
      const text = renderInlineElements(element['elements']);
      return text === undefined ? undefined : text.split('\n').map((line) => `> ${line}`).join('\n');
    }
    default:
      return undefined;
  }
}

function renderInlineElements(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const element of value) {
    const text = renderInlineElement(element);
    if (text === undefined) return undefined;
    parts.push(text);
  }
  return parts.join('');
}

function renderInlineElement(value: unknown): string | undefined {
  const element = record(value);
  if (!element) return undefined;
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
      if (!url) return undefined;
      const label = stringField(element, 'text');
      text = label && label !== url ? `<${url}|${label}>` : `<${url}>`;
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
      return undefined;
  }
  return text === undefined ? undefined : applyStyle(text, element['style']);
}

function renderList(element: Record<string, unknown>): string | undefined {
  const entries = element['elements'];
  if (!Array.isArray(entries)) return undefined;
  const ordered = element['style'] === 'ordered';
  const indent = typeof element['indent'] === 'number' && Number.isFinite(element['indent'])
    ? Math.max(0, Math.floor(element['indent']))
    : 0;
  const prefixIndent = '  '.repeat(indent);
  const lines: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = renderRichTextElement(entries[index]);
    if (entry === undefined) return undefined;
    const marker = ordered ? `${index + 1}. ` : '- ';
    const continuationIndent = `${prefixIndent}${' '.repeat(marker.length)}`;
    const [first = '', ...rest] = entry.split('\n');
    lines.push(`${prefixIndent}${marker}${first}`);
    lines.push(...rest.map((line) => `${continuationIndent}${line}`));
  }
  return lines.join('\n');
}

function renderTable(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const rows: string[][] = [];
  for (const rawRow of value) {
    if (!Array.isArray(rawRow) || rawRow.length === 0) return undefined;
    const row: string[] = [];
    for (const cell of rawRow) {
      const rendered = renderBlock(cell);
      if (rendered === undefined) return undefined;
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
