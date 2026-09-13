import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderLoginRow } from '@shared/provider-login';

import UsagePanel from './UsagePanel';

const contextApi = vi.hoisted(() => ({
  save: vi.fn(),
}));
const runtimeCommandApi = vi.hoisted(() => ({
  save: vi.fn(),
}));
const loginApi = vi.hoisted(() => ({
  cancel: vi.fn(),
  fetch: vi.fn(async () => ({
    providers: [
      { command: 'claude', operation: { status: 'idle' as const }, provider: 'claude-code' as const, state: 'unsupported' as const },
      {
        checkedAt: '2026-07-13T04:00:00.000Z',
        command: 'mkimi',
        detail: 'Not logged in',
        operation: { status: 'idle' as const },
        provider: 'kimi-cli' as const,
        state: 'signed_out' as ProviderLoginRow['state'],
      },
    ],
  })),
  start: vi.fn(),
}));

// Version-slot honesty regression (#520 gate, Milo). The server has a
// distinct reachable shape for "binary present but version unverified":
// provider-inspection returns binaryPath + realPath + updateMode 'manual'
// and NO installedVersion when the executable resolves but `--version`
// fails, and providerRow() emits state 'unknown' - not 'not_installed'.
// The redesigned header must not collapse that shape into `not installed`
// (a false top-level fact, made stronger because the correcting context
// now lives inside the collapsed Details disclosure). `not installed` is
// reserved for state === 'not_installed'; anything else without a parsed
// version says `version unknown`.
//
// Runs in CI (`pnpm --dir web test`) and locally the same way.

