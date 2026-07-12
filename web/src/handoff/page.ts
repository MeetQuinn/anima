import {
  encryptSealedHandoffSecret,
  encodeSealedHandoffPublicKey,
  formatSealedHandoffBoxForSlack,
  parseSealedHandoffPublicKey,
} from '@shared/secret-handoff.ts';

export type HandoffPageState =
  | { kind: 'ready'; publicKey: string }
  | { kind: 'error'; title: string; message: string };

export interface EncryptedSealedTransfer {
  fencedBox: string;
}

export function handoffStateFromFragment(fragment: string): HandoffPageState {
  const code = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!code) {
    return {
      kind: 'error',
      title: 'Encryption link required',
      message: 'Open the complete link you received, then try again.',
    };
  }
  try {
    return { kind: 'ready', publicKey: parseSealedHandoffPublicKey(code) };
  } catch {
    return {
      kind: 'error',
      title: 'Encryption link is invalid',
      message: 'Ask for a fresh complete link and open it again.',
    };
  }
}

export async function encryptSealedTransfer(
  publicKey: string,
  value: string,
): Promise<EncryptedSealedTransfer> {
  const box = await encryptSealedHandoffSecret(encodeSealedHandoffPublicKey(publicKey), value);
  return { fencedBox: formatSealedHandoffBoxForSlack(box) };
}
