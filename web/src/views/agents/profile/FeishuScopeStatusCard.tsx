import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RotateCw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { fetchAgentFeishuScopeStatus } from '@/api/agents';
import { queryKeys } from '@/lib/query-keys';
import {
  FEISHU_RECOMMENDED_SCOPES,
  type AgentFeishuRecommendedScopeStatusItem,
  type AgentFeishuScopeStatus,
} from '@shared/agent-config';

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
  const recommended = data?.recommended;
  const state = recommended?.state ?? data?.profileName.state;
  if (
    currentRecheckResult !== 'granted' &&
    !isError &&
    (!data || state === 'granted' || state === 'not_connected')
  )
    return null;

  const authUrl = recommended?.authUrl ?? data?.profileName.authUrl;
  const confirmedMissing = state === 'missing';
  const title = confirmedMissing
    ? "Recommended Feishu permissions aren't fully authorized yet"
    : "Recommended Feishu permission access isn't confirmed";
  const body = confirmedMissing
    ? 'Your agents can send and receive messages in Feishu. To let them use teammate names, look people up by email or phone, and invite people or bots into chats, authorize the recommended permissions in the Feishu admin console.'
    : "Anima couldn't confirm whether this Feishu app grants the recommended permissions. If your agents only see IDs, cannot look people up by email or phone, or cannot invite members to chats, authorize these permissions in the Feishu admin console.";
  const scopes = recommendedScopesForDisplay(data);

  async function handleRecheck() {
    setRecheckResult(null);
    const result = await refetch();
    const nextState = result.data?.recommended.state ?? result.data?.profileName.state;
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
            Recommended Feishu permissions are on. Your agents can now use teammate names, look
            people up by email or phone, and invite members to chats.
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
          <div className="mt-2">
            <div className="font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-text-subtle">
              Recommended permissions
            </div>
            <ul className="mt-1 space-y-2">
              {scopes.map((scope) => (
                <li key={scope.scope} className="rounded-sm border border-border-soft bg-white px-3 py-2">
                  <div className="font-serif text-[13px] font-semibold leading-snug text-text">
                    {scope.label}
                  </div>
                  <p className="mt-0.5 font-sans text-[12px] leading-snug text-text-muted">
                    {scope.description}
                  </p>
                </li>
              ))}
            </ul>
          </div>
          {currentRecheckResult === 'missing' && (
            <div className="mt-2 font-sans text-[11px] text-text-subtle">
              Not authorized yet. If you just approved it in Feishu, give it a moment and recheck.
            </div>
          )}
          {(recommended?.message ?? data?.profileName.message) && currentRecheckResult !== 'missing' && (
            <div className="mt-2 break-words font-sans text-[11px] text-text-subtle">
              Last check: {recommended?.message ?? data?.profileName.message}
            </div>
          )}
          {isError && !(recommended?.message ?? data?.profileName.message) && (
            <div className="mt-2 font-sans text-[11px] text-text-subtle">
              Could not check Feishu permissions.
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

function recommendedScopesForDisplay(
  data: AgentFeishuScopeStatus | undefined,
): AgentFeishuRecommendedScopeStatusItem[] {
  if (data?.recommended.scopes.length) {
    const missing = data.recommended.scopes.filter((scope) => !scope.granted);
    return missing.length ? missing : data.recommended.scopes;
  }
  return FEISHU_RECOMMENDED_SCOPES.map((scope) => ({
    capability: scope.capability,
    description: scope.description,
    granted: false,
    label: scope.label,
    scope: scope.scope,
  }));
}
