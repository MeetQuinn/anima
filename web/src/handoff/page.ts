import {
  encryptHumanHandoffSecret,
  encodeHumanHandoffPublicKey,
  formatHumanHandoffBoxForSlack,
  parseHumanHandoffPublicKey,
} from '@shared/secret-handoff.ts';

export type HandoffPageState =
  | { kind: 'ready'; publicKey: string }
  | { kind: 'error'; title: string; message: string };

export interface EncryptedHumanTransfer {
  fencedBox: string;
}

export function requestStateFromFragment(fragment: string): HandoffPageState {
  const code = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!code) {
    return {
      kind: 'error',
      title: 'Encryption link required',
      message: 'Open the complete link you received, then try again.',
    };
  }
  try {
    return { kind: 'ready', publicKey: parseHumanHandoffPublicKey(code) };
  } catch {
    return {
      kind: 'error',
      title: 'Encryption link is invalid',
      message: 'Ask for a fresh complete link and open it again.',
    };
  }
}

export async function encryptHumanTransfer(
  publicKey: string,
  value: string,
): Promise<EncryptedHumanTransfer> {
  const box = await encryptHumanHandoffSecret(encodeHumanHandoffPublicKey(publicKey), value);
  return { fencedBox: formatHumanHandoffBoxForSlack(box) };
}
