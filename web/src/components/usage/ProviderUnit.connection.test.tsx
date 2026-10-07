import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderCliRow } from '@shared/provider-cli';
import type { ProviderConnection, ProviderUsageRow } from '@shared/provider-usage';
import { ProviderUnit } from './ProviderUnit';
import { providerCollapsedSummary } from './format';

afterEach(cleanup);

const management: ProviderCliRow = {
  agents: [],
  installSource: 'claude-native',
  installedVersion: '2.1.284',
  label: 'Claude Code',
  operation: { status: 'idle' },
  provider: 'claude-code',
  state: 'current',
  updateAvailable: false,
  updateMode: 'managed',
};
const connection: ProviderConnection = {
  method: 'api-key',
  credential: 'helper',
  endpoint: 'http://127.0.0.1:18318',
  scope: 'machine-default',
  status: 'configured',
};
function usage(extra: Partial<ProviderUsageRow> = {}): ProviderUsageRow {
  return {
    checkedAt: '2026-10-07T12:00:00Z',
    connection,
    extras: [],
    label: 'Claude Code',
    provider: 'claude-code',
    source: 'private-api',
    status: 'unavailable',
    windows: [],
    ...extra,
  };
}
function show(row: ProviderUsageRow) {
  return render(
    <ProviderUnit
      expanded
      management={management}
      now={new Date('2026-10-07T12:00:00Z')}
      onApply={() => {}}
      onCopyCommand={() => {}}
      onToggleExpanded={() => {}}
      usages={[row]}
      onContextLimitChange={() => {}}
      runtimeCommand={{
        provider: 'claude-code',
        command: null,
        defaultCommand: 'claude',
        args: [],
      }}
      onRuntimeCommandSave={() => {}}
      login={{
        provider: 'claude-code',
        command: 'claude',
        state: 'signed_out',
        operation: { status: 'idle' },
      }}
      onLoginStart={() => {}}
      onLoginCancel={() => {}}
    />,
  );
}

describe('Provider connection display', () => {
  it('shows CPA configuration and endpoint without OAuth prompt, invented quota or connection success', () => {
    show(usage());
    expect(screen.getByText('API key · Configured')).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:18318')).toBeTruthy();
    expect(screen.getByText('Credential helper configured')).toBeTruthy();
    expect(screen.getByText('Usage is managed by your API provider or gateway.')).toBeTruthy();
    expect(screen.queryByText('Not configured')).toBeNull();
    expect(
      screen.queryByText(/OAuth token not found|Sign in on this machine|0%|Connected/),
    ).toBeNull();
    expect(providerCollapsedSummary([usage()])).toBe('API key · Configured');
  });
  it('keeps subscription quota, account and failure state separate from credential configuration', () => {
    const view = show(
      usage({
        connection: { ...connection, method: 'subscription', credential: 'stored-login' },
        account: 'synthetic@example.test',
        status: 'available',
        windows: [{ label: '5h', remainingPercent: 70 }],
      }),
    );
    expect(screen.getByText('Subscription · Configured')).toBeTruthy();
    expect(screen.getByText('synthetic@example.test')).toBeTruthy();
    expect(screen.getByText('70%')).toBeTruthy();
    view.unmount();
    show(
      usage({
        connection: { ...connection, method: 'subscription' },
        error: { type: 'unauthorized', message: 'Stored subscription login expired.' },
      }),
    );
    expect(screen.getByText('Auth expired')).toBeTruthy();
    expect(screen.getByText('Subscription · Configured')).toBeTruthy();
  });
  it('does not call unknown cloud/keyring credentials signed out or connected', () => {
    show(
      usage({
        connection: {
          credential: 'none',
          method: 'unknown',
          scope: 'machine-default',
          status: 'unknown',
        },
      }),
    );
    expect(screen.getByText('Authentication · Not inspected')).toBeTruthy();
    expect(screen.queryByText('Not configured')).toBeNull();
  });
  it('continues to render old runtime rows without connection metadata', () => {
    show(
      usage({
        connection: undefined,
        error: { type: 'not_configured', message: 'Legacy missing token' },
      }),
    );
    expect(screen.getByText('Not configured')).toBeTruthy();
    expect(screen.getByText('Legacy missing token')).toBeTruthy();
  });
});
