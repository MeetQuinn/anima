import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProviderPanel from './ProviderPanel';

const contextApi = vi.hoisted(() => ({
  save: vi.fn(),
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
// NOTE: web vitest is not wired into CI yet (#344) - run locally via
// `pnpm --dir web test`.

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
        // Genuinely absent binary: the only state allowed to say so.
        agents: [],
        installSource: 'unknown' as const,
        label: 'Kimi CLI',
        operation: { status: 'idle' as const },
        provider: 'kimi-cli' as const,
        state: 'not_installed' as const,
        updateAvailable: false,
        updateMode: 'unavailable' as const,
      },
    ],
    upgradeLocked: false,
  })),
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
  fetchProviderAccounts: vi.fn(async () => ({
    providers: [
      {
        accounts: [
          {
            account: 'op@example.com',
            id: 'primary',
            label: 'Primary',
            profile: 'default' as const,
            selected: true,
            status: 'available' as const,
          },
        ],
        activeAccountId: 'primary',
        errorAgentIds: [],
        pendingAgentIds: [],
        provider: 'claude-code' as const,
        status: 'active' as const,
      },
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
  selectClaudeAccount: vi.fn(),
  saveProviderContextLimit: contextApi.save,
}));

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProviderPanel onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('ProviderPanel version slot', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('says "version unknown", not "not installed", when a binary exists but its version is unverified', async () => {
    renderPanel();

    // Collapsed rows surface version honesty without expanding.
    expect(await screen.findByText('version unknown')).toBeTruthy();
    // `not installed` renders exactly once - for the genuinely absent binary.
    const notInstalled = await screen.findAllByText('not installed');
    expect(notInstalled).toHaveLength(1);

    // Expand Claude to confirm meters still sit next to the unverified binary.
    fireEvent.click(screen.getByRole('button', { name: /Claude Code/i }));
    expect(await screen.findByText('op@example.com')).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy();
    expect(screen.getByText('cached')).toBeTruthy();
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
    renderPanel();

    // Context limit uses the shared Anima Select (not a native <select>).
    fireEvent.click(await screen.findByRole('button', { name: /Kimi CLI/i }));

    const trigger = await screen.findByRole('combobox', { name: 'Kimi CLI context limit' });
    expect(trigger.tagName).not.toBe('SELECT');
    expect(trigger.textContent).toMatch(/No Anima limit/i);
    fireEvent.click(trigger);
    expect(await screen.findByRole('option', { name: /No Anima limit/i })).toBeTruthy();
    expect(await screen.findByRole('option', { name: /256k · recommended/i })).toBeTruthy();
    // Save-on-change is the same Select → onContextLimitChange path used by Profile;
    // Base UI Select does not reliably fire item activation under fireEvent in jsdom.
  });
});
