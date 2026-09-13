import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, X } from 'lucide-react';
import type { SlackUserCandidate } from '@shared/agent-config';
import type { ContactWorkspace } from '@shared/do-not-contact';
import { changeContactMember, fetchContactDirectory, fetchContactWorkspaces } from '@/api/do-not-contact';
import ConfirmModal from '@/components/ConfirmModal';

const workspacesKey = ['do-not-contact'] as const;

// Policies › Outreach limits. One sentence says what the list does, one small
// line says where it applies; then every connected Slack workspace as a flat
// block (name · N people), never a switcher and never a workspace ID. Add is a
// `+` at the block header's end, Remove an `×` at the row's end: on desktop
// both wait for hover (or keyboard focus), on touch they are always there at
// 44px. Touch floor is the pair `min-h-[44px] md:min-h-[<natural>px]`.
//
// Wording red line: nothing here may imply agents have separate credentials
// or separate lists — the list is instance-wide, per workspace.
const focusClass = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';
const actionClass = `inline-flex min-h-[44px] items-center gap-1.5 rounded-sm border border-border-soft bg-surface px-3 text-[12px] text-text hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-50 md:min-h-[32px] ${focusClass}`;
// Hover-revealed icon control: invisible until its named group is hovered or
// holds focus, always visible where there is no hover (same `[@media(hover:none)]`
// convention as the KB copy buttons). 44px on narrow screens, 28px from md up.
// Literal strings on purpose: Tailwind only sees classes it can read verbatim.
const revealBase = `flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-[3px] text-text-subtle opacity-0 transition-opacity hover:bg-surface-raised hover:text-text focus-visible:opacity-100 disabled:cursor-not-allowed md:min-h-7 md:min-w-7 [@media(hover:none)]:opacity-100 ${focusClass}`;
const revealInWorkspace = `${revealBase} group-hover/ws:opacity-100 group-focus-within/ws:opacity-100 disabled:group-hover/ws:opacity-40 disabled:[@media(hover:none)]:opacity-40`;
const revealInRow = `${revealBase} group-hover/row:opacity-100 group-focus-within/row:opacity-100`;

