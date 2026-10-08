import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderCliRow } from '@shared/provider-cli';
import type { ProviderLoginRow } from '@shared/provider-login';
import { queryKeys } from '@/lib/query-keys';
import ProvidersPage from './ProvidersPage';

const api = vi.hoisted(() => ({ apply: vi.fn(), login: vi.fn() }));
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');

function useLegacyCopy(exec: () => boolean) {
  Object.defineProperty(document, 'execCommand', {
    value: exec,
    configurable: true,
    writable: true,
  });
}

const rows: ProviderCliRow[] = [
  {
    agents: [],
    installSource: 'unknown',
    installedVersion: '2.1.285',
    label: 'Claude Code',
    latestVersion: '2.1.293',
    manualCommand: 'claude update',
    operation: { status: 'idle' },
    provider: 'claude-code',
    state: 'available',
    sourceDetail: 'The active Claude Code binary is not a recognized native install',
    updateAvailable: true,
    updateMode: 'manual',
  },
  {
    agents: [],
    installSource: 'codex-npm-global',
    installedVersion: '0.110.0',
    label: 'Codex CLI',
    latestVersion: '0.111.0',
    operation: { status: 'idle' },
    provider: 'codex-cli',
    state: 'available',
    updateAvailable: true,
    updateMode: 'managed',
  },
];

vi.mock('@/api/system', () => ({
  applyProviderCliUpdate: api.apply,
  cancelProviderLogin: vi.fn(),
  checkProviderClis: vi.fn(),
  fetchProviderCliStatus: vi.fn(async () => ({
    operation: { status: 'idle' },
    providers: rows,
    upgradeLocked: false,
  })),
  fetchProviderContextLimits: vi.fn(async () => ({ providers: [] })),
  fetchProviderLogin: api.login,
  fetchProviderRuntimeCommands: vi.fn(async () => ({ providers: [] })),
  fetchProviderUsage: vi.fn(async () => ({ providers: [] })),
  refreshProviderUsage: vi.fn(),
  saveProviderContextLimit: vi.fn(),
  saveProviderRuntimeCommand: vi.fn(),
  startProviderLogin: vi.fn(),
}));

function mountPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProvidersPage />
    </QueryClientProvider>,
  );
  return client;
}

function copiedText() {
  return document.querySelector<HTMLTextAreaElement>('textarea[readonly]')!.value;
}

