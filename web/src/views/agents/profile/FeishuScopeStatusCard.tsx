import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RotateCw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { fetchAgentFeishuScopeStatus } from '@/api/agents';
import { queryKeys } from '@/lib/query-keys';

interface Props {
  agentId: string;
}

type RecheckResult = {
  agentId: string;
  appId?: string;
  state: 'granted' | 'missing';
};

export function FeishuScopeStatusCard({ agentId }: Props) {
  const [recheckResult, setRecheckResult] = useState<RecheckResult | null>(null);
  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: queryKeys.agentFeishuScopes(agentId),
    queryFn: () => fetchAgentFeishuScopeStatus(agentId),
  });

  const currentAppId = data?.appId;
  const currentRecheckResult =
    recheckResult?.agentId === agentId && recheckResult.appId === currentAppId
      ? recheckResult.state
      : null;
  const state = data?.profileName.state;
  if (
    currentRecheckResult !== 'granted' &&
    !isError &&
    (!data || state === 'granted' || state === 'not_connected')
  )
    return null;

  const scope = data?.profileName.scope ?? 'contact:user.basic_profile:readonly';
  const authUrl = data?.profileName.authUrl;
  const confirmedMissing = state === 'missing';
  const title = confirmedMissing
    ? "Teammate names aren't available yet"
    : "Teammate name access isn't confirmed";
  const body = confirmedMissing
    ? 'Your agents can send and receive messages in Feishu. To let them address teammates by name instead of an ID, authorize one more permission in the Feishu admin console.'
    : "Anima couldn't confirm whether this Feishu app grants profile-name access. If your agents only see IDs instead of names, authorize this permission in the Feishu admin console.";

  async function handleRecheck() {
    setRecheckResult(null);
    const result = await refetch();
    const nextState = result.data?.profileName.state;
    if (nextState === 'granted' || nextState === 'missing') {
      setRecheckResult({ agentId, appId: result.data?.appId, state: nextState });
    }
  }

  if (currentRecheckResult === 'granted') {
    return (
      <div className="rounded-sm border border-health-ok/30 bg-health-ok-soft px-4 py-3">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-health-ok" />
          <p className="font-serif text-[13px] leading-snug text-text">
            Teammate-name access is on. Your agents can now use teammates' names.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-health-warn/30 bg-health-warn-soft px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-health-warn" />
        <div className="min-w-0 flex-1">
          <div className="font-serif text-[14px] font-semibold text-text">{title}</div>
          <p className="mt-1 font-serif text-[13px] leading-snug text-text-muted">{body}</p>
          <div className="mt-2 break-all font-mono text-[11px] text-text-subtle">
            Required scope: {scope}
          </div>
          {currentRecheckResult === 'missing' && (
            <div className="mt-2 font-sans text-[11px] text-text-subtle">
              Not authorized yet. If you just approved it in Feishu, give it a moment and recheck.
            </div>
          )}
          {data?.profileName.message && currentRecheckResult !== 'missing' && (
            <div className="mt-2 break-words font-sans text-[11px] text-text-subtle">
              Last check: {data.profileName.message}
            </div>
          )}
          {isError && !data?.profileName.message && (
            <div className="mt-2 font-sans text-[11px] text-text-subtle">
              Could not check Feishu name access.
            </div>
          )}
          {authUrl && (
            <a
              href={authUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1 font-sans text-[12px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            >
              Authorize in Feishu <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <button
            type="button"
            onClick={() => void handleRecheck()}
            disabled={isFetching}
            className="mt-3 ml-3 inline-flex items-center gap-1 font-sans text-[12px] text-text-muted underline decoration-text-subtle/40 underline-offset-2 transition-colors hover:text-text hover:decoration-text/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isFetching ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCw className="h-3 w-3" />
            )}
            Recheck access
          </button>
        </div>
      </div>
    </div>
  );
}