export default function OutreachLimitsPage() {
  const query = useQuery({ queryKey: workspacesKey, queryFn: fetchContactWorkspaces, retry: false });
  const workspaces = query.data ?? [];

  return (
    <div>
      <p className="text-[13px] leading-relaxed text-text">
        Agents will not DM or @mention the people listed here. Incoming messages and ordinary channel posts are unaffected.
        <span className="mt-1.5 block text-[11px] leading-relaxed text-text-subtle">
          Applies to every agent in this Anima instance, per Slack workspace. Changes take effect immediately.
        </span>
      </p>

      {query.isPending && <p role="status" className="mt-6 border-t border-border-strong pt-4 text-[12px] text-text-muted">Loading list…</p>}
      {query.isError && (
        <div role="alert" className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-l-2 border-health-error pl-3 text-[12px] leading-relaxed text-health-error">
          <span className="min-w-0 flex-1">Could not load the do-not-contact list. Existing restrictions have not been changed.</span>
          <button type="button" className={actionClass} onClick={() => void query.refetch()}>Retry</button>
        </div>
      )}
      {!query.isPending && !query.isError && workspaces.length === 0 && (
        <p className="mt-6 border-t border-border-strong pt-4 text-[12px] text-text-muted">Connect an agent to Slack to manage a workspace’s list.</p>
      )}

      {!query.isError && workspaces.length > 0 && (
        <div className="mt-6 border-t border-border-strong">
          {workspaces.map((workspace) => (
            <WorkspaceBlock key={workspace.id} workspace={workspace} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceBlock({ workspace }: { workspace: ContactWorkspace }) {
  const client = useQueryClient();
  const directory = useQuery({
    queryKey: ['contact-directory', workspace.id], queryFn: () => fetchContactDirectory(workspace.id),
    enabled: workspace.canLookup, retry: false, staleTime: 60_000,
  });
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<{ action: 'add' | 'remove'; user: SlackUserCandidate } | null>(null);
  const mutation = useMutation({
    mutationFn: ({ action, user }: NonNullable<typeof confirm>) => changeContactMember(workspace.id, user.slackUserId, action),
    onSuccess: async (_result, change) => {
      setNotice(change.action === 'add' ? 'Added. Restriction is active.' : 'Removed. Restriction lifted.');
      setConfirm(null);
      setSearch('');
      await client.invalidateQueries({ queryKey: workspacesKey });
    },
  });
  const users = directory.data?.users ?? [];
  // Unresolved IDs stay on the list, never dropped. "Resolved" means the directory returned this
  // ID, decided from the lookup itself, not from the shape of the name (a directory may legitimately
  // fall back to displayName === slackUserId for a matched user).
  const members = workspace.memberIds.map((id) => {
    const found = users.find((user) => user.slackUserId === id);
    return found ? { user: found, resolved: true } : { user: { slackUserId: id, displayName: id }, resolved: false };
  });
  const available = users.filter((user) => !workspace.memberIds.includes(user.slackUserId));
  const term = search.trim().toLocaleLowerCase().replace(/^@/, '');
  const matches = available.filter((user) => `${user.displayName} ${user.handle ?? ''} ${user.slackUserId}`.toLocaleLowerCase().includes(term));
  const canAdd = workspace.canLookup && directory.isSuccess && !directory.isError;
  const count = members.length;
  // Only claim "not found" once the directory actually answered; before that the ID is simply saved.
  const unresolvedNote = directory.isSuccess ? 'Not found in the Slack directory · still restricted' : 'Saved ID · still restricted';
  function ask(action: 'add' | 'remove', user: SlackUserCandidate) {
    mutation.reset();
    setNotice('');
    setConfirm({ action, user });
  }

  return (
    <section aria-labelledby={`ws-${workspace.id}`} className="group/ws border-b border-border-soft py-4 last:border-b-0">
      <div className="flex min-h-7 items-center gap-2">
        <h2 id={`ws-${workspace.id}`} className="min-w-0 truncate text-[13px] font-semibold text-text">{workspace.name}</h2>
        <span className="ml-auto shrink-0 text-[11px] text-text-subtle">
          {count} {count === 1 ? 'person' : 'people'}
        </span>
        <button
          type="button"
          className={`${revealInWorkspace} -mr-2 md:-mr-1.5 ${searching ? 'opacity-100' : ''}`}
          disabled={!workspace.canLookup}
          aria-expanded={searching}
          aria-label={searching ? `Close search in ${workspace.name}` : `Add a person to ${workspace.name}`}
          title={searching ? 'Close search' : 'Add a person'}
          onClick={() => { setSearching(!searching); setSearch(''); }}
        >
          {searching ? <X aria-hidden className="h-3.5 w-3.5" /> : <Plus aria-hidden className="h-3.5 w-3.5" />}
        </button>
      </div>

      {!workspace.canLookup && (
        <p role="status" className="mt-2 border-l-2 border-border-strong pl-3 text-[12px] leading-relaxed text-text-muted">
          No Slack connection is available for this workspace. Saved IDs remain restricted.
        </p>
      )}
      {directory.isError && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-l-2 border-health-error pl-3 text-[12px] leading-relaxed text-health-error">
          <span className="min-w-0 flex-1">Slack directory unavailable. Saved IDs remain restricted.</span>
          <button type="button" className={actionClass} onClick={() => void directory.refetch()}>Retry lookup</button>
        </div>
      )}

      {searching && (
        <div className="mt-2 rounded-sm border border-border-soft bg-surface-elevated">
          <label className="relative block">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-subtle" />
            <input
              aria-label={`Search Slack members in ${workspace.name}`}
              className={`min-h-[44px] w-full min-w-0 border-b border-border-soft bg-transparent pl-9 pr-3 text-[13px] text-text placeholder:text-text-subtle md:min-h-[36px] ${focusClass}`}
              placeholder="Name or @username"
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {directory.isPending && workspace.canLookup && <p role="status" className="px-3 py-3 text-[12px] text-text-muted">Loading Slack members…</p>}
          {canAdd && (
            <ul aria-label={`Slack search results · ${workspace.name}`} className="max-h-60 divide-y divide-border-soft overflow-y-auto">
              {matches.slice(0, 50).map((user) => (
                <li key={user.slackUserId}>
                  <button type="button" className={`group flex min-h-[44px] w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-surface md:min-h-[40px] ${focusClass}`} onClick={() => ask('add', user)}>
                    <MemberIdentity user={user} />
                    <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-text-subtle group-hover:text-accent">
                      <Plus aria-hidden className="h-3 w-3" /> Add
                    </span>
                  </button>
                </li>
              ))}
              {matches.length === 0 && <li className="px-3 py-3 text-[12px] text-text-muted">No matching members.</li>}
              {matches.length > 50 && <li className="px-3 py-2 text-[11px] text-text-subtle">Keep typing to narrow the results.</li>}
            </ul>
          )}
        </div>
      )}

      {members.length > 0 ? (
        <ul aria-label={`Do-not-contact members · ${workspace.name}`} className="mt-1.5">
          {members.map(({ user, resolved }) => (
            <li key={user.slackUserId} className="group/row flex items-center gap-2.5 border-t border-border-soft py-1.5">
              <MemberIdentity user={user} unresolvedNote={resolved ? undefined : unresolvedNote} />
              <button
                type="button"
                aria-label={`Remove ${user.displayName}`}
                title="Remove"
                className={`${revealInRow} -mr-2 ml-auto md:-mr-1.5`}
                onClick={() => ask('remove', user)}
              >
                <X aria-hidden className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 border-t border-border-soft pb-1 pt-2.5 text-[12px] text-text-subtle">
          No one listed. Agents may contact anyone in this workspace.
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 flex items-center gap-2 text-[12px] text-text-muted">
          <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-health-ok" />{notice}
        </p>
      )}

      <ConfirmModal
        open={confirm !== null}
        title={confirm?.action === 'add' ? 'Add to do-not-contact list?' : 'Remove from do-not-contact list?'}
        description={confirm && <>
          <span className="mb-2 block font-medium">{confirm.user.displayName} <span className="font-mono text-[11px]">({confirm.user.slackUserId})</span></span>
          {confirm.action === 'add'
            ? `All agents in this Anima instance connected to ${workspace.name} will be restricted from contacting this person through Anima tools.`
            : `This lifts the restriction for all agents in this Anima instance connected to ${workspace.name}.`}
        </>}
        variant="warn"
        confirmVariant={confirm?.action === 'remove' ? 'destructive' : 'default'}
        confirmLabel={confirm?.action === 'add' ? 'Add member' : 'Remove member'}
        busy={mutation.isPending}
        error={mutation.error?.message}
        onCancel={() => { if (!mutation.isPending) setConfirm(null); }}
        onConfirm={() => { if (confirm && !mutation.isPending) mutation.mutate(confirm); }}
      />
    </section>
  );
}

/** `unresolvedNote` set = the directory did not return this ID; the caller decides that, never this component. */
function MemberIdentity({ user, unresolvedNote }: { user: SlackUserCandidate; unresolvedNote?: string }) {
  const unresolved = unresolvedNote !== undefined;
  return <>
    {user.avatarUrl ? (
      <img src={user.avatarUrl} alt="" className="h-7 w-7 shrink-0 rounded-[3px] object-cover ring-1 ring-border-soft" />
    ) : (
      <span aria-hidden className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[3px] ring-1 ring-border-soft ${unresolved ? 'bg-surface font-mono text-[10px] text-text-subtle' : 'bg-surface-elevated text-[12px] font-semibold text-text-muted'}`}>
        {unresolved ? '?' : user.displayName.trim().slice(0, 1).toLocaleUpperCase()}
      </span>
    )}
    <span className="min-w-0 leading-tight">
      {unresolved ? (
        <>
          <span className="block truncate font-mono text-[12px] text-text">{user.slackUserId}</span>
          <span className="block truncate text-[11px] text-text-subtle">{unresolvedNote}</span>
        </>
      ) : (
        <>
          <span className="block truncate text-[13px] text-text">{user.displayName}</span>
          <span className="block truncate text-[11px] text-text-subtle">
            {user.handle && <span className="text-text-muted">@{user.handle}</span>}{user.handle && ' · '}<span className="font-mono text-[10px]">{user.slackUserId}</span>
          </span>
        </>
      )}
    </span>
  </>;
}