vi.mock('@/api/system', () => ({
  applyProviderCliUpdate: vi.fn(),
  checkProviderClis: vi.fn(),
  fetchProviderCliStatus: vi.fn(async () => ({
    operation: { status: 'idle' as const },
    providers: [
      {
        // Milo's replay shape: resolvable binary, --version failed. A real
        // failure also loses install-source detection, so the server reports
        // installSource 'unknown' (gate fixture-fidelity note, #520).
        agents: [],
        binaryPath: '/Users/op/.local/bin/claude',
        installSource: 'unknown' as const,
        label: 'Claude Code',
        operation: { status: 'idle' as const },
        provider: 'claude-code' as const,
        realPath: '/Users/op/.local/share/claude/claude',
        sourceDetail: 'The active claude version could not be verified.',
        state: 'unknown' as const,
        updateAvailable: false,
        updateMode: 'manual' as const,
      },
      {
        // Installed provider with a context limit — carries the Settings disclosure.
        // Has an update available: that must NOT auto-expand the accordion.
        agents: [],
        installedVersion: '1.0.0',
        installSource: 'kimi-native' as const,
        label: 'Kimi CLI',
        latestVersion: '1.1.0',
        operation: { status: 'idle' as const },
        provider: 'kimi-cli' as const,
        state: 'ready' as const,
        updateAvailable: true,
        updateMode: 'manual' as const,
      },
      {
        // Genuinely absent binary: the provider is hidden from the panel entirely.
        agents: [],
        installSource: 'unknown' as const,
        label: 'Grok CLI',
        operation: { status: 'idle' as const },
        provider: 'grok-cli' as const,
        state: 'not_installed' as const,
        updateAvailable: false,
        updateMode: 'unavailable' as const,
      },
    ],
    upgradeLocked: false,
  })),
  cancelProviderLogin: loginApi.cancel,
  fetchProviderLogin: loginApi.fetch,
  fetchProviderContextLimits: vi.fn(async () => ({
    providers: [
      {
        maxTokens: null,
        presets: [131072, 262144],
        provider: 'kimi-cli' as const,
        recommended: 262144,
      },
    ],
  })),
  fetchProviderRuntimeCommands: vi.fn(async () => ({
    providers: [
      { args: [], command: null, defaultCommand: 'claude', provider: 'claude-code' as const },
      { args: [], command: null, defaultCommand: 'kimi', provider: 'kimi-cli' as const },
      { args: [], command: null, defaultCommand: 'grok', provider: 'grok-cli' as const },
    ],
  })),
  fetchProviderUsage: vi.fn(async () => ({
    providers: [
      {
        // Live usage alongside the unverified version - the exact combo
        // from the gate replay (account + meters next to a version claim).
        account: 'op@example.com',
        checkedAt: '2026-07-13T04:00:00.000Z',
        extras: [],
        label: 'Claude Code',
        provider: 'claude-code' as const,
        source: 'private-api' as const,
        stale: true,
        status: 'available' as const,
        windows: [
          {
            label: '5h',
            remainingPercent: 80,
            resetsAt: '2026-07-13T09:00:00.000Z',
            usedPercent: 20,
          },
        ],
      },
    ],
  })),
  fetchProviderUsageProvider: vi.fn(),
  refreshProviderUsage: vi.fn(async () => ({ providers: [] })),
  saveProviderContextLimit: contextApi.save,
  saveProviderRuntimeCommand: runtimeCommandApi.save,
  startProviderLogin: loginApi.start,
}));

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UsagePanel onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('UsagePanel version slot', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('says "version unknown" for an unverified binary and hides not-installed providers entirely', async () => {
    renderPanel();

    // Collapsed rows surface version honesty without expanding.
    expect(await screen.findByText('version unknown')).toBeTruthy();
    // A provider whose binary isn't on this machine renders nothing at all
    // (totoday 08-02) — no row, no `not installed` claim.
    expect(screen.queryByText('Grok CLI')).toBeNull();
    expect(screen.queryByText('not installed')).toBeNull();
    // An available update alone must not auto-expand a provider (totoday 08-02).
    const kimiToggle = screen.getByRole('button', { name: /Kimi CLI/i });
    expect(kimiToggle.getAttribute('aria-expanded')).toBe('false');

    // Expand Claude to confirm meters still sit next to the unverified binary.
    fireEvent.click(screen.getByRole('button', { name: /Claude Code/i }));
    expect(await screen.findByText('op@example.com')).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy();
    expect(screen.getByText('· cached')).toBeTruthy();
    // Version/binary rows stay gone. Runtime command makes Settings available.
    expect(screen.queryByText('Binary')).toBeNull();
    expect(screen.queryByRole('button', { name: /Add account/i })).toBeNull();
    fireEvent.click(screen.getByText(/Settings/i));
    const command = screen.getByRole('textbox', { name: 'Claude Code runtime command' });
    expect((command as HTMLInputElement).value).toBe('');
    expect(command.getAttribute('placeholder')).toBe('claude');

    // Manually expanding a collapsed provider must still surface its update
    // offer (#615 gate blocker: the offer block was guarded by needsAttention).
    fireEvent.click(kimiToggle);
    expect(await screen.findByText(/Update available/)).toBeTruthy();
  });

  it('offers the provider sign-in for a supported provider and starts the device flow', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Kimi CLI/i }));
    expect(await screen.findByText('Not signed in')).toBeTruthy();
    // Unsupported providers never render the block.
    fireEvent.click(await screen.findByRole('button', { name: /Claude Code/i }));
    expect(screen.queryByTestId('provider-sign-in-claude-code')).toBeNull();

    loginApi.start.mockResolvedValueOnce({
      providers: [
        {
          checkedAt: '2026-07-13T04:00:00.000Z',
          command: 'mkimi',
          operation: {
            code: 'ABCD-EFGH1',
            expiresAt: '2026-07-13T04:15:00.000Z',
            mode: 'device' as const,
            startedAt: '2026-07-13T04:00:00.000Z',
            status: 'running' as const,
            url: 'https://example.test/device',
          },
          provider: 'kimi-cli' as const,
          state: 'signed_out' as const,
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a code' }));
    await waitFor(() => expect(loginApi.start).toHaveBeenCalledWith('kimi-cli', 'device'));
    expect((await screen.findByLabelText('Kimi CLI one-time code')).textContent).toBe('ABCD-EFGH1');
    expect(screen.getByRole('link', { name: /example\.test\/device/ }).getAttribute('href')).toBe(
      'https://example.test/device',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    await waitFor(() => expect(loginApi.cancel).toHaveBeenCalledWith('kimi-cli'));
  });

  it('hides the sign-in controls entirely when the provider is already signed in', async () => {
    loginApi.fetch.mockResolvedValueOnce({
      providers: [
        {
          checkedAt: '2026-07-13T04:00:00.000Z',
          command: 'mkimi',
          detail: 'Logged in using ChatGPT',
          operation: { status: 'idle' as const },
          provider: 'kimi-cli' as const,
          state: 'signed_in' as const,
        },
      ],
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Kimi CLI/i }));
    expect(await screen.findByText('Signed in')).toBeTruthy();
    // No sign-in buttons and no command footer while signed in (totoday
    // 08-29): the status line is the whole block. When the credential
    // expires the CLI reports signed_out and the controls come back.
    expect(screen.queryByRole('button', { name: 'Sign in with a code' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in on this machine' })).toBeNull();
    expect(screen.queryByText(/as this machine user/)).toBeNull();
  });

  it('shows the global Kimi context limit and saves the recommended cap', async () => {
    contextApi.save.mockResolvedValueOnce({
      providers: [
        {
          maxTokens: 262144,
          presets: [131072, 262144],
          provider: 'kimi-cli',
          recommended: 262144,
        },
      ],
    });
    runtimeCommandApi.save.mockResolvedValueOnce({
      providers: [
        { args: ['--profile', 'team one'], command: 'kimi-wrapper', defaultCommand: 'kimi', provider: 'kimi-cli' },
      ],
    });
    renderPanel();

    // Runtime command is global for all providers; context limit remains beside
    // it only for providers that support the managed cap.
    fireEvent.click(await screen.findByRole('button', { name: /Kimi CLI/i }));
    fireEvent.click(screen.getByText(/Settings/i));

    const command = screen.getByRole('textbox', { name: 'Kimi CLI runtime command' });
    expect(command.getAttribute('placeholder')).toBe('kimi');
    fireEvent.change(command, { target: { value: 'kimi-wrapper' } });
    const args = screen.getByRole('textbox', { name: 'Kimi CLI runtime arguments' });
    fireEvent.change(args, { target: { value: '--profile\nteam one\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(runtimeCommandApi.save).toHaveBeenCalledWith(
        'kimi-cli',
        'kimi-wrapper',
        ['--profile', 'team one'],
      ),
    );

    const select = await screen.findByRole('combobox', { name: 'Kimi CLI context limit' });
    expect((select as HTMLSelectElement).value).toBe('no-anima-limit');
    expect(screen.getByRole('option', { name: 'No Anima limit' })).toBeTruthy();
    expect(
      screen.getByText('Global for every agent. Applies when its provider session next starts.'),
    ).toBeTruthy();
    fireEvent.change(select, { target: { value: '262144' } });
    await waitFor(() => expect(contextApi.save).toHaveBeenCalledWith('kimi-cli', 262144));
  });
});
