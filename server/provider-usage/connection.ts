import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";

import type {
  ProviderConnection,
  ProviderUsageRow,
} from "../../shared/provider-usage.js";
import { record, stringValue, providerHome } from "./providers/common.js";
import { fetchClaudeUsage } from "./providers/claude.js";
import { normalizedConfigDir } from "./providers/claude-credentials.js";
import { fetchCodexUsage } from "./providers/codex.js";

type Usage = Omit<
  ProviderUsageRow,
  "checkedAt" | "label" | "provider" | "source"
>;
interface Options {
  env?: NodeJS.ProcessEnv;
  home?: string;
  subscriptionUsage?: (input: {
    configDir?: string;
    accessToken?: string;
  }) => Promise<Usage>;
}
const unknown: ProviderConnection = {
  credential: "none",
  method: "unknown",
  scope: "machine-default",
  status: "unknown",
};

/** Only publish the origin. Keys, helper commands, paths and query strings stay local. */
export function connectionOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

function connection(
  method: ProviderConnection["method"],
  credential: ProviderConnection["credential"],
  endpoint?: string,
  status: ProviderConnection["status"] = "configured",
): ProviderConnection {
  return {
    credential,
    ...(endpoint ? { endpoint } : {}),
    method,
    scope: "machine-default",
    status,
  };
}

// Missing config is an empty default; unreadable or malformed config is unknown.
async function configFile(
  path: string,
  toml = false,
): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return record(toml ? parse(text) : JSON.parse(text));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : undefined;
  }
}

/** Native machine defaults only. Never run helpers or inspect per-agent secrets. */
export async function fetchClaudeConnectionUsage(
  options: Options = {},
): Promise<Usage> {
  const env = options.env ?? process.env;
  const home = options.home ?? providerHome();
  const usageConfigDir =
    normalizedConfigDir(env.CLAUDE_CONFIG_DIR) ??
    (options.home ? join(home, ".claude") : undefined);
  const configDir = usageConfigDir ?? join(home, ".claude");
  const subscriptionUsage = options.subscriptionUsage ?? fetchClaudeUsage;
  const settings = await configFile(join(configDir, "settings.json"));
  if (!settings) return noQuota(unknown);
  const configured = record(settings.env) ?? {};
  // Claude loads its user settings env into the CLI environment. Project/managed
  // overrides are outside this machine-default snapshot and are labelled in UI.
  const effective = { ...env, ...configured };
  const endpoint = stringValue(effective.ANTHROPIC_BASE_URL)
    ? connectionOrigin(effective.ANTHROPIC_BASE_URL)
    : "https://api.anthropic.com";
  if (
    [
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ].some((key) => effective[key] === "1" || effective[key] === "true")
  ) {
    return noQuota(connection("cloud", "none", undefined, "unknown"));
  }
  if (
    stringValue(effective.ANTHROPIC_AUTH_TOKEN) ||
    stringValue(effective.ANTHROPIC_API_KEY)
  ) {
    return noQuota(connection("api-key", "environment", endpoint));
  }
  if (stringValue(settings.apiKeyHelper))
    return noQuota(connection("api-key", "helper", endpoint));
  const oauth = stringValue(effective.CLAUDE_CODE_OAUTH_TOKEN);
  if (oauth) {
    return {
      ...(await subscriptionUsage({
        configDir: usageConfigDir,
        accessToken: oauth,
      })),
      connection: connection("subscription", "environment", endpoint),
    };
  }
  if (
    stringValue(effective.ANTHROPIC_PROFILE) ||
    stringValue(effective.ANTHROPIC_FEDERATION_AUDIENCE)
  ) {
    return noQuota(unknown);
  }
  const usage = await subscriptionUsage({ configDir: usageConfigDir });
  return {
    ...usage,
    connection:
      usage.error?.type === "not_configured"
        ? connection("unknown", "none", undefined, "not-configured")
        : connection("subscription", "stored-login", endpoint),
  };
}

export async function fetchCodexConnectionUsage(
  options: Options = {},
): Promise<Usage> {
  const env = options.env ?? process.env;
  const home = options.home ?? providerHome();
  const configDir = env.CODEX_HOME?.trim() || join(home, ".codex");
  const config = await configFile(join(configDir, "config.toml"), true);
  if (!config) return noQuota(unknown);
  const profileName = stringValue(config.profile);
  const profile = profileName
    ? record(record(config.profiles)?.[profileName])
    : {};
  if (!profile) return noQuota(unknown);
  const selected = { ...config, ...profile };
  const id = stringValue(selected.model_provider) ?? "openai";
  const provider = record(record(config.model_providers)?.[id]);
  if (id !== "openai" && !provider) return noQuota(unknown);
  const baseUrl = provider?.base_url ?? env.OPENAI_BASE_URL;
  const endpoint = stringValue(baseUrl)
    ? connectionOrigin(baseUrl)
    : id === "openai"
      ? "https://api.openai.com"
      : undefined;
  if (provider && provider.requires_openai_auth !== true) {
    const helper = stringValue(record(provider.auth)?.command);
    if (helper) return noQuota(connection("api-key", "helper", endpoint));
    const keyName = stringValue(provider.env_key);
    if (keyName)
      return noQuota(
        connection(
          "api-key",
          "environment",
          endpoint,
          stringValue(env[keyName]) ? "configured" : "not-configured",
        ),
      );
    if (stringValue(provider.experimental_bearer_token))
      return noQuota(connection("api-key", "stored-key", endpoint));
    // Custom headers, workload identity or anonymous gateways have no proven key.
    return noQuota(unknown);
  }
  if (
    ["keyring", "auto", "ephemeral"].includes(
      String(selected.cli_auth_credentials_store),
    )
  )
    return noQuota(unknown);
  const auth = await configFile(join(configDir, "auth.json"));
  if (!auth) return noQuota(unknown);
  if (
    (selected.forced_login_method === "chatgpt" &&
      auth.auth_mode === "apikey") ||
    (selected.forced_login_method === "api" && auth.auth_mode === "chatgpt")
  )
    return noQuota(unknown);
  if (
    auth.auth_mode === "apikey" ||
    (!auth.auth_mode && stringValue(auth.OPENAI_API_KEY))
  ) {
    return noQuota(
      connection(
        "api-key",
        "stored-key",
        endpoint,
        stringValue(auth.OPENAI_API_KEY) ? "configured" : "not-configured",
      ),
    );
  }
  if (auth.auth_mode && auth.auth_mode !== "chatgpt") return noQuota(unknown);
  if (!stringValue(record(auth.tokens)?.access_token)) {
    // A missing file does not prove signed-out when the CLI uses a keyring.
    return noQuota(unknown);
  }
  return {
    ...(await (options.subscriptionUsage ?? fetchCodexUsage)({ configDir })),
    connection: connection(
      "subscription",
      "stored-login",
      connectionOrigin(provider?.base_url ?? selected.chatgpt_base_url),
    ),
  };
}

function noQuota(connection: ProviderConnection): Usage {
  return { connection, extras: [], status: "unavailable", windows: [] };
}
