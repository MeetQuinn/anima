import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, ShieldOff, X } from 'lucide-react';
import type { SlackUserCandidate } from '@shared/agent-config';
import type { ContactWorkspace } from '@shared/do-not-contact';
import { changeContactMember, fetchContactDirectory, fetchContactWorkspaces } from '@/api/do-not-contact';
import ConfirmModal from './ConfirmModal';

const workspacesKey = ['do-not-contact'] as const;

// Editorial ledger: the section reads like a masthead (serif title, caps labels)
// over a ruled list. Touch floor is the pair `min-h-[44px] md:min-h-[<natural>px]`.
const capsClass = 'font-sans text-[10px] font-medium uppercase tracking-widest text-text-subtle';
const focusClass = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';
const controlClass = `min-h-[44px] rounded-sm border border-border-soft bg-surface px-3 text-[12px] text-text md:min-h-[32px] ${focusClass}`;
const actionClass = `${controlClass} inline-flex items-center gap-1.5 hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-50`;
const quietActionClass = `inline-flex min-h-[44px] items-center rounded-sm px-2 text-[11px] text-text-muted underline-offset-4 hover:text-accent hover:underline md:min-h-[28px] ${focusClass}`;

export default function DoNotContactSection() {
  const query = useQuery({ queryKey: workspacesKey, queryFn: fetchContactWorkspaces, retry: false });
  const [selectedId, setSelectedId] = useState('');
  const workspaces = query.data ?? [];
  const selected = workspaces.find((workspace) => workspace.id === selectedId) ?? workspaces[0];

  return (
    <section aria-labelledby="contact-list-title" className="px-4 py-5 md:px-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 id="contact-list-title" className="font-serif text-[18px] font-semibold leading-tight text-text">Do not contact</h3>
          <p className="mt-1.5 text-[12px] leading-relaxed text-text-muted">
            Applies to all agents in this Anima instance connected to the selected Slack workspace.
          </p>
        </div>
        <ShieldOff aria-hidden className="mt-1 h-4 w-4 shrink-0 text-text-subtle" />
      </header>

      {query.isPending && <p role="status" className="mt-5 text-[12px] text-text-muted">Loading list…</p>}
      {query.isError && (
        <div role="alert" className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-l-2 border-health-error pl-3 text-[12px] leading-relaxed text-health-error">
          <span className="min-w-0 flex-1">Could not load the do-not-contact list. Existing restrictions have not been changed.</span>
          <button type="button" className={actionClass} onClick={() => void query.refetch()}>Retry</button>
        </div>
      )}
      {!query.isPending && !query.isError && workspaces.length === 0 && (
        <p className="mt-5 border-t border-border-soft pt-4 text-[12px] text-text-muted">Connect an agent to Slack to manage a workspace’s list.</p>
      )}

      {selected && !query.isError && (
        <>
          <dl className="mt-5 grid grid-cols-[72px_1fr] items-baseline gap-x-4 border-t border-border-strong pt-4">
            <dt className={`pt-0.5 ${capsClass}`}>Workspace</dt>
            <dd className="min-w-0">
              {workspaces.length > 1 ? (
                <select aria-label="Slack workspace" className={`${controlClass} block w-full`} value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}{workspace.name !== workspace.id ? ` · ${workspace.id}` : ''} ({workspace.memberIds.length})
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px] text-text">
                  <span className="truncate font-medium">{selected.name}</span>
                  {selected.name !== selected.id && <span className="font-mono text-[10px] text-text-subtle">{selected.id}</span>}
                </div>
              )}
            </dd>
          </dl>
          <WorkspaceMembers key={selected.id} workspace={selected} />
        </>
      )}

      <details className="mt-5 border-t border-border-soft text-[11px] leading-relaxed text-text-subtle">
        <summary className={`flex min-h-[44px] cursor-pointer list-none items-center gap-2 md:min-h-[32px] ${capsClass} hover:text-text-muted`}>
          <span aria-hidden className="inline-block h-px w-3 bg-border-strong" />What this blocks
        </summary>
        <p className="pb-2 pl-5">Blocks Anima-tool DMs, group DMs containing a listed member, and @mentions of listed members. Does not block incoming messages or ordinary channel posts. Changes apply immediately; no restart needed.</p>
      </details>
    </section>
  );
}

