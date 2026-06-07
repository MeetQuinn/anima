import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { fetchAgentFeishuScopeStatus } from '@/api/agents';
import { queryKeys } from '@/lib/query-keys';

interface Props {
  agentId: string;
}

export function FeishuScopeStatusCard({ agentId }: Props) {
  const { data, isError } = useQuery({
    queryKey: queryKeys.agentFeishuScopes(agentId),
    queryFn: () => fetchAgentFeishuScopeStatus(agentId),
  });

  const state = data?.profileName.state;
  if (!isError && (!data || state === 'granted' || state === 'not_connected')) return null;

  const scope = data?.profileName.scope ?? 'contact:user.basic_profile:readonly';
  const authUrl = data?.profileName.authUrl;

  return (
    <div className="rounded-sm border border-health-warn/30 bg-health-warn-soft px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-health-warn" />
        <div className="min-w-0 flex-1">
          <div className="font-serif text-[14px] font-semibold text-text">
            Feishu name access missing
          </div>
          <p className="mt-1 font-serif text-[13px] leading-snug text-text-muted">
            Anima can receive messages, but Feishu does not currently grant profile-name access.
            Agents may only see user IDs until this permission is authorized.
          </p>
          <div className="mt-2 break-all font-mono text-[11px] text-text-subtle">
            Required scope: {scope}
          </div>
          {data?.profileName.message && (
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
              Open Feishu authorization <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
