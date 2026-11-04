/**
 * Linear's `promptContext` is markup written for models: the issue, the thread that
 * opened the session, other threads and guidance, each in its own element. Earlier inbox
 * items stored it unchanged. People read those items in the dashboard as the issue and its
 * threads as Markdown, without the markup, Linear's boilerplate request or guidance.
 *
 * Only the documented shape is rendered: known elements, known attributes, and one of each
 * element that is not a list. Anything else, including a body that closes its own element
 * early, shows the context exactly as Linear sent it, so nothing is hidden.
 */
export function linearSessionDisplayText(context: string): string {
  try {
    return renderBlocks(context) ?? context;
  } catch {
    return context;
  }
}

interface Element { name: string; attrs: Record<string, string>; body: string; end: number }

/** The attributes each documented element may carry. */
const ATTRIBUTES: Record<string, readonly string[]> = {
  issue: ['identifier'], title: [], description: [], team: ['name'], label: [], 'parent-issue': ['identifier'],
  project: ['name'], 'primary-directive-thread': ['comment-id'], 'other-thread': ['comment-id'],
  comment: ['author', 'created-at'], guidance: [], 'guidance-rule': ['origin', 'team-name'], 'user-request': [],
};

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
  for (const [, key, value] of rawAttrs.matchAll(/([a-z][a-z-]*)="([^"]*)"/g)) {
    if (key! in attrs) throw new Error(`repeated ${key} on <${name}>`);
    attrs[key!] = decode(value!);
  }
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

/**
 * The child elements of `source`, each allowed `once` or `many` times and carrying only its
 * documented attributes. Anything else would be dropped or overwritten, so it fails instead.
 */
function children(source: string, allowed: Record<string, 'once' | 'many'>): Element[] {
  const elements = readElements(source), seen = new Set<string>();
  for (const element of elements) {
    if (!Object.hasOwn(allowed, element.name)) throw new Error(`unexpected <${element.name}>`);
    if (allowed[element.name] === 'once' && seen.has(element.name)) throw new Error(`repeated <${element.name}>`);
    seen.add(element.name);
    const known = ATTRIBUTES[element.name] ?? [];
    if (Object.keys(element.attrs).some((key) => !known.includes(key))) throw new Error(`unexpected attribute on <${element.name}>`);
  }
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
  const parts = children(issue.body, { title: 'once', description: 'once', team: 'once', label: 'many', 'parent-issue': 'once', project: 'once' });
  for (const part of parts) {
    if (part.name === 'title') title = part.body.trim();
    else if (part.name === 'description') description = part.body.trim();
    else if (part.name === 'team') {
      // The agent's team access already scopes its work; only an empty team is documented.
      if (part.body.trim()) throw new Error('unexpected team content');
    } else if (part.name === 'label') labels.push(part.body.trim());
    else if (part.name === 'parent-issue') {
      const parent = children(part.body, { title: 'once', description: 'once' });
      const parentTitle = parent.find((p) => p.name === 'title')?.body.trim();
      const parentDescription = parent.find((p) => p.name === 'description')?.body.trim();
      context.push([`Parent issue ${part.attrs.identifier ?? ''}${parentTitle ? `: ${parentTitle}` : ''}`.trim(), parentDescription].filter(Boolean).join('\n'));
    } else context.push([`Project: ${part.attrs.name ?? ''}`.trim(), part.body.trim()].filter(Boolean).join('\n'));
  }
  const facts = labels.length > 0 ? `Labels: ${labels.join(', ')}` : '';
  const heading = [key, title].filter(Boolean).join(' · ');
  return [heading && `**${heading}**`, facts, description, ...context].filter(Boolean).join('\n\n');
}

function renderThread(thread: Element, heading: string): string {
  const comments = children(thread.body, { comment: 'many' }).map((comment) => {
    const who = comment.attrs.author ?? 'Unknown author';
    const when = comment.attrs['created-at'] ? ` (${shortTime(comment.attrs['created-at'])})` : '';
    return `${who}${when}: ${commentText(comment.body)}`;
  });
  return comments.length > 0 ? `${heading}\n${comments.join('\n\n')}` : '';
}

// Only a time with its zone is normalized; one without (Linear's own example has none) would
// otherwise be read in the server's zone and shown as UTC.
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function shortTime(value: string): string {
  const time = ZONED_TIME.test(value) ? Date.parse(value.replace(' ', 'T')) : Number.NaN;
  return Number.isNaN(time) ? value : new Date(time).toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z');
}

/** Guidance instructs the agent; people set it in Linear and do not need it repeated. */
function checkGuidance(guidance: Element): void {
  children(guidance.body, { 'guidance-rule': 'many' });
}

function renderBlocks(context: string): string | undefined {
  const blocks = children(context, { issue: 'once', 'primary-directive-thread': 'once', 'other-thread': 'many', guidance: 'once', 'user-request': 'once' });
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
    }
  }
  return parts.filter(Boolean).join('\n\n');
}
