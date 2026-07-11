// @vitest-environment node

import { describe, expect, it } from 'vitest';

import headers from '../../handoff/public/_headers?raw';
import html from '../../handoff/index.html?raw';

import {
  createHandoffKeyPair,
  createHandoffRequest,
  decryptHandoffSecret,
  encodeHandoffRequest,
} from '@shared/secret-handoff.ts';
import { encryptHumanTransfer, requestStateFromFragment } from './page';

const NOW = new Date('2026-07-11T12:00:00.000Z');

function humanFixture() {
  const keys = createHandoffKeyPair();
  const request = createHandoffRequest({
    recipientAgentId: 'milo',
    targetKey: 'SERVICE_TOKEN',
    purpose: 'Run the deployment verification job',
    sender: {
      kind: 'human',
      workspaceId: 'T01234567',
      workspaceName: 'Anima Team',
    },
    now: NOW,
    expiresAt: new Date('2026-07-12T12:00:00.000Z'),
    publicKey: keys.publicKey,
  });
  if (request.senderKind !== 'human') throw new Error('Human fixture is invalid');
  return { keys, request, code: encodeHandoffRequest(request) };
}

describe('human handoff page boundary', () => {
  it('parses only an unexpired human request with bound workspace metadata', () => {
    const { code } = humanFixture();
    const state = requestStateFromFragment(`#${code}`, NOW);
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.request.workspaceId).toBe('T01234567');
    expect(state.request.workspaceName).toBe('Anima Team');
    expect(state.request.targetKey).toBe('SERVICE_TOKEN');
  });

  it('never offers an input state for missing, malformed, expired, or agent requests', () => {
    expect(requestStateFromFragment('', NOW).kind).toBe('error');
    expect(requestStateFromFragment('#not-a-request', NOW).kind).toBe('error');
    const fixture = humanFixture();
    expect(
      requestStateFromFragment(`#${fixture.code}`, new Date('2026-07-13T00:00:00.000Z')).kind,
    ).toBe('error');

    const agentKeys = createHandoffKeyPair();
    const agentRequest = createHandoffRequest({
      recipientAgentId: 'milo',
      targetKey: 'SERVICE_TOKEN',
      purpose: 'Agent-only fixture',
      sender: { kind: 'agent', agentId: 'nora' },
      now: NOW,
      expiresAt: new Date('2026-07-12T12:00:00.000Z'),
      publicKey: agentKeys.publicKey,
    });
    expect(requestStateFromFragment(`#${encodeHandoffRequest(agentRequest)}`, NOW).kind).toBe(
      'error',
    );
  });

  it('produces a fenced browser box that the Node protocol accepts', async () => {
    const { keys, request } = humanFixture();
    const transfer = await encryptHumanTransfer(
      request,
      'browser-generated-secret-specimen',
      new Date('2026-07-11T12:05:00.000Z'),
    );
    expect(transfer.fencedBox).toMatch(/^```\nasec_box_v1_/);
    expect(transfer.fencedBox).not.toContain('browser-generated-secret-specimen');
    expect(transfer.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    await expect(
      decryptHandoffSecret(request, keys.privateKey, transfer.fencedBox),
    ).resolves.toMatchObject({
      senderKind: 'human',
      value: 'browser-generated-secret-specimen',
    });
  });

  it('ships a no-network CSP and host-enforced anti-frame headers', async () => {
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('noindex, nofollow, noarchive');
    expect(html).not.toMatch(/https?:\/\//);
    expect(headers).toContain("connect-src 'none'");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('X-Frame-Options: DENY');
  });
});
