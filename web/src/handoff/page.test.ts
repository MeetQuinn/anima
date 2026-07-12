// @vitest-environment node

import { describe, expect, it } from 'vitest';

import headers from '../../handoff/public/_headers?raw';
import html from '../../handoff/index.html?raw';

import {
  createHandoffKeyPair,
  decryptSealedHandoffSecret,
  encodeSealedHandoffPublicKey,
  parseSealedHandoffBox,
} from '@shared/secret-handoff.ts';
import { encryptSealedTransfer, handoffStateFromFragment } from './page';

describe('public-key handoff page boundary', () => {
  it('accepts only a versioned public key in the URL fragment', () => {
    const keys = createHandoffKeyPair();
    const code = encodeSealedHandoffPublicKey(keys.publicKey);
    expect(handoffStateFromFragment(`#${code}`)).toEqual({
      kind: 'ready',
      publicKey: keys.publicKey,
    });
    expect(code).toBe(`asec_key_v1_${keys.publicKey}`);
    expect(code).not.toMatch(/milo|workspace|SERVICE_TOKEN|purpose|expires/i);
  });

  it('never offers an input state for a missing or malformed public key', () => {
    expect(handoffStateFromFragment('').kind).toBe('error');
    expect(handoffStateFromFragment('#not-a-key').kind).toBe('error');
    expect(handoffStateFromFragment('#asec_key_v1_deadbeef').kind).toBe('error');
  });

  it('produces a generic fenced box that the matching private key opens', async () => {
    const keys = createHandoffKeyPair();
    const transfer = await encryptSealedTransfer(
      keys.publicKey,
      'browser-generated-secret-specimen',
    );
    expect(transfer.fencedBox).toMatch(/^```\nasec_sealed_v1_/);
    expect(transfer.fencedBox).not.toContain('browser-generated-secret-specimen');
    expect(parseSealedHandoffBox(transfer.fencedBox).publicKey).toBe(keys.publicKey);
    expect(decryptSealedHandoffSecret(keys.privateKey, transfer.fencedBox)).toEqual({
      v: 1,
      value: 'browser-generated-secret-specimen',
    });
  });

  it('ships a no-network CSP and host-enforced anti-frame headers', () => {
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('noindex, nofollow, noarchive');
    expect(html).not.toMatch(/https?:\/\//);
    expect(headers).toContain("connect-src 'none'");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('X-Frame-Options: DENY');
  });
});
