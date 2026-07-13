import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import UsagePanel from './UsagePanel';

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
  it('says "version unknown", not "not installed", when a binary exists but its version is unverified', async () => {
    renderPanel();

    // Binary-present/version-unverified row: honest wording, meters intact.
    expect(await screen.findByText('version unknown')).toBeTruthy();
    expect(await screen.findByText('op@example.com')).toBeTruthy();

    // `not installed` renders exactly once - for the genuinely absent binary.
    const notInstalled = await screen.findAllByText('not installed');
    expect(notInstalled).toHaveLength(1);
  });
});