describe('ProvidersPage clipboard actions', () => {
  beforeEach(() => {
    localStorage.setItem(
      'anima.usagePanel.expandedProviders',
      JSON.stringify({ 'claude-code': true, 'codex-cli': true }),
    );
    vi.clearAllMocks();
    // Browsers focus the temporary textarea on select(); jsdom does not.
    vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(function (this: HTMLTextAreaElement) {
      this.focus();
    });
    api.login.mockResolvedValue({ providers: [] });
    vi.stubGlobal(
      'navigator',
      Object.create(navigator, { clipboard: { value: undefined, configurable: true } }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand);
    else Reflect.deleteProperty(document, 'execCommand');
  });

  it('copies the manual update command when Clipboard API is absent on HTTP', async () => {
    const texts: string[] = [];
    const exec = vi.fn(() => {
      texts.push(copiedText());
      return true;
    });
    useLegacyCopy(exec);
    const client = mountPage();
    const button = await screen.findByTitle('Copy update command');
    button.focus();
    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Copied command' });
    expect(texts).toEqual(['claude update']);
    expect(exec).toHaveBeenCalledExactlyOnceWith('copy');
    expect(document.querySelector('textarea[readonly]')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(api.apply).not.toHaveBeenCalled();
    expect(screen.getByText(/in this machine’s terminal/)).toBeTruthy();
    expect(screen.getByText(/not a recognized native install/)).toBeTruthy();
    client.clear();
  });

  it('falls back when the browser rejects writeText', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }));
    const exec = vi.fn(() => true);
    useLegacyCopy(exec);
    const client = mountPage();
    fireEvent.click(await screen.findByTitle('Copy update command'));
    await screen.findByRole('button', { name: 'Copied command' });
    expect(writeText).toHaveBeenCalledExactlyOnceWith('claude update');
    expect(exec).toHaveBeenCalledExactlyOnceWith('copy');
    expect(api.apply).not.toHaveBeenCalled();
    client.clear();
  });

  it('uses available writeText without the fallback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }));
    const exec = vi.fn(() => true);
    useLegacyCopy(exec);
    const client = mountPage();
    fireEvent.click(await screen.findByTitle('Copy update command'));
    await screen.findByRole('button', { name: 'Copied command' });
    expect(writeText).toHaveBeenCalledExactlyOnceWith('claude update');
    expect(exec).not.toHaveBeenCalled();
    client.clear();
  });

  it('shows a manual recovery message if copying fails, and permits retry', async () => {
    const exec = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    useLegacyCopy(exec);
    const client = mountPage();
    const button = await screen.findByTitle('Copy update command');
    button.focus();
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toMatch(/copy it manually/);
    expect(screen.queryByRole('button', { name: 'Copied command' })).toBeNull();
    expect(document.querySelector('textarea[readonly]')).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.click(screen.getByTitle('Copy update command'));
    await screen.findByRole('button', { name: 'Copied command' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.apply).not.toHaveBeenCalled();
    client.clear();
  });

  it('keeps the managed update confirmation separate from copying', async () => {
    const client = mountPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    expect(await screen.findByText('Update Codex CLI?')).toBeTruthy();
    expect(api.apply).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Copied command' })).toBeNull();
    client.clear();
  });

  it('does not apply an old copy result to a replacement update command', async () => {
    let finish!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }));
    const client = mountPage();
    fireEvent.click(await screen.findByTitle('Copy update command'));
    act(() => {
      client.setQueryData(queryKeys.providerCliStatus(), {
        operation: { status: 'idle' },
        providers: [{ ...rows[0], manualCommand: 'claude update stable' }, rows[1]],
        upgradeLocked: false,
      });
    });
    await screen.findByText('claude update stable');
    await act(async () => { finish(); });
    expect(screen.queryByRole('button', { name: 'Copied command' })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('claude update');
    client.clear();
  });

  it('does not apply an old copy result to a replacement device code', async () => {
    let finish!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }));
    const login: ProviderLoginRow = {
      command: 'claude', provider: 'claude-code', state: 'signed_out',
      operation: { status: 'running', mode: 'device', code: 'SYNTH-OLD', startedAt: '2026-10-08T04:00:00Z' },
    };
    api.login.mockResolvedValue({ providers: [login] });
    const client = mountPage();
    fireEvent.click(await screen.findByTitle('Copy code'));
    act(() => {
      client.setQueryData(queryKeys.providerLogin(), {
        providers: [{ ...login, operation: { ...login.operation, code: 'SYNTH-NEW' } }],
      });
    });
    await screen.findByText('SYNTH-NEW');
    await act(async () => { finish(); });
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('SYNTH-OLD');
    client.clear();
  });

  for (const succeeds of [true, false]) {
    it(`copies a device code on HTTP with ${succeeds ? 'success' : 'failure'} feedback`, async () => {
      const login: ProviderLoginRow = {
        command: 'claude',
        provider: 'claude-code',
        state: 'signed_out',
        operation: {
          status: 'running',
          mode: 'device',
          code: 'SYNTH-1234',
          url: 'https://example.test/device',
          startedAt: '2026-10-08T04:00:00Z',
        },
      };
      api.login.mockResolvedValue({ providers: [login] });
      const texts: string[] = [];
      useLegacyCopy(
        vi.fn(() => {
          texts.push(copiedText());
          return succeeds;
        }),
      );
      const client = mountPage();
      const button = await screen.findByTitle('Copy code');
      button.focus();
      fireEvent.click(button);
      if (succeeds) await screen.findByRole('button', { name: 'Copied' });
      else expect((await screen.findByRole('alert')).textContent).toMatch(/copy the code manually/);
      await waitFor(() => expect(texts).toEqual(['SYNTH-1234']));
      expect(document.querySelector('textarea[readonly]')).toBeNull();
      expect(document.activeElement).toBe(button);
      expect(api.apply).not.toHaveBeenCalled();
      client.clear();
    });
  }
});
