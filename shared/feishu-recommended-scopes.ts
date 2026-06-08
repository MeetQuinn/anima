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
    description: 'Let the bot turn Feishu user IDs into teammate names.',
    label: 'Show teammate names',
    scope: FEISHU_PROFILE_NAME_SCOPE,
  },
  {
    capability: 'user_lookup',
    description: 'Let the bot find the right teammate from an email address or phone number.',
    label: 'Find people by email or phone',
    scope: 'contact:user.id:readonly',
  },
  {
    capability: 'user_lookup',
    description: 'Let the bot use the ID format Feishu requires for some chat actions.',
    label: 'Use the correct user ID format',
    scope: 'contact:user.employee_id:readonly',
  },
  {
    capability: 'user_lookup',
    description: 'Supports email-based user lookup.',
    label: 'Read teammate email addresses',
    scope: 'contact:user.email:readonly',
  },
  {
    capability: 'user_lookup',
    description: 'Supports phone-based user lookup.',
    label: 'Read teammate phone numbers',
    scope: 'contact:user.phone:readonly',
  },
  {
    capability: 'chat_invites',
    description: 'Let the bot invite people or other bots into Feishu group chats.',
    label: 'Invite members to group chats',
    scope: 'im:chat.members:write_only',
  },
] as const satisfies readonly FeishuRecommendedScope[];

export const FEISHU_RECOMMENDED_SCOPE_NAMES = FEISHU_RECOMMENDED_SCOPES.map((scope) => scope.scope);
