import { ZodError } from 'zod';

type CliErrorLayer = 'input' | 'anima' | 'slack' | 'feishu' | 'network';
type CliErrorCode = `${CliErrorLayer}.${string}`;

export interface CliErrorClassification {
  code: CliErrorCode;
  detail?: string;
  hint: string;
  retryable: boolean;
}

export class CliError extends Error {
  readonly cli: CliErrorClassification;

  constructor(classification: CliErrorClassification) {
    super(classification.hint);
    this.name = 'CliError';
    this.cli = classification;
  }
}

export function renderCliError(error: unknown): string | undefined {
  if (isCommanderHelp(error)) return undefined;
  const classification = classifyCliError(error);
  const retryable = classification.retryable ? 'retryable' : 'not retryable';
  const firstLine = `error ${classification.code} (${retryable}): ${classification.hint}`;
  return classification.detail ? `${firstLine}\ndetail: ${classification.detail}` : firstLine;
}

export function cliError(classification: CliErrorClassification): CliError {
  return new CliError(classification);
}

function classifyCliError(error: unknown): CliErrorClassification {
  if (error instanceof CliError) return error.cli;

  const commander = classifyCommanderError(error);
  if (commander) return commander;

  const zod = classifyZodError(error);
  if (zod) return zod;

  const slack = classifySlackError(error);
  if (slack) return slack;

  const feishu = classifyFeishuError(error);
  if (feishu) return feishu;

  const network = classifyNetworkError(error);
  if (network) return network;

  const local = classifyLocalMessage(messageOf(error));
  if (local) return local;

  return {
    code: 'anima.unexpected',
    detail: sanitizedDetail(messageOf(error)),
    hint: 'Anima hit an unexpected error; stop and ask the operator to inspect the detail.',
    retryable: false,
  };
}

function classifyCommanderError(error: unknown): CliErrorClassification | undefined {
  const record = asRecord(error);
  const code = stringField(record, 'code');
  if (!code?.startsWith('commander.')) return undefined;
  if (code === 'commander.helpDisplayed') return undefined;
  return {
    code: 'input.invalid_options',
    hint: 'Run the command with --help to see valid options, then retry.',
    retryable: false,
  };
}

function classifyZodError(error: unknown): CliErrorClassification | undefined {
  if (!(error instanceof ZodError)) return undefined;
  const issue = error.issues[0];
  return {
    code: 'input.invalid_options',
    ...(issue?.message ? { detail: sanitizedDetail(issue.message) } : {}),
    hint: 'Check the command options and try again.',
    retryable: false,
  };
}

