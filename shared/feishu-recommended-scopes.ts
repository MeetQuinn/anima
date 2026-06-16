export const FEISHU_PROFILE_NAME_SCOPE = 'contact:user.basic_profile:readonly';

export type FeishuRecommendedScopeCapability =
  | 'cloud_docs'
  | 'bot_message_visibility'
  | 'group_visibility'
  | 'teammate_names'
  | 'user_lookup'
  | 'chat_invites';

export interface FeishuRecommendedScope {
  capability: FeishuRecommendedScopeCapability;
  description: string;
  label: string;
  scope: string;
}

// Only tenant/app identity scopes can be requested through the Feishu app auth
// URL we generate. Some ccm scopes are user-identity-only; keep those out of the
// recommended bundle or Feishu rejects the auth page as "invalid parameter".
const FEISHU_CLOUD_DOCS_SCOPES = [
  ['bitable:app', 'View, comment, edit and manage Base'],
  ['bitable:app:readonly', 'View, comment, and export Base'],
  ['bitable:bitable', 'View, comment, edit, and manage Base (In Suite)'],
  ['bitable:bitable:readonly', 'View, comment, and export Base (In Suite)'],
  ['board:whiteboard:node:create', 'Create board node'],
  ['board:whiteboard:node:delete', 'Delete board node'],
  ['board:whiteboard:node:read', 'View board node'],
  ['board:whiteboard:node:update', 'Update board node'],
  ['docs:doc', 'View, comment, edit, and manage Docs'],
  ['docs:doc:readonly', 'View, comment, and export Docs'],
  ['docs:docs:operate_as_user', 'Access Docs as a user'],
  ['docs:document.comment:create', 'Add and reply to comment in document'],
  ['docs:document.comment:delete', 'Delete comment in document'],
  ['docs:document.comment:read', 'Get comments in document'],
  ['docs:document.comment:update', 'Modify comment in document'],
  ['docs:document.comment:write_only', 'Reply, edit, delete comment in document'],
  ['docs:document.content:read', 'View document content'],
  ['docs:document.media:download', 'Download image and file in document'],
  ['docs:document.media:upload', 'Upload image and file to document'],
  ['docs:document.subscription', 'Subscribe to document and update subscription status'],
  ['docs:document.subscription:read', 'Get subscription status of document'],
  ['docs:document:copy', 'Duplicate document'],
  ['docs:document:export', 'Export document'],
  ['docs:document:import', 'View and create document import task'],
  ['docs:event.document_deleted:read', 'Receive document delete event'],
  ['docs:event.document_edited:read', 'Receive document edit event'],
  ['docs:event.document_opened:read', 'Receive document open event'],
  ['docs:event:subscribe', 'Subscribe to document-related events'],
  ['docs:permission.member', 'View, add, update, and delete document collaborators'],
  ['docs:permission.member:auth', "Verify user's access to document"],
  ['docs:permission.member:create', 'Add document collaborator'],
  ['docs:permission.member:delete', 'Remove document collaborator'],
  ['docs:permission.member:read', 'View collaborator permissions for cloud documents'],
  ['docs:permission.member:readonly', 'View document collaborators (legacy version)'],
  ['docs:permission.member:retrieve', 'Get document collaborators'],
  ['docs:permission.member:transfer', 'Transfer ownership of document'],
  ['docs:permission.member:update', 'Update collaborator permission of document'],
  ['docs:permission.public:read', 'View document permission settings access'],
  ['docs:permission.setting', 'View and update document permission settings'],
  ['docs:permission.setting:read', 'Query permission settings of document'],
  ['docs:permission.setting:readonly', 'View document permission settings'],
  ['docs:permission.setting:write_only', 'Modify permission settings of document'],
  ['docx:document', 'Create and edit upgraded Docs'],
  ['docx:document.block:convert', 'Convert text to cloud document block'],
  ['docx:document:create', 'Create upgraded Docs'],
  ['docx:document:readonly', 'View upgraded Docs'],
  ['docx:document:write_only', 'Edit upgraded Docs'],
  ['drive:drive', 'View, comment, edit, and manage all files in My Space'],
  ['drive:drive.metadata:readonly', 'View the metadata of files in My Space'],
  ['drive:drive.search:readonly', 'Search files in My Space'],
  ['drive:drive:readonly', 'View, comment, and download all files in My Space'],
  ['drive:drive:version', 'View, create, and delete document versions'],
  ['drive:drive:version:readonly', 'View document versions'],
  ['drive:export:readonly', 'Export Docs documents'],
  ['drive:file', 'Upload and download files to My Space'],
  ['drive:file.like:readonly', 'View the likes information of document'],
  ['drive:file.meta.sec_label.read_only', 'View document security level label'],
  ['drive:file:download', 'Download file in My Space'],
  ['drive:file:readonly', 'View and download files in My Space'],
  ['drive:file:upload', 'Upload file'],
  ['drive:file:view_record:readonly', "Get document's view history"],
  ['sheets:spreadsheet', 'View, comment, edit, and manage Sheets'],
  ['sheets:spreadsheet.meta:read', 'Query metadata of spreadsheet'],
  ['sheets:spreadsheet.meta:write_only', 'Modify metadata of spreadsheet'],
  ['sheets:spreadsheet:create', 'Create spreadsheet'],
  ['sheets:spreadsheet:read', 'View spreadsheet'],
  ['sheets:spreadsheet:readonly', 'View, comment, and export Sheets'],
  ['sheets:spreadsheet:write_only', 'Edit spreadsheet'],
  ['slides:presentation:create', 'Create slides'],
  ['slides:presentation:read', 'View slides'],
  ['slides:presentation:update', 'Edit slides'],
  ['slides:presentation:write_only', 'Create and edit slides'],
  ['space:document.event:read', 'Subscribe to file-related events under folder'],
  ['space:document:delete', 'Delete folder and document in My Space'],
  ['space:document:move', 'Move folder and document in My Space'],
  ['space:document:retrieve', 'Get document list in My Space folder'],
  ['space:document:shortcut', 'Create document shortcut'],
  ['space:folder:create', 'Create folder in My Space'],
  ['wiki:member:create', 'Add wiki space member'],
  ['wiki:member:retrieve', 'View wiki space member list'],
  ['wiki:member:update', 'Update wiki space member'],
  ['wiki:node:copy', 'Create wiki space node copy'],
  ['wiki:node:create', 'Create wiki space node'],
  ['wiki:node:move', 'Move wiki space node'],
  ['wiki:node:read', 'View wiki space node information'],
  ['wiki:node:retrieve', 'View wiki space node list'],
  ['wiki:node:update', 'Update wiki space node information'],
  ['wiki:setting:read', 'View wiki space settings'],
  ['wiki:setting:write_only', 'Update wiki space settings'],
  ['wiki:space:read', 'View wiki space information'],
  ['wiki:space:retrieve', 'View wiki space list'],
  ['wiki:space:write_only', 'Create and update wiki space'],
  ['wiki:wiki', 'View, edit, and manage Wiki'],
  ['wiki:wiki:readonly', 'View all Wiki'],
] as const;

