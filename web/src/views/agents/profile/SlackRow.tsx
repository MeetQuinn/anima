import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, RotateCcw } from 'lucide-react';
import { fetchAgentSlackManifestUpdate, refreshAgentData, syncAgentAvatar } from '@/api/agents';
import { Button, buttonVariants } from '@/components/ui/button';
import { queryKeys } from '@/lib/query-keys';
import { ConnectionDialog, ConnectionHeader, ConnectionRow, Fact } from './Connection';
import { SlackManifestUpdateCard } from './SlackManifestUpdateCard';

export function SlackRow({
  agentId,
  agentName = agentId,
  appId,
  workspaceName,
  workspaceIconUrl,
}: {
  agentId: string;
  agentName?: string;
  appId?: string;
  workspaceName?: string;
  workspaceIconUrl?: string;
}) {
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const busy = syncing || savingToken;
  const [syncError, setSyncError] = useState('');
  // Same query as the update card in the dialog, so the row knows about a
  // pending app update without a second request.
  const manifest = useQuery({
    queryKey: queryKeys.agentSlackManifestUpdate(agentId),
    queryFn: () => fetchAgentSlackManifestUpdate(agentId),
  });
  const updateAvailable = Boolean(manifest.data?.needsUpdate);
  const handle = `@${agentId}`;
  const close = useCallback(() => {
    if (busy) return;
    setSyncError('');
    setOpen(false);
  }, [busy]);

  async function syncAvatar() {
    if (syncing) return;
    setSyncing(true);
    setSyncError('');
    try {
      await syncAgentAvatar(agentId);
      refreshAgentData(agentId);
    } catch {
      setSyncError('Could not sync the avatar. Try again in a moment.');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <ConnectionRow
        label="Slack"
        connected
        workspace={workspaceName}
        iconUrl={workspaceIconUrl}
        notes={updateAvailable ? [{ tone: 'warn', text: 'Slack app update available' }] : []}
        action="Manage"
        onAction={() => setOpen(true)}
      />
      {open && (
        <ConnectionDialog platform="Slack" busy={busy} onClose={close}>
          <div className="space-y-5">
            <ConnectionHeader title={`Connected to ${workspaceName || 'Slack'}`}>
              Mention {agentName} in a channel or send it a direct message.
            </ConnectionHeader>
            <dl className="grid grid-cols-2 overflow-hidden rounded-sm border border-border-soft">
              <Fact label="Bot" value={handle} />
              <Fact label="App ID" value={appId || '—'} mono />
            </dl>
            <SlackManifestUpdateCard agentId={agentId} defaultOpen onSavingChange={setSavingToken} />
            {syncError && (
              <p role="alert" className="font-sans text-[12px] text-health-error">
                {syncError}
              </p>
            )}
            <footer className="flex flex-wrap items-center gap-2 border-t border-border-soft pt-4">
              {appId && (
                <a
                  href={`https://api.slack.com/apps/${appId}/general`}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ variant: 'outline', className: 'h-[44px] gap-1.5 px-3 text-[13px] md:h-9' })}
                >
                  Slack app settings
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              )}
              <Button
                variant="ghost"
                disabled={syncing}
                onClick={() => void syncAvatar()}
                className="h-[44px] px-3 text-[13px] font-normal md:h-9"
              >
                <RotateCcw className={`size-3.5 ${syncing ? 'animate-spin' : ''}`} aria-hidden="true" />
                {syncing ? 'Syncing avatar…' : 'Sync avatar from Slack'}
              </Button>
            </footer>
          </div>
        </ConnectionDialog>
      )}
    </>
  );
}
