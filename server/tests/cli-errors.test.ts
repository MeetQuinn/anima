import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderCliError } from '../cli/cli-errors.js';
import { FeishuApiError } from '../feishu/client.js';
import { startSlackApiMock } from './helpers/slack-api.js';

const cliPath = resolve('dist/server/cli/anima.js');

test('anima CLI help still prints normally and exits successfully', async () => {
  const result = await runNode([cliPath, '--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: anima /);
  assert.equal(result.stderr, '');
});

test('anima CLI renders Commander failures through the structured error contract', async () => {
  const result = await runNode([cliPath, 'message', 'send', '--definitely-unknown'], {
    input: 'hello',
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /^error input\.invalid_options \(not retryable\): Run the command with --help to see valid options, then retry\./,
  );
  assert.doesNotMatch(result.stderr, /^error: unknown option/m);
});

test('anima CLI renders missing agent context as anima.no_agent_context', async () => {
  const result = await runNode([cliPath, 'history']);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.trim(), 'error anima.no_agent_context (not retryable): Pass --agent <id> or set ANIMA_AGENT_ID.');
});

test('anima CLI renders Slack channel_not_found with the recovery hint', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-errors-slack-'));
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'chat.postMessage') return { error: 'channel_not_found', ok: false };
    if (method === 'conversations.info') return { error: 'channel_not_found', ok: false };
    if (method === 'users.list') return { members: [], ok: true };
    if (method === 'conversations.list') return { channels: [], ok: true };
    if (method === 'conversations.members') return { members: [], ok: true };
    throw new Error(`unexpected method ${method}`);
  });

  try {
    await writeSlackConfig(stateDir);
    const result = await runNode([cliPath, 'message', 'send', '--channel', 'C-missing'], {
      env: {
        ...process.env,
        ANIMA_AGENT_ID: 'scout',
        ANIMA_HOME: stateDir,
        ANIMA_SLACK_API_URL: slackApi.url,
      },
      input: 'hello',
    });
    assert.notEqual(result.status, 0);
    assert.equal(
      result.stderr.trim(),
      'error slack.channel_not_found (not retryable): You cannot see a channel with that id. Verify it from a recent envelope or anima history, not from memory.',
    );
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('anima CLI renders Slack rate limits as retryable', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-errors-rate-limit-'));
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'chat.postMessage') return { error: 'ratelimited', ok: false };
    if (method === 'conversations.info') {
      return { channel: { id: 'C-product', is_channel: true, name: 'product' }, ok: true };
    }
    if (method === 'users.list') return { members: [], ok: true };
    if (method === 'conversations.list') {
      return { channels: [{ id: 'C-product', is_channel: true, name: 'product' }], ok: true };
    }
    if (method === 'conversations.members') return { members: [], ok: true };
    throw new Error(`unexpected method ${method}`);
  });

  try {
    await writeSlackConfig(stateDir);
    const result = await runNode([cliPath, 'message', 'send', '--channel', 'C-product'], {
      env: {
        ...process.env,
        ANIMA_AGENT_ID: 'scout',
        ANIMA_HOME: stateDir,
        ANIMA_SLACK_API_URL: slackApi.url,
      },
      input: 'hello',
    });
    assert.notEqual(result.status, 0);
    assert.equal(
      result.stderr.trim(),
      'error slack.ratelimited (retryable): Slack rate limit; wait the Retry-After interval before the next call.',
    );
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('CLI renderer preserves Feishu numeric codes and redacts detail secrets', () => {
  const rendered = renderCliError(new FeishuApiError({
    code: 230002,
    operation: 'Feishu send failed',
    vendorMessage: 'bad request token=xoxb-secret-token app_secret=abc123',
  }));
  assert.match(rendered ?? '', /^error feishu\.230002 \(not retryable\): /);
  assert.match(rendered ?? '', /detail: Feishu send failed: bad request token=\[redacted\] app_secret=\[redacted\]/);
  assert.doesNotMatch(rendered ?? '', /xoxb-secret-token|abc123/);
});

test('CLI renderer redacts secrets in seeded Slack auth failures', () => {
  const error = Object.assign(new Error('invalid_auth token=xoxb-secret-token'), {
    data: { error: 'invalid_auth', ok: false },
  });
  const rendered = renderCliError(error);
  assert.equal(
    rendered,
    'error slack.invalid_auth (not retryable): Slack rejected the token; reconnect Slack from the dashboard first.',
  );
  assert.doesNotMatch(rendered ?? '', /xoxb-secret-token/);
});

test('CLI renderer redacts JSON-style secret detail fields', () => {
  const rendered = renderCliError(new Error('vendor payload {"app_secret":"abc123","token":"tok456"}'));
  assert.match(rendered ?? '', /^error anima\.unexpected \(not retryable\): /);
  assert.match(rendered ?? '', /"app_secret":"\[redacted\]"/);
  assert.match(rendered ?? '', /"token":"\[redacted\]"/);
  assert.doesNotMatch(rendered ?? '', /abc123|tok456/);
});

test('CLI renderer preserves vendor codes ahead of message-text network matches', () => {
  const error = Object.assign(new Error('request timed out'), {
    data: { error: 'channel_not_found', ok: false },
  });
  assert.equal(
    renderCliError(error),
    'error slack.channel_not_found (not retryable): You cannot see a channel with that id. Verify it from a recent envelope or anima history, not from memory.',
  );
});

test('CLI renderer preserves Slack handle ambiguity detail', () => {
  const rendered = renderCliError(new Error('Slack handle @alex matched multiple users'));
  assert.equal(
    rendered,
    [
      'error anima.ambiguous_user (not retryable): Slack rejected the request; use the vendor code and detail to choose the next move.',
      'detail: Slack handle @alex matched multiple users',
    ].join('\n'),
  );
  assert.doesNotMatch(rendered ?? '', /No such Slack user/);
});

test('CLI renderer classifies DNS failures as retryable network errors', () => {
  const error = Object.assign(new Error('getaddrinfo ENOTFOUND slack.com'), { code: 'ENOTFOUND' });
  assert.equal(
    renderCliError(error),
    'error network.dns_failure (retryable): Name resolution failed; retry with backoff, and say so in-channel if it persists.',
  );
});

async function writeSlackConfig(configDir: string): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const agent = {
    id: 'scout',
    slack: {
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      teamId: 'T-demo',
    },
  };
  const agentDir = join(configDir, 'agents', agent.id);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify({}, null, 2)}\n`, 'utf8');
  await writeFile(join(agentDir, 'config.json'), `${JSON.stringify(agent, null, 2)}\n`, 'utf8');
}

async function runNode(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const child = spawn(process.execPath, args, {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(options.input);
  const [status] = (await once(child, 'exit')) as [number | null];
  return { status, stderr, stdout };
}
