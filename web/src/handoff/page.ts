import {
  encryptHandoffSecret,
  formatHandoffBoxForSlack,
  handoffSecretFingerprint,
  parseHandoffRequest,
  validateRequestNotExpired,
  type HandoffRequest,
} from '@shared/secret-handoff.ts';

export type HumanHandoffRequest = Extract<HandoffRequest, { senderKind: 'human' }>;

export type HandoffPageState =
  | { kind: 'ready'; request: HumanHandoffRequest }
  | { kind: 'error'; title: string; message: string };

export interface EncryptedHumanTransfer {
  fencedBox: string;
  fingerprint: string;
}

export function requestStateFromFragment(
  fragment: string,
  now: Date = new Date(),
): HandoffPageState {
  const code = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!code) {
    return {
      kind: 'error',
      title: 'Request link required',
      message: 'Open the complete secure handoff link from the originating Slack conversation.',
    };
  }
  try {
    const request = parseHandoffRequest(code);
    if (request.senderKind !== 'human') {
      return {
        kind: 'error',
        title: 'Agent request',
        message: 'This request must be completed by the named sending agent, not in a browser.',
      };
    }
    validateRequestNotExpired(request, now);
    return { kind: 'ready', request };
  } catch (error) {
    const expired = error instanceof Error && /expired/i.test(error.message);
    return {
      kind: 'error',
      title: expired ? 'Request expired' : 'Request link is invalid',
      message: expired
        ? 'Ask the receiving agent to create a new secure handoff request.'
        : 'Return to Slack and ask the receiving agent for a fresh complete link.',
    };
  }
}

export async function encryptHumanTransfer(
  request: HumanHandoffRequest,
  value: string,
  now: Date = new Date(),
): Promise<EncryptedHumanTransfer> {
  const box = await encryptHandoffSecret(request, {
    sender: { kind: 'human' },
    value,
    now,
  });
  return {
    fencedBox: formatHandoffBoxForSlack(box),
    fingerprint: await handoffSecretFingerprint(value),
  };
}

export function localExpiry(request: HumanHandoffRequest): {
  formatted: string;
  timezone: string;
} {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  return {
    formatted: new Intl.DateTimeFormat(undefined, {
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(new Date(request.expiresAt)),
    timezone,
  };
}