function WorkspaceMembers({ workspace }: { workspace: ContactWorkspace }) {
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
      setNotice(change.action === 'add' ? 'Member added. Restriction is active.' : 'Member removed. Restriction lifted.');
      setConfirm(null);
      setSearch('');
      await client.invalidateQueries({ queryKey: workspacesKey });
    },
  });
  const users = directory.data?.users ?? [];
  // Unresolved IDs stay on the list: they are shown as the bare ID, never dropped.
  const members = workspace.memberIds.map((id) => users.find((user) => user.slackUserId === id) ?? { slackUserId: id, displayName: id });
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
    <div className="mt-5">
      <div className="flex items-center justify-between gap-3 border-b border-border-strong pb-2">
        <span className={capsClass}>
          <span className="font-mono text-[12px] tracking-normal text-text">{count}</span>{' '}{count === 1 ? 'member' : 'members'}
        </span>
        <button type="button" className={actionClass} disabled={!workspace.canLookup} aria-expanded={searching} onClick={() => setSearching(!searching)}>
          {searching ? <X aria-hidden className="h-3.5 w-3.5" /> : <Plus aria-hidden className="h-3.5 w-3.5" />}
          {searching ? 'Close search' : 'Add member'}
        </button>
      </div>

      {!workspace.canLookup && (
        <p role="status" className="mt-3 border-l-2 border-border-strong pl-3 text-[12px] leading-relaxed text-text-muted">
          No Slack connection is available for this workspace. Saved IDs remain restricted.
        </p>
      )}
      {directory.isError && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-l-2 border-health-error pl-3 text-[12px] leading-relaxed text-health-error">
          <span className="min-w-0 flex-1">Slack directory unavailable. Saved IDs remain restricted.</span>
          <button type="button" className={actionClass} onClick={() => void directory.refetch()}>Retry lookup</button>
        </div>
      )}

      {searching && (
        <div className="mt-3 rounded-sm border border-border-soft bg-surface-elevated">
          <label className="relative block">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-subtle" />
            <input
              aria-label="Search Slack members"
              className={`min-h-[44px] w-full min-w-0 border-b border-border-soft bg-transparent pl-9 pr-3 text-[13px] text-text placeholder:text-text-subtle md:min-h-[36px] ${focusClass}`}
              placeholder="Name or @username"
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {directory.isPending && workspace.canLookup && <p role="status" className="px-3 py-3 text-[12px] text-text-muted">Loading Slack members…</p>}
          {canAdd && (
            <ul aria-label="Slack search results" className="max-h-60 divide-y divide-border-soft overflow-y-auto">
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

      <ul aria-label="Do-not-contact members" className="divide-y divide-border-soft">
        {members.map((user) => (
          <li key={user.slackUserId} className="flex items-center gap-3 py-2 md:py-1.5">
            <MemberIdentity user={user} unresolvedNote={unresolvedNote} />
            <button type="button" aria-label={`Remove ${user.displayName}`} className={`${quietActionClass} ml-auto -mr-2 shrink-0`} onClick={() => ask('remove', user)}>Remove</button>
          </li>
        ))}
        {members.length === 0 && (
          <li className="py-5 text-center font-serif text-[13px] italic text-text-subtle">No members on this list.</li>
        )}
      </ul>
      {notice && (
        <p role="status" className="mt-3 flex items-center gap-2 text-[12px] text-text-muted">
          <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-health-ok" />{notice}
        </p>
      )}

      <ConfirmModal
        open={confirm !== null}
        title={confirm?.action === 'add' ? 'Add to do-not-contact list?' : 'Remove from do-not-contact list?'}
        description={confirm && <>
          <span className="mb-2 block font-medium">{confirm.user.displayName} <span className="font-mono text-[11px]">({confirm.user.slackUserId})</span></span>
          {confirm.action === 'add'
            ? `All agents in this Anima instance connected to ${workspace.name} will be restricted from contacting this member through Anima tools.`
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
    </div>
  );
}

function MemberIdentity({ user, unresolvedNote = 'Saved ID · still restricted' }: { user: SlackUserCandidate; unresolvedNote?: string }) {
  // Identity not found in the directory: displayName === ID. Present the ID as the name
  // in mono and say so, instead of a fake initial + duplicated ID line.
  const unresolved = user.displayName === user.slackUserId;
  return <>
    {user.avatarUrl ? (
      <img src={user.avatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-sm object-cover ring-1 ring-border-soft" />
    ) : (
      <span aria-hidden className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-sm ring-1 ring-border-soft ${unresolved ? 'bg-surface font-mono text-[10px] text-text-subtle' : 'bg-surface-elevated font-serif text-[14px] font-semibold text-text-muted'}`}>
        {unresolved ? '?' : user.displayName.trim().slice(0, 1).toLocaleUpperCase()}
      </span>
    )}
    <span className="min-w-0">
      {unresolved ? (
        <>
          <span className="block truncate font-mono text-[12px] text-text">{user.slackUserId}</span>
          <span className="block truncate text-[10px] text-text-subtle">{unresolvedNote}</span>
        </>
      ) : (
        <>
          <span className="block truncate text-[13px] font-medium leading-tight text-text">{user.displayName}</span>
          <span className="block truncate text-[10px] text-text-subtle">
            {user.handle && <span className="text-text-muted">@{user.handle}</span>}{user.handle && ' · '}<span className="font-mono">{user.slackUserId}</span>
          </span>
        </>
      )}
    </span>
  </>;
}
