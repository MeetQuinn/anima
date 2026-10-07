import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectionOrigin,
  fetchClaudeConnectionUsage,
  fetchCodexConnectionUsage,
} from "../provider-usage/connection.js";
import { ProviderUsageResponse } from "../../shared/provider-usage.js";
import { ProviderUsageService } from "../provider-usage/provider-usage.service.js";

type Usage = Awaited<ReturnType<typeof fetchClaudeConnectionUsage>>;
const quota: Usage = {
  account: "synthetic@example.test",
  extras: [],
  status: "available",
  windows: [{ label: "5h", remainingPercent: 70 }],
};
const forbidden = async (): Promise<Usage> => {
  throw new Error("Subscription lookup must not run");
};
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "provider-connection-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".claude"));
  await mkdir(join(home, ".codex"));
  return {
    home,
    claude: (settings: unknown) =>
      writeFile(
        join(home, ".claude", "settings.json"),
        JSON.stringify(settings),
      ),
    codex: (config: string) =>
      writeFile(join(home, ".codex", "config.toml"), config),
    auth: (auth: unknown) =>
      writeFile(join(home, ".codex", "auth.json"), JSON.stringify(auth)),
  };
}

test("connection origins omit credentials, path, query and fragment, rejecting non-HTTP", () => {
  assert.equal(
    connectionOrigin(
      "https://user:password@gateway.example.test:8443/token-secret?key=secret#secret",
    ),
    "https://gateway.example.test:8443",
  );
  assert.equal(connectionOrigin("javascript:secret"), undefined);
  assert.equal(connectionOrigin("not a URL with secret"), undefined);
});

test("Claude CPA helper is configured with no subscription call or helper execution", async (t) => {
  const f = await fixture(t);
  await f.claude({
    apiKeyHelper: 'sh -c "echo secret; exit 99"',
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18318/v1?secret=1" },
  });
  const before = await readFile(
    join(f.home, ".claude", "settings.json"),
    "utf8",
  );
  const row = await fetchClaudeConnectionUsage({
    home: f.home,
    env: {},
    subscriptionUsage: forbidden,
  });
  assert.deepEqual(row.connection, {
    method: "api-key",
    credential: "helper",
    endpoint: "http://127.0.0.1:18318",
    scope: "machine-default",
    status: "configured",
  });
  assert.equal(row.error, undefined);
  assert.deepEqual(row.windows, []);
  assert.equal(
    await readFile(join(f.home, ".claude", "settings.json"), "utf8"),
    before,
  );
  assert.equal(JSON.stringify(row).includes("secret"), false);
});

test("Claude API key/bearer beat helper and saved subscription; user env is observed", async (t) => {
  const f = await fixture(t);
  await f.claude({
    apiKeyHelper: "synthetic-helper",
    env: {
      ANTHROPIC_API_KEY: "settings-secret",
      ANTHROPIC_BASE_URL: "https://settings.example.test",
    },
  });
  const row = await fetchClaudeConnectionUsage({
    home: f.home,
    env: {
      ANTHROPIC_BASE_URL: "https://shell.example.test",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
    },
    subscriptionUsage: forbidden,
  });
  assert.equal(row.connection?.credential, "environment");
  assert.equal(row.connection?.method, "api-key");
  assert.equal(row.connection?.endpoint, "https://settings.example.test");
  assert.equal(JSON.stringify(row).includes("secret"), false);
});

test("Claude cloud selection precedes API key and does not imply validated cloud credentials", async (t) => {
  const f = await fixture(t);
  const row = await fetchClaudeConnectionUsage({
    home: f.home,
    env: { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "secret" },
    subscriptionUsage: forbidden,
  });
  assert.equal(row.connection?.method, "cloud");
  assert.equal(row.connection?.status, "unknown");
});

test("Claude setup-token is selected without borrowing the disk subscription account", async (t) => {
  const f = await fixture(t);
  let token: string | undefined;
  const row = await fetchClaudeConnectionUsage({
    home: f.home,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth" },
    subscriptionUsage: async (input) => {
      token = input.accessToken;
      return { ...quota, account: undefined };
    },
  });
  assert.equal(token, "synthetic-oauth");
  assert.equal(row.connection?.method, "subscription");
  assert.equal(row.connection?.credential, "environment");
  assert.equal(row.account, undefined);
});

test("Claude native default keeps default Keychain namespace; custom config is scoped", async (t) => {
  const f = await fixture(t);
  // No explicit home/configDir must leave the native Keychain service unsuffixed.
  const original = process.env.ANIMA_PROVIDER_USAGE_HOME;
  process.env.ANIMA_PROVIDER_USAGE_HOME = f.home;
  t.after(() => {
    if (original === undefined) delete process.env.ANIMA_PROVIDER_USAGE_HOME;
    else process.env.ANIMA_PROVIDER_USAGE_HOME = original;
  });
  let dir: string | undefined;
  const row = await fetchClaudeConnectionUsage({
    env: {},
    subscriptionUsage: async (input) => {
      dir = input.configDir;
      return quota;
    },
  });
  assert.equal(dir, undefined);
  assert.equal(row.connection?.method, "subscription");
  assert.deepEqual(row.windows, quota.windows);
  await fetchClaudeConnectionUsage({
    env: { CLAUDE_CONFIG_DIR: join(f.home, ".claude") },
    subscriptionUsage: async (input) => {
      dir = input.configDir;
      return quota;
    },
  });
  assert.equal(dir, join(f.home, ".claude"));
});

