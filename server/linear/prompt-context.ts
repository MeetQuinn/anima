/**
 * Linear's `promptContext` is markup written for models: the issue, the thread that
 * opened the session, other threads and guidance, each in its own element. Agents get it
 * unchanged. People read this rendering in the dashboard instead: the issue and its
 * threads as Markdown, without the markup, Linear's boilerplate request or guidance.
 *
 * Only the documented shape is rendered. Anything else, including a body that closes its
 * own element early, shows the context exactly as Linear sent it, so nothing is hidden.
 */
export function linearSessionDisplayText(context: string): string {
  try {
    return renderBlocks(context) ?? context;
  } catch {
    return context;
  }
}

interface Element { name: string; attrs: Record<string, string>; body: string; end: number }

const OPEN = /<([a-z][a-z-]*)((?:\s+[a-z][a-z-]*="[^"]*")*)\s*(\/?)>/y;

/** Reads the element starting at `start` (after whitespace), or undefined when there is none. */
function readElement(source: string, start: number): Element | undefined {
  let at = start;
  while (at < source.length && /\s/.test(source[at]!)) at += 1;
  OPEN.lastIndex = at;
  const open = OPEN.exec(source);
  if (!open) return undefined;
  const [, name, rawAttrs = '', selfClosing] = open;
  const attrs: Record<string, string> = {};
  for (const [, key, value] of rawAttrs.matchAll(/([a-z][a-z-]*)="([^"]*)"/g)) attrs[key!] = decode(value!);
  if (selfClosing) return { name: name!, attrs, body: '', end: OPEN.lastIndex };
  // Bodies are not escaped markup, so the first closing tag ends them. A nested element of
  // the same name (none is documented) would end early and fail the parse below.
  const close = source.indexOf(`</${name}>`, OPEN.lastIndex);
  if (close < 0) throw new Error(`unclosed <${name}>`);
  return { name: name!, attrs, body: source.slice(OPEN.lastIndex, close), end: close + name!.length + 3 };
}

/** All elements in `source`, which must hold nothing else but whitespace. */
function readElements(source: string): Element[] {
  const elements: Element[] = [];
  let at = 0;
  for (;;) {
    const element = readElement(source, at);
    if (!element) break;
    elements.push(element);
    at = element.end;
  }
  if (source.slice(at).trim()) throw new Error('unexpected content');
  return elements;
}

function decode(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, entity: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[entity]!);
}

/** Comment bodies mark mentions as `<user id="…">name</user>`. */
function commentText(body: string): string {
  return body.replace(/<user id="[^"]*">([^<]*)<\/user>/g, (_, name: string) => `@${name}`).trim();
}

function renderIssue(issue: Element, key: string | undefined): string {
  let title = '', description = '';
  const labels: string[] = [], context: string[] = [];
  for (const part of readElements(issue.body)) {
    if (part.name === 'title') title = part.body.trim();
    else if (part.name === 'description') description = part.body.trim();
    else if (part.name === 'team') continue; // The agent's team access already scopes its work.
    else if (part.name === 'label') labels.push(part.body.trim());
    else if (part.name === 'parent-issue') {
      const parent = readElements(part.body);
      const parentTitle = parent.find((p) => p.name === 'title')?.body.trim();
      const parentDescription = parent.find((p) => p.name === 'description')?.body.trim();
      if (parent.some((p) => p.name !== 'title' && p.name !== 'description')) throw new Error('unexpected parent content');
      context.push([`Parent issue ${part.attrs.identifier ?? ''}${parentTitle ? `: ${parentTitle}` : ''}`.trim(), parentDescription].filter(Boolean).join('\n'));
    } else if (part.name === 'project') {
      context.push([`Project: ${part.attrs.name ?? ''}`.trim(), part.body.trim()].filter(Boolean).join('\n'));
    } else throw new Error(`unexpected <${part.name}> in issue`);
  }
  const facts = labels.length > 0 ? `Labels: ${labels.join(', ')}` : '';
  const heading = [key, title].filter(Boolean).join(' · ');
  return [heading && `**${heading}**`, facts, description, ...context].filter(Boolean).join('\n\n');
}

function renderThread(thread: Element, heading: string): string {
  const comments = readElements(thread.body).map((comment) => {
    if (comment.name !== 'comment') throw new Error(`unexpected <${comment.name}> in thread`);
    const who = comment.attrs.author ?? 'Unknown author';
    const when = comment.attrs['created-at'] ? ` (${shortTime(comment.attrs['created-at'])})` : '';
    return `${who}${when}: ${commentText(comment.body)}`;
  });
  return comments.length > 0 ? `${heading}\n${comments.join('\n\n')}` : '';
}

function shortTime(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z');
}

/** Guidance instructs the agent; people set it in Linear and do not need it repeated. */
function checkGuidance(guidance: Element): void {
  for (const rule of readElements(guidance.body)) {
    if (rule.name !== 'guidance-rule') throw new Error(`unexpected <${rule.name}> in guidance`);
  }
}

function renderBlocks(context: string): string | undefined {
  const blocks = readElements(context);
  if (blocks.length === 0) return undefined;
  const parts: string[] = [];
  let issueKey: string | undefined;
  for (const block of blocks) {
    if (block.name === 'issue') {
      issueKey = block.attrs.identifier;
      parts.push(renderIssue(block, issueKey));
    } else if (block.name === 'primary-directive-thread') parts.push(renderThread(block, 'Thread:'));
    else if (block.name === 'other-thread') parts.push(renderThread(block, 'Another thread on the issue:'));
    else if (block.name === 'guidance') checkGuidance(block);
    else if (block.name === 'user-request') {
      const request = commentText(block.body);
      // Linear's request for a plain delegation only repeats the issue key.
      if (request && request !== `Work on ${issueKey}`) parts.push(`Request: ${request}`);
    } else return undefined;
  }
  return parts.filter(Boolean).join('\n\n');
}