const FEISHU_CLOUD_DOCS_RECOMMENDED_SCOPES: readonly FeishuRecommendedScope[] =
  FEISHU_CLOUD_DOCS_SCOPES.map(([scope, label]) => ({
    capability: 'cloud_docs',
    description: 'Let the bot work with Feishu Drive and cloud documents.',
    label,
    scope,
  }));

const FEISHU_CORE_RECOMMENDED_SCOPES = [
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
    capability: 'group_visibility',
    description: 'Let the bot see messages in Feishu group chats.',
    label: 'See group messages',
    scope: 'im:message.group_msg',
  },
  {
    capability: 'bot_message_visibility',
    description: 'Let the bot receive group messages sent by other Feishu bots.',
    label: 'See bot messages in groups',
    scope: 'im:message.bot_event:read',
  },
  {
    capability: 'bot_message_visibility',
    description: 'Let the bot receive group mentions from users and other Feishu bots.',
    label: 'See mentions from people and bots',
    scope: 'im:message.group_at_msg.include_bot:readonly',
  },
  {
    capability: 'chat_invites',
    description: 'Let the bot invite people or other bots into Feishu group chats.',
    label: 'Invite members to group chats',
    scope: 'im:chat.members:write_only',
  },
] as const satisfies readonly FeishuRecommendedScope[];

export const FEISHU_RECOMMENDED_SCOPES = [
  ...FEISHU_CORE_RECOMMENDED_SCOPES,
  ...FEISHU_CLOUD_DOCS_RECOMMENDED_SCOPES,
] as const satisfies readonly FeishuRecommendedScope[];

export const FEISHU_RECOMMENDED_SCOPE_NAMES = FEISHU_RECOMMENDED_SCOPES.map((scope) => scope.scope);
