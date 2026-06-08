// Official English permission names exactly as the Feishu/Lark Open Platform
// scope list presents them, keyed by scope id. Shown on the recommended-
// permissions surfaces so users can cross-reference what they see in their own
// Feishu console, item for item. The friendly capability labels (e.g. "Show
// teammate names") still carry the plain-language framing in the brief/body;
// these are the formal console names only.
//
// Source: https://open.larksuite.com/document/server-docs/getting-started/scope-list
// (No "Lark" appears in any of these names — verified against the rendered list.)
export const FEISHU_OFFICIAL_SCOPE_NAMES: Record<string, string> = {
  'contact:user.basic_profile:readonly': "Get user's basic info",
  'contact:user.id:readonly': 'Obtain user ID via email or mobile number',
  'contact:user.employee_id:readonly': 'Obtain user ID',
  'contact:user.email:readonly': "Obtain user's email information",
  'contact:user.phone:readonly': "Obtain user's mobile number",
  'im:message.group_msg': 'Read all messages in associated group chat (sensitive scope)',
  'im:chat.members:write_only': 'Add and remove group member',
};

// Returns the official console name for a scope, falling back to the friendly
// label if an unmapped scope ever shows up (defensive against future scopes).
export function feishuOfficialScopeName(scope: string, fallback: string): string {
  return FEISHU_OFFICIAL_SCOPE_NAMES[scope] ?? fallback;
}
