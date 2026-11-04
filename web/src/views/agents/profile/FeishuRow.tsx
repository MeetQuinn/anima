import { useCallback, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { refreshAgentData, syncAgentFeishuAvatar } from '@/api/agents';
import { Button } from '@/components/ui/button';
import { ConnectionDialog, ConnectionHeader, ConnectionRow, Fact } from './Connection';

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
              <Fact label="App ID" value={appId || '—'} mono />
              <Fact label="Bot Open ID" value={botOpenId || '—'} mono />
              <Fact label="Credentials" value="Configured" wide />
              <Fact label="Delivery" value="Long-lived connection" wide />
            </dl>
            <p className="font-sans text-[12px] leading-relaxed text-text-muted">
              Feishu credentials are stored in the agent config and injected by Anima at runtime. Secret values are
              hidden in the dashboard.
            </p>
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
