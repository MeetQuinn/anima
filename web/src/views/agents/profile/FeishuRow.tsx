import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { fetchAgentFeishuScopeStatus, refreshAgentData, syncAgentFeishuAvatar } from '@/api/agents';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/query-keys';
import { ConnectionDialog, ConnectionHeader, ConnectionRow, Fact } from './Connection';
import { FeishuScopeStatusCard, feishuScopeNote } from './FeishuScopeStatusCard';

export function FeishuRow({
  agentId,
  agentName = agentId,
  appId,
  botOpenId,
}: {
  agentId: string;
  agentName?: string;
  appId?: string;
  botOpenId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  // Same query as the permissions card in the dialog, so the row knows about
  // missing permissions without a second request.
  const scopes = useQuery({
    queryKey: queryKeys.agentFeishuScopes(agentId),
    queryFn: () => fetchAgentFeishuScopeStatus(agentId),
  });
  const scopeNote = feishuScopeNote(scopes);
  const close = useCallback(() => {
    if (syncing) return;
    setSyncError('');
    setOpen(false);
  }, [syncing]);

  async function syncAvatar() {
    if (syncing) return;
    setSyncing(true);
    setSyncError('');
    try {
      await syncAgentFeishuAvatar(agentId);
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
        label="Feishu"
        connected
        notes={scopeNote ? [scopeNote] : []}
        action="Manage"
        onAction={() => setOpen(true)}
      />
      {open && (
        <ConnectionDialog platform="Feishu" busy={syncing} onClose={close}>
          <div className="space-y-5">
            <ConnectionHeader title="Connected to Feishu">
              Mention {agentName} in a Feishu chat or send it a direct message.
            </ConnectionHeader>
            <dl className="grid grid-cols-2 overflow-hidden rounded-sm border border-border-soft">
              {/* Feishu IDs are long (a Bot Open ID is 35 characters): a full row
                  each, so they read on one line at phone width too. */}
              <Fact label="App ID" value={appId || '—'} mono wide />
              <Fact label="Bot Open ID" value={botOpenId || '—'} mono wide />
              <Fact label="Credentials" value="Configured" wide />
              <Fact label="Delivery" value="Long-lived connection" wide />
            </dl>
            <p className="font-sans text-[12px] leading-relaxed text-text-muted">
              Feishu credentials are stored in the agent config and injected by Anima at runtime. Secret values are
              hidden in the dashboard.
            </p>
            <FeishuScopeStatusCard agentId={agentId} />
            {syncError && (
              <p role="alert" className="font-sans text-[12px] text-health-error">
                {syncError}
              </p>
            )}
            <footer className="flex flex-wrap items-center gap-2 border-t border-border-soft pt-4">
              <Button
                variant="ghost"
                disabled={syncing}
                onClick={() => void syncAvatar()}
                className="h-[44px] px-3 text-[13px] font-normal md:h-9"
              >
                <RotateCcw className={`size-3.5 ${syncing ? 'animate-spin' : ''}`} aria-hidden="true" />
                {syncing ? 'Syncing avatar…' : 'Sync avatar from Feishu'}
              </Button>
            </footer>
          </div>
        </ConnectionDialog>
      )}
    </>
  );
}
