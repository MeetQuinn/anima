import { agentAvatarUrl, agentDisplayName } from '@/lib/agent-avatar';
import { initialOf } from '@/lib/avatars';
import {
  inboundAuthorName,
  inboundSlackUserId,
  type Author,
  type AuthorResolver,
  type SurfaceResolver,
} from '@/views/agents/conversation/SlackTimeline';
import type { AgentConfig } from '@shared/agent-config';

export function buildActivityAuthorResolvers(input: {
  agent: AgentConfig | undefined;
  agentId: string | undefined;
}): {
  agentAuthor: Author;
  resolveAuthor: AuthorResolver;
  resolveSurface: SurfaceResolver;
} {
  const agentDisplay = input.agent ? agentDisplayName(input.agent) : (input.agentId ?? '');
  const agentAvatar = agentAvatarUrl(input.agent);
  const agentAuthor: Author = {
    key: 'agent',
    name: agentDisplay,
    ...(agentAvatar ? { avatarUrl: agentAvatar } : {}),
    initial: initialOf(agentDisplay),
    isAgent: true,
  };
  const resolveAuthor: AuthorResolver = (item) => {
    if (item.kind !== 'message-in') return agentAuthor;
    const name = inboundAuthorName(item.message);
    const uid = inboundSlackUserId(item.message);
    return {
      key: `in:${uid ?? name}`,
      name,
      ...(item.avatarUrl ? { avatarUrl: item.avatarUrl } : {}),
      initial: initialOf(name),
      isAgent: false,
    };
  };
  const resolveSurface: SurfaceResolver = (item) => {
    const chip = 'surface' in item ? item.surface : undefined;
    if (!chip) return { key: '' };
    return { key: `${chip.kind}:${chip.label}`, chip };
  };
  return { agentAuthor, resolveAuthor, resolveSurface };
}
