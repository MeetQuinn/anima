import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { fetchAgentFeishuScopeStatus } from '@/api/agents';
import {
  FeishuRecommendedPermissionsChecklist,
  recommendedScopesForDisplay,
} from './FeishuRecommendedPermissionsChecklist';
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
  const [showPerms, setShowPerms] = useState(false);
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
  const authUrls = recommended?.authUrls;
  const scopes = recommendedScopesForDisplay(data);
  // Match the onboarding honesty model: only assert "still missing" (✗ rows,
  // red verdict, publish-step ring) after an explicit recheck comes back missing,
  // never on first paint.
  const confirmedMissing = currentRecheckResult === 'missing';

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
      <div className="rounded-md border border-health-ok/30 bg-health-ok-soft px-4 py-3">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-health-ok" />
          <p className="font-serif text-[13px] leading-snug text-text">
            Recommended Feishu permissions are on. Your Feishu bot is good to go.
          </p>
        </div>
      </div>
    );
  }

  const lastCheckMessage = recommended?.message ?? data?.profileName.message;
  return (
    <FeishuRecommendedPermissionsChecklist
      scopes={scopes}
      authUrl={authUrl}
      authUrls={authUrls}
      confirmedMissing={confirmedMissing}
      showPerms={showPerms}
      onTogglePerms={() => setShowPerms((v) => !v)}
      onRecheck={() => void handleRecheck()}
      isRechecking={isFetching}
      statusLine={
        <>
          {lastCheckMessage && currentRecheckResult !== 'missing' && (
            <div className="break-words font-sans text-[11px] text-text-subtle">
              Last check: {lastCheckMessage}
            </div>
          )}
          {isError && !lastCheckMessage && (
            <div className="font-sans text-[11px] text-text-subtle">
              Could not check Feishu permissions.
            </div>
          )}
        </>
      }
    />
  );
}
