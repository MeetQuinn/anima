import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { LinearStatus } from '@shared/linear';
import { LinearSection } from './LinearSection';

const api = vi.hoisted(() => ({ status: vi.fn(), install: vi.fn(), remove: vi.fn(), refresh: vi.fn() }));
vi.mock('@/api/linear', () => ({ fetchLinearStatus: api.status, installLinear: api.install, removeLinear: api.remove }));
vi.mock('@/api/agents', () => ({ refreshAgentData: api.refresh }));
const base: LinearStatus = { state: 'not_configured', signatureFailures: 0 };
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><LinearSection agentId="scout" /></QueryClientProvider>);
  return client;
}
beforeEach(() => { vi.clearAllMocks(); api.status.mockResolvedValue(base); api.remove.mockResolvedValue({ removed: true }); });

it('enters credentials once, clears secret and opens the returned app authorization link without browser storage', async () => {
  api.install.mockResolvedValue({ authorizationUrl: 'https://linear.app/oauth/authorize?state=synthetic-state' });
  mount(); const add = await screen.findByRole('button', { name: 'Add Linear app' });
  await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(add);
  fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'client-id' } });
  const secret = screen.getByLabelText('Webhook signing secret') as HTMLInputElement;
  fireEvent.change(secret, { target: { value: 'synthetic-signing-sentinel' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Prepare authorization' }).closest('form')!);
  const link = await screen.findByRole('link', { name: 'Authorize in Linear' });
  expect(link.getAttribute('href')).toBe('https://linear.app/oauth/authorize?state=synthetic-state');
  expect(api.install).toHaveBeenCalledWith('scout', expect.objectContaining({ clientId: 'client-id', signingSecret: 'synthetic-signing-sentinel' }));
  expect(secret.value).toBe(''); expect(JSON.stringify(localStorage)).not.toContain('synthetic-signing-sentinel');
});

it('shows factual timestamp and signature errors without claiming availability', async () => {
  api.status.mockResolvedValue({ ...base, state: 'connected', clientId: 'synthetic-client', lastSignedWebhookAt: '2026-10-10T06:00:00Z', signatureFailures: 2, listener: { host: '127.0.0.1', port: 14175 } });
  mount(); await screen.findByText('App installed');
  expect(screen.getByText('Last signed webhook received')).toBeTruthy();
  expect(screen.getByText('127.0.0.1:14175/webhook')).toBeTruthy();
  expect(screen.getByText(/failed signature verification/)).toBeTruthy();
  expect(screen.queryByText(/healthy|online/i)).toBeNull(); expect(screen.queryByLabelText('Webhook signing secret')).toBeNull();
});

it('revoked identity can be removed before starting a separate install', async () => {
  api.status.mockResolvedValue({ ...base, state: 'revoked', lastError: 'Authorization revoked; reinstall.' });
  const client = mount(); await screen.findByText('Authorization revoked');
  api.status.mockResolvedValue(base); fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith('scout'));
  await screen.findByRole('button', { name: 'Add Linear app' }); client.clear();
});

it('installation and read errors stay visible without echoing server credential text', async () => {
  api.install.mockRejectedValue(new Error('synthetic-private-error-sentinel'));
  mount(); const add = await screen.findByRole('button', { name: 'Add Linear app' });
  await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(add);
  fireEvent.submit(screen.getByRole('button', { name: 'Prepare authorization' }).closest('form')!);
  await screen.findByText(/Installation could not start/); expect(screen.queryByText(/private-error-sentinel/)).toBeNull();
});

it('unreadable settings cannot start an installation', async () => {
  api.status.mockRejectedValue(new Error('unavailable'));
  mount(); await screen.findByText(/Linear settings could not be read/);
  expect((screen.getByRole('button', { name: 'Add Linear app' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.install).not.toHaveBeenCalled();
});

it.each([
  ['address_in_use', 'The port is already in use.'],
  ['permission_denied', 'Permission to bind was denied.'],
  ['address_unavailable', 'The bind address is unavailable.'],
  ['other', 'The listener could not bind.'],
] as const)('keeps app identity while prominently showing bind failure %s', async (reason, message) => {
  api.status.mockResolvedValue({ ...base, state: 'connected', clientId: 'synthetic-client', listener: { host: '127.0.0.1', port: 14175 },
    listenerStatus: { state: 'failed', reason, observedAt: '2026-10-11T00:00:00Z' } });
  mount(); await screen.findByText('App installed');
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('Local webhook listener failed'); expect(alert.textContent).toContain(message);
  expect(alert.compareDocumentPosition(screen.getByText('Client ID')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText('Bind failed')).toBeTruthy(); expect(screen.getByText('127.0.0.1:14175/webhook')).toBeTruthy();
  expect(screen.queryByText(/sentinel/)).toBeNull();
});

it.each([
  [{ state: 'unknown' }, 'Not observed'],
  [undefined, 'Not observed'],
  [{ state: 'listening', observedAt: '2026-10-11T00:00:00Z' }, 'Listening locally'],
  [{ state: 'stopped', observedAt: '2026-10-11T00:00:00Z' }, 'Stopped'],
])('shows local listener facts with no public reachability verdict: %s', async (listenerStatus, label) => {
  api.status.mockResolvedValue({ ...base, state: 'connected', clientId: 'synthetic-client', listenerStatus });
  mount(); await screen.findByText(label);
  expect(screen.getByText(/does not verify your public HTTPS ingress/)).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
  if (!listenerStatus || listenerStatus.state === 'unknown') {
    expect(screen.getByText(/No current observation/)).toBeTruthy(); expect(screen.queryByText(/Observed \d/)).toBeNull();
  }
});
