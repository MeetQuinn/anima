export const FEISHU_PROFILE_NAME_SCOPE = 'contact:user.basic_profile:readonly';

export type FeishuRecommendedScopeCapability =
  | 'teammate_names'
  | 'user_lookup'
  | 'chat_invites';

export interface FeishuRecommendedScope {
  capability: FeishuRecommendedScopeCapability;
  description: string;
  label: string;
  scope: string;
}

export const FEISHU_RECOMMENDED_SCOPES = [
  {
    capability: 'teammate_names',
    description: 'Resolve Feishu user IDs into teammate names.',
    label: 'Teammate names',
    scope: FEISHU_PROFILE_NAME_SCOPE,
  },
  {
    capability: 'user_lookup',
    description: 'Find a Feishu user ID from an email address or phone number.',
    label: 'Find users by email or phone',
    scope: 'contact:user.id:readonly',
  },
  {
    capability: 'user_lookup',
    description: 'Read tenant-level user ID fields when an API requires user_id.',
    label: 'Tenant user IDs',
    scope: 'contact:user.employee_id:readonly',
  },
  {
    capability: 'user_lookup',
    description: 'Read teammate email fields for user lookup.',
    label: 'User email fields',
    scope: 'contact:user.email:readonly',
  },
  {
    capability: 'user_lookup',
    description: 'Read teammate phone fields for user lookup.',
    label: 'User phone fields',
    scope: 'contact:user.phone:readonly',
  },
  {
    capability: 'chat_invites',
    description: 'Invite people or bots into Feishu group chats.',
    label: 'Invite chat members',
    scope: 'im:chat.members:write_only',
  },
] as const satisfies readonly FeishuRecommendedScope[];

export const FEISHU_RECOMMENDED_SCOPE_NAMES = FEISHU_RECOMMENDED_SCOPES.map((scope) => scope.scope);