function classifyNetworkError(error: unknown): CliErrorClassification | undefined {
  const codes = errorCodeChain(error);
  const messages = errorMessageChain(error).join('\n');
  if (codes.some((code) => code === 'ENOTFOUND' || code === 'EAI_AGAIN')) {
    return {
      code: 'network.dns_failure',
      hint: 'Name resolution failed; retry with backoff, and say so in-channel if it persists.',
      retryable: true,
    };
  }
  if (codes.some((code) => code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT')
    || /\b(timeout|timed out|aborted)\b/i.test(messages)) {
    return {
      code: 'network.timeout',
      hint: 'Request timed out; retry with backoff.',
      retryable: true,
    };
  }
  if (codes.some((code) => code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE')
    || /socket disconnected|could not reach|connection (?:failed|refused|reset)/i.test(messages)) {
    return {
      code: 'network.connection_failed',
      hint: 'Could not reach the service; retry with backoff and escalate if it persists.',
      retryable: true,
    };
  }
  return undefined;
}

function classifySlackError(error: unknown): CliErrorClassification | undefined {
  const record = asRecord(error);
  const data = asRecord(record?.['data']);
  const vendorCode = stringField(data, 'error');
  const sdkCode = stringField(record, 'code');
  if (sdkCode === 'slack_webapi_rate_limited_error' || vendorCode === 'ratelimited' || vendorCode === 'rate_limited') {
    return {
      code: 'slack.ratelimited',
      hint: 'Slack rate limit; wait the Retry-After interval before the next call.',
      retryable: true,
    };
  }
  if (vendorCode) return slackVendorClassification(vendorCode, messageOf(error));
  const local = slackCodeFromLocalMessage(messageOf(error));
  return local ? slackVendorClassification(local, messageOf(error)) : undefined;
}

function slackVendorClassification(vendorCode: string, message: string): CliErrorClassification {
  const seeded = SLACK_HINTS[vendorCode];
  if (seeded) {
    return {
      code: `slack.${vendorCode}`,
      hint: seeded.hint,
      retryable: seeded.retryable,
    };
  }
  if (vendorCode === 'ambiguous_user') {
    return {
      code: 'anima.ambiguous_user',
      detail: sanitizedDetail(message),
      hint: 'That handle matches more than one user; use the exact user id from a recent envelope, anima history, or team.md.',
      retryable: false,
    };
  }
  return {
    code: `slack.${normalizeVendorSegment(vendorCode)}`,
    detail: sanitizedDetail(message),
    hint: 'Slack rejected the request; use the vendor code and detail to choose the next move.',
    retryable: false,
  };
}

function classifyFeishuError(error: unknown): CliErrorClassification | undefined {
  const record = asRecord(error);
  const numericCode = feishuNumericCode(record);
  if (!numericCode) return undefined;
  const seeded = FEISHU_HINTS[numericCode];
  return {
    code: `feishu.${numericCode}`,
    ...(seeded ? {} : { detail: sanitizedDetail(messageOf(error)) }),
    hint: seeded?.hint ?? 'Feishu rejected the request; use the numeric code and detail to choose the next move.',
    retryable: seeded?.retryable ?? false,
  };
}

function classifyLocalMessage(message: string): CliErrorClassification | undefined {
  if (/Agent not specified|requires current agent context|requires ANIMA_AGENT_ID/i.test(message)) {
    return {
      code: 'anima.no_agent_context',
      hint: 'Pass --agent <id> or set ANIMA_AGENT_ID.',
      retryable: false,
    };
  }
  if (/no Slack team id configured|slack\.botToken is required|configure slack\.botToken|has no Slack connection/i.test(message)) {
    return {
      code: 'anima.no_slack_team',
      hint: 'This agent has no Slack team configured; connect Slack from the dashboard first.',
      retryable: false,
    };
  }
  if (/has no Feishu connection configured/i.test(message)) {
    return {
      code: 'anima.no_feishu_connection',
      hint: 'This agent has no Feishu connection configured; connect Feishu from the dashboard first.',
      retryable: false,
    };
  }
  if (/accepts either --channel or --chat-id, not both/i.test(message)) {
    return {
      code: 'input.channel_and_chat_id',
      hint: 'Pass either --channel or --chat-id, not both.',
      retryable: false,
    };
  }
  if (/--chat-id must be a Feishu chat_id|requires --chat-id or --channel with an oc_/i.test(message)) {
    return {
      code: 'input.invalid_chat_id',
      hint: '--chat-id must be a Feishu chat id starting with oc_.',
      retryable: false,
    };
  }
  if (/requires --channel|Missing --channel|Slack channel is required|requires --channel unless/i.test(message)) {
    return {
      code: 'input.missing_channel',
      hint: 'Pass --channel, or run from a context whose current item has a Slack surface.',
      retryable: false,
    };
  }
  if (/ask requires 2.+5 --option values/i.test(message)) {
    return {
      code: 'input.invalid_options',
      hint: 'anima ask needs 2 to 5 --option values.',
      retryable: false,
    };
  }
  if (/Secret values must be passed on stdin/i.test(message)) {
    return {
      code: 'input.secret_on_argv',
      hint: 'Secrets go on stdin, never as a command argument; rotate this value if it was real.',
      retryable: false,
    };
  }
  if (/message search requires at least one keyword/i.test(message)) {
    return {
      code: 'input.missing_keyword',
      hint: 'message search needs at least one keyword.',
      retryable: false,
    };
  }
  if (/must be an ISO timestamp|file not found|not a regular file|file is empty|requires at least one path|requires --name|requires --message-ts|requires --message-id|requires --reaction-id|requires <fileId>|Pass only one of|Do not combine|unsupported:/i.test(message)) {
    return {
      code: 'input.invalid_options',
      detail: sanitizedDetail(message),
      hint: 'Check the command options and try again.',
      retryable: false,
    };
  }
  return undefined;
}

function isCommanderHelp(error: unknown): boolean {
  const record = asRecord(error);
  return stringField(record, 'code') === 'commander.helpDisplayed';
}

function slackCodeFromLocalMessage(message: string): string | undefined {
  if (/Slack channel not found/i.test(message)) return 'channel_not_found';
  if (/Slack user not found/i.test(message)) return 'user_not_found';
  if (/Slack handle .* matched multiple users/i.test(message)) return 'ambiguous_user';
  if (/cannot_dm_bot/i.test(message)) return 'cannot_dm_bot';
  return undefined;
}

function feishuNumericCode(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  const direct = record['code'];
  if (typeof direct === 'number' && Number.isInteger(direct)) return String(direct);
  if (typeof direct === 'string' && /^\d+$/.test(direct)) return direct;
  const data = asRecord(record['data']);
  const dataCode = data?.['code'];
  if (typeof dataCode === 'number' && Number.isInteger(dataCode)) return String(dataCode);
  if (typeof dataCode === 'string' && /^\d+$/.test(dataCode)) return dataCode;
  return undefined;
}

function errorCodeChain(error: unknown): string[] {
  const codes: string[] = [];
  for (let current: unknown = error; current; current = asRecord(current)?.['cause']) {
    const code = stringField(asRecord(current), 'code');
    if (code) codes.push(code);
  }
  return codes;
}

function errorMessageChain(error: unknown): string[] {
  const messages: string[] = [];
  for (let current: unknown = error; current; current = asRecord(current)?.['cause']) {
    const message = messageOf(current);
    if (message) messages.push(message);
  }
  return messages;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizedDetail(value: string): string | undefined {
  const cleaned = redactSecrets(value).replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 500) : undefined;
}

function redactSecrets(value: string): string {
  return value
    .replace(/xox[a-z]-[A-Za-z0-9-]+/g, '[redacted]')
    .replace(/xapp-[A-Za-z0-9-]+/g, '[redacted]')
    .replace(/(authorization:\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:["'])?(?:token|secret|app_secret|botToken|appToken)(?:["'])?\s*:\s*(?:["']))[^"']*((?:["']))/gi, '$1[redacted]$2')
    .replace(/((?:token|secret|app_secret|botToken|appToken)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}

function normalizeVendorSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_') || 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

const SLACK_HINTS: Record<string, { hint: string; retryable: boolean }> = {
  account_inactive: {
    hint: 'Slack rejected the token; reconnect Slack from the dashboard first.',
    retryable: false,
  },
  cannot_dm_bot: {
    hint: 'Slack blocks bot-to-bot DMs. Reach that agent by @mention in a shared channel or thread.',
    retryable: false,
  },
  channel_not_found: {
    hint: 'You cannot see a channel with that id. Verify it from a recent envelope or anima history, not from memory.',
    retryable: false,
  },
  invalid_auth: {
    hint: 'Slack rejected the token; reconnect Slack from the dashboard first.',
    retryable: false,
  },
  message_not_found: {
    hint: 'That message is gone or the ts is wrong; re-read the thread before reacting or replying.',
    retryable: false,
  },
  missing_scope: {
    hint: 'Slack says this app is missing a scope; ask the operator to update the Slack app permissions.',
    retryable: false,
  },
  not_authed: {
    hint: 'Slack rejected the token; reconnect Slack from the dashboard first.',
    retryable: false,
  },
  not_in_channel: {
    hint: 'You are not a member there. Get invited or post where you already are.',
    retryable: false,
  },
  token_revoked: {
    hint: 'Slack rejected the token; reconnect Slack from the dashboard first.',
    retryable: false,
  },
  user_not_found: {
    hint: 'No such Slack user; take ids from history or team.md, not from memory.',
    retryable: false,
  },
};

const FEISHU_HINTS: Record<string, { hint: string; retryable: boolean }> = {};
