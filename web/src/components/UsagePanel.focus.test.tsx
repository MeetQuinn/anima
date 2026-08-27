import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderUsageRow } from '@shared/provider-usage';
import UsagePanel from './UsagePanel';

// Focus, naming and Escape contract for the Providers panel — the second half of
// group C, the last adoption cut of the `aria-modal` sweep.
//
// Escape must respect topmost dialog: with a confirm layered over Providers,
// the first Escape answers only the confirm.
//
// Runs in CI (`pnpm --dir web test`) and locally the same way.

const api = vi.hoisted(() => ({
  applyProviderCliUpdate: vi.fn(),
  refreshProviderUsage: vi.fn(async () => ({ providers: [] })),
}));

const usageRows = vi.hoisted(() => ({
  value: [
    {
      account: 'op@example.com',
      checkedAt: '2026-08-14T09:00:00.000Z',
      extras: [],
      label: 'Claude Code',
      provider: 'claude-code',
      source: 'private-api',
      status: 'available',
      windows: [{ label: '5h', remainingPercent: 64, resetsAt: '2030-01-01T05:00:00.000Z' }],
    },
  ] as ProviderUsageRow[],
}));

vi.mock('@/api/system', () => ({
  applyProviderCliUpdate: api.applyProviderCliUpdate,
  checkProviderClis: vi.fn(),
  fetchProviderCliStatus: vi.fn(async () => ({
    operation: { status: 'idle' as const },
    providers: [
      {
        agents: [{ enabled: true, name: 'Scout', runningVersion: '2.1.0' }],
        installSource: 'claude-native' as const,
        installedVersion: '2.1.0',
        label: 'Claude Code',
        latestVersion: '2.2.0',
        operation: { status: 'idle' as const },
        provider: 'claude-code' as const,
        state: 'current' as const,
        updateAvailable: true,
        updateMode: 'managed' as const,
      },
    ],
    upgradeLocked: false,
  })),
  cancelProviderLogin: vi.fn(),
  fetchProviderLogin: vi.fn(async () => ({ providers: [] })),
  fetchProviderContextLimits: vi.fn(async () => ({ providers: [] })),
  fetchProviderRuntimeCommands: vi.fn(async () => ({ providers: [] })),
  fetchProviderUsage: vi.fn(async () => ({ providers: usageRows.value })),
  refreshProviderUsage: api.refreshProviderUsage,
  saveProviderContextLimit: vi.fn(),
  saveProviderRuntimeCommand: vi.fn(),
  startProviderLogin: vi.fn(),
}));

/** An outside opener plus the panel it opens, so restore has somewhere to go. */
function PanelHost() {
  const [open, setOpen] = useState(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <button type="button" onClick={() => setOpen(true)}>
        Providers
      </button>
      {open && <UsagePanel onClose={() => setOpen(false)} />}
    </QueryClientProvider>
  );
}

async function openPanel() {
  render(<PanelHost />);
  const opener = screen.getByRole('button', { name: 'Providers' });
  opener.focus();
  fireEvent.click(opener);
  const panel = await screen.findByRole('dialog', { name: 'Providers' });
  await screen.findByRole('button', { name: /Claude Code/i });
  return { opener, panel };
}

/** Cold start collapses every provider; open Claude to reach update controls. */
async function expandClaude() {
  const toggle = await screen.findByRole('button', { name: /Claude Code/i });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
}

describe('Providers panel — focus contract', () => {
  it('lands focus in the panel, on nothing that would act', async () => {
    const { opener, panel } = await openPanel();

    expect(document.activeElement).toBe(panel);
    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: 'Refresh providers' }),
    );
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: 'Close providers panel' }),
    );
  });

  it('keeps Tab inside the panel instead of the app behind it', async () => {
    const { opener, panel } = await openPanel();

    const forward = fireEvent.keyDown(panel, { key: 'Tab' });
    expect(forward).toBe(false);
    expect(document.activeElement).not.toBe(panel);
    expect(panel.contains(document.activeElement)).toBe(true);
    const first = document.activeElement!;

    const backward = fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(backward).toBe(false);
    expect(document.activeElement).not.toBe(first);
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);
  });

  it('takes its accessible name from the visible header rather than a second copy of the word', async () => {
    const { panel } = await openPanel();

    expect(panel.hasAttribute('aria-label')).toBe(false);
    const labelledBy = panel.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading?.textContent?.trim()).toBe('Providers');
    expect(panel.contains(heading)).toBe(true);
  });

  it('returns focus to the control that opened it', async () => {
    const { opener } = await openPanel();
    expect(document.activeElement).not.toBe(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Close providers panel' }));

    expect(screen.queryByRole('dialog', { name: 'Providers' })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('Providers panel — Escape dismissal', () => {
  it('still closes on Escape when it is the only dialog', async () => {
    const { panel } = await openPanel();

    fireEvent.keyDown(panel, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Providers' })).toBeNull();
  });

  it('closes only the confirm on the first Escape, and the panel on the second', async () => {
    await openPanel();
    await expandClaude();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    const confirm = await screen.findByRole('dialog', { name: 'Update Claude Code?' });

    fireEvent.keyDown(confirm, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Update Claude Code?' })).toBeNull();
    const panel = screen.getByRole('dialog', { name: 'Providers' });

    fireEvent.keyDown(panel, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Providers' })).toBeNull();
    expect(api.applyProviderCliUpdate).not.toHaveBeenCalled();
  });
});