test("Claude malformed settings and profile auth remain unknown, not a false login instruction", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, ".claude", "settings.json"), "{bad");
  assert.equal(
    (
      await fetchClaudeConnectionUsage({
        home: f.home,
        env: {},
        subscriptionUsage: forbidden,
      })
    ).connection?.status,
    "unknown",
  );
  await f.claude({});
  assert.equal(
    (
      await fetchClaudeConnectionUsage({
        home: f.home,
        env: { ANTHROPIC_PROFILE: "named" },
        subscriptionUsage: forbidden,
      })
    ).connection?.status,
    "unknown",
  );
});

test("Codex stored API key wins over stale OAuth tokens without a usage call", async (t) => {
  const f = await fixture(t);
  await f.auth({
    auth_mode: "apikey",
    OPENAI_API_KEY: "synthetic-secret",
    tokens: { access_token: "stale-oauth" },
  });
  const row = await fetchCodexConnectionUsage({
    home: f.home,
    env: {},
    subscriptionUsage: forbidden,
  });
  assert.equal(row.connection?.method, "api-key");
  assert.equal(row.connection?.status, "configured");
  assert.equal(JSON.stringify(row).includes("synthetic-secret"), false);
});

test("Codex custom profile env_key is configured only when its named credential exists", async (t) => {
  const f = await fixture(t);
  await f.codex(
    'profile = "fleet"\n[profiles.fleet]\nmodel_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://user:pass@gateway.example.test/v1?secret=1"\nenv_key = "FLEET_KEY"\n',
  );
  const missing = await fetchCodexConnectionUsage({
    home: f.home,
    env: {},
    subscriptionUsage: forbidden,
  });
  assert.equal(missing.connection?.status, "not-configured");
  const row = await fetchCodexConnectionUsage({
    home: f.home,
    env: { FLEET_KEY: "secret" },
    subscriptionUsage: forbidden,
  });
  assert.equal(row.connection?.status, "configured");
  assert.equal(row.connection?.endpoint, "https://gateway.example.test");
  assert.equal(JSON.stringify(row).includes("secret"), false);
});

test("Codex requires_openai_auth ignores a competing env_key and keeps subscription quota", async (t) => {
  const f = await fixture(t);
  await f.codex(
    'model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example.test/v1"\nrequires_openai_auth = true\nenv_key = "OTHER_KEY"\n',
  );
  await f.auth({
    auth_mode: "chatgpt",
    tokens: { access_token: "synthetic-oauth" },
  });
  let dir: string | undefined;
  const row = await fetchCodexConnectionUsage({
    home: f.home,
    env: { OTHER_KEY: "secret" },
    subscriptionUsage: async (input) => {
      dir = input.configDir;
      return quota;
    },
  });
  assert.equal(row.connection?.method, "subscription");
  assert.equal(dir, join(f.home, ".codex"));
  assert.deepEqual(row.windows, quota.windows);
});

test("Codex CODEX_HOME, helper and malformed config do not fall back to unrelated login", async (t) => {
  const f = await fixture(t);
  await f.codex(
    'model_provider="gateway"\n[model_providers.gateway]\nbase_url="https://gateway.example.test"\n[model_providers.gateway.auth]\ncommand="do-not-execute-secret"\n',
  );
  const row = await fetchCodexConnectionUsage({
    home: "/not-the-selected-home",
    env: { CODEX_HOME: join(f.home, ".codex") },
    subscriptionUsage: forbidden,
  });
  assert.equal(row.connection?.credential, "helper");
  assert.equal(JSON.stringify(row).includes("secret"), false);
  await f.codex("model_provider = [broken");
  assert.equal(
    (
      await fetchCodexConnectionUsage({
        home: f.home,
        env: {},
        subscriptionUsage: forbidden,
      })
    ).connection?.status,
    "unknown",
  );
});

test("Codex native subscription does not invent an API-key endpoint", async (t) => {
  const f = await fixture(t);
  await f.auth({
    auth_mode: "chatgpt",
    tokens: { access_token: "synthetic-oauth" },
  });
  const row = await fetchCodexConnectionUsage({
    home: f.home,
    env: {},
    subscriptionUsage: async () => quota,
  });
  assert.equal(row.connection?.method, "subscription");
  assert.equal(row.connection?.endpoint, undefined);
});

test("Codex missing/keyring auth and conflicting forced login remain unknown", async (t) => {
  const f = await fixture(t);
  await f.codex('cli_auth_credentials_store="keyring"');
  await f.auth({
    auth_mode: "chatgpt",
    tokens: { access_token: "stale-file-oauth" },
  });
  assert.equal(
    (
      await fetchCodexConnectionUsage({
        home: f.home,
        env: {},
        subscriptionUsage: forbidden,
      })
    ).connection?.status,
    "unknown",
  );
  await f.auth({ auth_mode: "apikey", OPENAI_API_KEY: "secret" });
  await f.codex('forced_login_method="chatgpt"');
  assert.equal(
    (
      await fetchCodexConnectionUsage({
        home: f.home,
        env: {},
        subscriptionUsage: forbidden,
      })
    ).connection?.status,
    "unknown",
  );
});

test("connection metadata crosses service/schema without secrets or fabricated windows", async (t) => {
  const f = await fixture(t);
  await f.claude({ apiKeyHelper: "secret-helper" });
  const service = new ProviderUsageService([
    {
      label: "Claude Code",
      provider: "claude-code",
      source: "private-api",
      fetch: async () => [
        await fetchClaudeConnectionUsage({
          home: f.home,
          env: {},
          subscriptionUsage: forbidden,
        }),
      ],
    },
  ]);
  const body = ProviderUsageResponse.parse(await service.list());
  assert.equal(body.providers[0]?.connection?.method, "api-key");
  assert.deepEqual(body.providers[0]?.windows, []);
  assert.equal(JSON.stringify(body).includes("secret"), false);
});
