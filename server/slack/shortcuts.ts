// Bot scopes for shortcuts (`commands`), canvases and lists. Apps created from an older manifest lack them.
const REQUIRED_SLACK_MANIFEST_BOT_SCOPES = ['commands', 'canvases:read', 'canvases:write', 'lists:read', 'lists:write'];

export function parseOauthScopesHeader(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export function missingRequiredSlackManifestBotScopes(scopes: readonly string[]): string[] {
  return REQUIRED_SLACK_MANIFEST_BOT_SCOPES.filter((scope) => !scopes.includes(scope));
}

export function hasRequiredSlackManifestBotScopes(scopes: readonly string[]): boolean {
  return missingRequiredSlackManifestBotScopes(scopes).length === 0;
}
