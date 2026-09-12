import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, ShieldOff } from 'lucide-react';
import type { SlackUserCandidate } from '@shared/agent-config';
import type { ContactWorkspace } from '@shared/do-not-contact';
import { changeContactMember, fetchContactDirectory, fetchContactWorkspaces } from '@/api/do-not-contact';
import ConfirmModal from './ConfirmModal';

const workspacesKey = ['do-not-contact'] as const;
const controlClass = 'min-h-[44px] rounded-sm border border-border-soft bg-surface px-3 text-[12px] text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent md:min-h-[32px]';
const actionClass = `${controlClass} hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-50`;

export default function DoNotContactSection() {
  const query = useQuery({ queryKey: workspacesKey, queryFn: fetchContactWorkspaces, retry: false });
  const [selectedId, setSelectedId] = useState('');
  const workspaces = query.data ?? [];
  const selected = workspaces.find((workspace) => workspace.id === selectedId) ?? workspaces[0];

  return (
    <section aria-labelledby="contact-list-title" className="px-4 py-5 md:px-6">
      <h3 id="contact-list-title" className="flex items-center gap-2 font-serif text-[18px] font-semibold text-text">
        <ShieldOff aria-hidden className="h-4 w-4 text-text-muted" /> Do not contact
      </h3>
      <p className="mt-2 text-[12px] leading-relaxed text-text-muted">
        Applies to all agents in this Anima instance connected to the selected Slack workspace.
      </p>
      {query.isPending && <p role="status" className="mt-4 text-[12px] text-text-muted">Loading list…</p>}
      {query.isError && (
        <div role="alert" className="mt-4 text-[12px] text-health-error">
          Could not load the do-not-contact list. Existing restrictions have not been changed.
          <button type="button" className={`${actionClass} ml-2`} onClick={() => void query.refetch()}>Retry</button>
        </div>
      )}
      {!query.isPending && !query.isError && workspaces.length === 0 && (
        <p className="mt-4 text-[12px] text-text-muted">Connect an agent to Slack to manage a workspace’s list.</p>
      )}
      {selected && !query.isError && (
        <>
          <div className="mt-4">
            {workspaces.length > 1 ? (
              <label className="block text-[11px] text-text-muted">
                Slack workspace
                <select className={`${controlClass} mt-1 block w-full`} value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
                  {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}{workspace.name !== workspace.id ? ` · ${workspace.id}` : ''} ({workspace.memberIds.length})</option>)}
                </select>
              </label>
            ) : (
              <div className="text-[12px] text-text">
                {selected.name} {selected.name !== selected.id && <span className="ml-1 font-mono text-[10px] text-text-subtle">{selected.id}</span>}
              </div>
            )}
          </div>
          <WorkspaceMembers key={selected.id} workspace={selected} />
        </>
      )}
      <details className="mt-4 text-[11px] leading-relaxed text-text-subtle">
        <summary className="min-h-[44px] cursor-pointer py-2 md:min-h-[28px]">What this blocks</summary>
        <p>Blocks Anima-tool DMs, group DMs containing a listed member, and @mentions of listed members. Does not block incoming messages or ordinary channel posts. Changes apply immediately; no restart needed.</p>
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
  const members = workspace.memberIds.map((id) => users.find((user) => user.slackUserId === id) ?? { slackUserId: id, displayName: id });
  const available = users.filter((user) => !workspace.memberIds.includes(user.slackUserId));
  const term = search.trim().toLocaleLowerCase().replace(/^@/, '');
  const matches = available.filter((user) => `${user.displayName} ${user.handle ?? ''} ${user.slackUserId}`.toLocaleLowerCase().includes(term));
  const canAdd = workspace.canLookup && directory.isSuccess && !directory.isError;
  function ask(action: 'add' | 'remove', user: SlackUserCandidate) {
    mutation.reset();
    setNotice('');
    setConfirm({ action, user });
  }

  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[11px] text-text-muted">{members.length} {members.length === 1 ? 'member' : 'members'}</span>
        <button type="button" className={`${actionClass} inline-flex items-center gap-1.5`} disabled={!workspace.canLookup} aria-expanded={searching} onClick={() => setSearching(!searching)}>
          <Plus aria-hidden className="h-3.5 w-3.5" /> {searching ? 'Close search' : 'Add member'}
        </button>
      </div>
      {!workspace.canLookup && <p role="status" className="mb-3 text-[12px] text-text-muted">No Slack connection is available for this workspace. Saved IDs remain restricted.</p>}
      {directory.isError && (
        <div role="alert" className="mb-3 text-[12px] text-health-error">
          Slack directory unavailable. Saved IDs remain restricted.
          <button type="button" className={`${actionClass} ml-2`} onClick={() => void directory.refetch()}>Retry lookup</button>
        </div>
      )}
      {searching && (
        <div className="mb-3 rounded-sm border border-border-soft bg-surface-elevated p-3">
          <label className="flex items-center gap-2">
            <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            <input aria-label="Search Slack members" className={`${controlClass} w-full min-w-0`} placeholder="Name or @username" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          {directory.isPending && workspace.canLookup && <p role="status" className="mt-3 text-[12px] text-text-muted">Loading Slack members…</p>}
          {canAdd && (
            <ul aria-label="Slack search results" className="mt-2 max-h-52 overflow-y-auto">
              {matches.slice(0, 50).map((user) => (
                <li key={user.slackUserId}>
                  <button type="button" className="flex min-h-[44px] w-full items-center gap-2 rounded-sm px-1 py-2 text-left hover:bg-surface focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent" onClick={() => ask('add', user)}>
                    <MemberIdentity user={user} />
                    <Plus aria-hidden className="ml-auto h-3.5 w-3.5 shrink-0 text-text-muted" />
                  </button>
                </li>
              ))}
              {matches.length === 0 && <li className="py-3 text-[12px] text-text-muted">No matching members.</li>}
              {matches.length > 50 && <li className="py-2 text-[11px] text-text-subtle">Keep typing to narrow the results.</li>}
            </ul>
          )}
        </div>
      )}
      <ul aria-label="Do-not-contact members" className="divide-y divide-border-soft rounded-sm border border-border-soft">
        {members.map((user) => (
          <li key={user.slackUserId} className="flex items-center gap-3 px-3 py-2">
            <MemberIdentity user={user} />
            <button type="button" aria-label={`Remove ${user.displayName}`} className={`${actionClass} ml-auto shrink-0`} onClick={() => ask('remove', user)}>Remove</button>
          </li>
        ))}
        {members.length === 0 && <li className="px-3 py-4 text-[12px] text-text-muted">No members on this list.</li>}
      </ul>
      {notice && <p role="status" className="mt-2 text-[12px] text-text-muted">{notice}</p>}
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

function MemberIdentity({ user }: { user: SlackUserCandidate }) {
  return <>
    {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="h-7 w-7 shrink-0 rounded-sm" /> : <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-surface-elevated font-serif text-text-muted">{user.displayName.slice(0, 1)}</span>}
    <span className="min-w-0">
      <span className="block truncate text-[12px] font-medium text-text">{user.displayName}</span>
      <span className="block truncate text-[10px] text-text-subtle">{user.handle && `@${user.handle} · `}<span className="font-mono">{user.slackUserId}</span></span>
    </span>
  </>;
}
