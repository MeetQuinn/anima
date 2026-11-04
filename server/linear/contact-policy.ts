import { z } from 'zod';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { CONTACT_FAILURE_KIND, ContactPolicyRefusal, type ContactRefusal } from '../messages/contact-policy.service.js';
import { serverConfigStore } from '../storage/schema/server.store.js';
import { LinearApiError } from './client.js';
import type { LinearIdentityService } from './identity.service.js';

type LinearContactInput = {
  identity: LinearIdentityService;
  tool: string;
  /** Extra fields for the refusal's activity record. */
  payload?: Record<string, unknown>;
} & (
  /** Markdown the agent wrote. Code spans and fenced code blocks are not mentions. */
  | { markdown: string; document?: never }
  /** A raw API write. Every string counts, code included. */
  | { document: { query: string; variables: Record<string, unknown> }; markdown?: never }
);

type ListedPerson = { id: string; displayName: string; url?: string };

const Users = z.object({ users: z.object({ nodes: z.array(z.object({ id: z.string(), displayName: z.string(), url: z.string().nullish() })) }) });
const USERS_QUERY = 'query($ids:[ID!]) { users(filter:{id:{in:$ids}},first:250) { nodes { id displayName url } } }';

/**
 * Same rule as Slack: no direct outreach to a listed person; conversations are unaffected.
 * Refuses a write that @mentions, links the profile of, or carries the user ID of someone
 * on this organization's `linearDoNotContact` list. The ID covers assigning, delegating,
 * subscribing and mention nodes in API writes. A tool-layer constraint, not a sandbox.
 */
export async function assertLinearContactAllowed(input: LinearContactInput): Promise<void> {
  const refusal = await refusalReason(input);
  if (!refusal) return;
  await activityServiceForAgent(input.identity.agentId).record({
    type: 'tool.call.failed',
    payload: {
      tool: input.tool, platform: 'linear', ...input.payload,
      status: 'failed', failureKind: CONTACT_FAILURE_KIND[refusal.kind], error: refusal.message,
    },
  });
  throw new ContactPolicyRefusal(refusal.message, refusal.kind);
}

async function refusalReason(input: LinearContactInput): Promise<ContactRefusal | undefined> {
  let lists: Record<string, string[]>;
  try { lists = (await serverConfigStore.read()).linearDoNotContact ?? {}; }
  catch {
    // Do not expose config contents or silently weaken an unreadable policy.
    return {
      kind: 'config',
      message: 'Not sent. The do-not-contact configuration could not be read or is invalid. Ask your human owner to repair the host configuration before writing to Linear.',
    };
  }
  // No list anywhere: no installation read, no Linear call.
  if (!Object.values(lists).some((ids) => ids.length > 0)) return undefined;
  const { organizationId } = await input.identity.authorizedInstallation();
  const org = organizationId.toLowerCase();
  const blocked = [...new Set(Object.entries(lists).filter(([id]) => id.toLowerCase() === org).flatMap(([, ids]) => ids.map((id) => id.toLowerCase())))];
  if (blocked.length === 0) return undefined;

  const loose = input.document !== undefined;
  const text = loose ? `${input.document.query}\n${JSON.stringify(input.document.variables)}` : withoutCode(input.markdown);
  const lower = text.toLowerCase();
  const byId = blocked.find((id) => lower.includes(id));
  if (byId) {
    // Already refused; the name only helps the agent recognise who it was.
    const [person] = await listedPeople(input.identity, [byId]).catch(() => []);
    return listed(byId, person?.displayName);
  }
  // A mention needs `@displayName` or a profile URL; without either there is nothing to look up.
  if (!lower.includes('@') && !lower.includes('/profiles/')) return undefined;

  let people: ListedPerson[];
  try { people = await listedPeople(input.identity, blocked); }
  catch (error) { return unverified(error); }
  const person = people.find((candidate) => mentionPattern(candidate, loose).test(text));
  return person ? listed(person.id, person.displayName) : undefined;
}

async function listedPeople(identity: LinearIdentityService, ids: string[]): Promise<ListedPerson[]> {
  const people: ListedPerson[] = [];
  for (let i = 0; i < ids.length; i += 250) {
    const { users } = await identity.request(USERS_QUERY, { ids: ids.slice(i, i + 250) }, Users);
    for (const user of users.nodes) {
      if (ids.includes(user.id.toLowerCase())) people.push({ id: user.id.toLowerCase(), displayName: user.displayName.trim(), ...(user.url ? { url: user.url } : {}) });
    }
  }
  return people;
}

// Not part of a longer name or URL: `@nora` does not match `@nora2` or `@nora.bot`, but does before `.`, `,` or a space.
const ENDS = String.raw`(?![\p{L}\p{N}_-])(?!\.[\p{L}\p{N}_])`;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `loose` drops the left boundary for API documents, where JSON and GraphQL escapes
 * (`\n@nora`) put a letter right before the `@`.
 */
function mentionPattern(person: ListedPerson, loose: boolean): RegExp {
  const parts: string[] = [];
  if (person.displayName) parts.push(`${loose ? '' : String.raw`(?<![\p{L}\p{N}_])`}@${escape(person.displayName)}${ENDS}`);
  const url = person.url?.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (url) parts.push(`${escape(url)}${ENDS}`);
  return parts.length ? new RegExp(parts.join('|'), 'iu') : /(?!)/;
}

/**
 * Removes fenced code blocks and single-line code spans, the places where Linear shows
 * mention text literally. Anything unusual (an unclosed fence, an escaped backtick,
 * code in a list or quote) stays in and is checked.
 */
export function withoutCode(markdown: string): string {
  const out: string[] = [];
  let fence: { char: string; length: number; lines: string[] } | undefined;
  for (const line of markdown.split('\n')) {
    if (fence) {
      fence.lines.push(line);
      if (new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`).test(line)) { fence = undefined; out.push(''); }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1]!.startsWith('`') && open[2]!.includes('`'))) { fence = { char: open[1]![0]!, length: open[1]!.length, lines: [line] }; continue; }
    out.push(withoutCodeSpans(line));
  }
  if (fence) out.push(...fence.lines.map(withoutCodeSpans));
  return out.join('\n');
}

function withoutCodeSpans(line: string): string {
  return line.replace(/(?<![`\\])(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, ' ');
}

function listed(id: string, displayName?: string): ContactRefusal {
  const person = displayName ? `${displayName} (${id})` : id;
  return {
    kind: 'listed',
    message: `Not sent. ${person} is on this Linear workspace's do-not-contact list: they asked never to be contacted by agents. Do not @mention, assign, delegate or subscribe them, and do not try another command, agent or API call to reach them. If something needs to reach them, hand it to your human owner.`,
  };
}

/** Fail closed, but say what actually happened, so the agent does not read it as a do-not-contact match. */
function unverified(error: unknown): ContactRefusal {
  const cause = error instanceof LinearApiError && error.failure
    ? error.failure === 'http' ? `HTTP ${error.status}` : error.failure === 'network' ? 'connection failed' : 'invalid or rejected response'
    : 'lookup failed';
  return {
    kind: 'unverified',
    message: `Not sent. Could not look up the people on this Linear workspace's do-not-contact list (Linear: ${cause}), and writes that could mention someone are held while the list is active. This is a lookup failure, not a do-not-contact match: it does not mean anyone you mentioned is on the list. Retry shortly. If this keeps failing, tell your human owner.`,
  };
}
