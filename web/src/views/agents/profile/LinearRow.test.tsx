import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { LinearStatus } from '@shared/linear';
import { LinearRow } from './LinearRow';

const api = vi.hoisted(() => ({ status: vi.fn(), install: vi.fn(), remove: vi.fn(), refresh: vi.fn(), setup: vi.fn(), saveSetup: vi.fn() }));
vi.mock('@/api/linear', () => ({ fetchLinearStatus: api.status, installLinear: api.install, removeLinear: api.remove, fetchLinearSetup: api.setup, saveLinearSetup: api.saveSetup }));
vi.mock('@/api/agents', () => ({ refreshAgentData: api.refresh }));
const base: LinearStatus = { state: 'not_configured', signatureFailures: 0 };
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><LinearRow agentId="scout" /></QueryClientProvider>);
  return client;
}
async function openSettings(advance = true) {
  const opener = screen.getByRole('button', { name: 'Configure Linear' });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: 'Linear' });
  if (advance && !screen.queryByText('App installed') && !screen.queryByRole('button', { name: 'Remove connection' }) && !screen.queryByText(/Linear settings could not be read/)) {
    const next = await screen.findByRole('button', { name: 'I already have an app' });
    fireEvent.click(next);
  }
  return dialog;
}
function prepare() {
  for (const [label, value] of [['Client ID', 'client-id'], ['Webhook signing secret', 'synthetic-signing-sentinel']]) {
    const input = screen.getByLabelText(label) as HTMLInputElement;
    if (!input.value) fireEvent.change(input, { target: { value } });
  }
  fireEvent.submit(screen.getByRole('button', { name: 'Prepare authorization' }).closest('form')!);
}
beforeEach(() => { vi.clearAllMocks(); api.setup.mockResolvedValue({ publicUrl: 'https://agents.example.com', callbackUrl: 'https://agents.example.com/api/linear/oauth/callback', webhookUrl: 'https://agents.example.com/webhook', listener: { host: '127.0.0.1', port: 14185 }, listenerLocked: false }); api.status.mockResolvedValue(base); api.remove.mockResolvedValue({ removed: true }); });

it('enters credentials once, clears secret and opens the returned app authorization link without browser storage', async () => {
  api.install.mockResolvedValue({ authorizationUrl: 'https://linear.app/oauth/authorize?state=synthetic-state' });
  mount(); await screen.findByText('Not connected'); await openSettings();
  fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'client-id' } });
  const secret = screen.getByLabelText('Webhook signing secret') as HTMLInputElement;
  fireEvent.change(secret, { target: { value: 'synthetic-signing-sentinel' } });
  prepare();
  const link = await screen.findByRole('link', { name: 'Authorize in Linear' });
  expect(link.getAttribute('href')).toBe('https://linear.app/oauth/authorize?state=synthetic-state');
  expect(api.install).toHaveBeenCalledWith('scout', expect.objectContaining({ clientId: 'client-id', signingSecret: 'synthetic-signing-sentinel', listener: { host: '127.0.0.1', port: 14185 } }));
  await waitFor(() => expect(document.activeElement).toBe(link));
  expect(screen.queryByLabelText('Webhook signing secret')).toBeNull(); expect(JSON.stringify(localStorage)).not.toContain('synthetic-signing-sentinel');
});

it('uses the saved shared listener when connecting another agent', async () => {
  api.setup.mockResolvedValue({ publicUrl: 'https://agents.example.com', callbackUrl: 'https://agents.example.com/api/linear/oauth/callback', webhookUrl: 'https://agents.example.com/webhook', listener: { host: '::1', port: 15123 }, listenerLocked: true });
  api.status.mockResolvedValue({ ...base, listener: { host: '::1', port: 15123 } });
  api.install.mockResolvedValue({ authorizationUrl: 'https://linear.app/oauth/authorize?state=synthetic-state' });
  mount(); await screen.findByText('Not connected'); await openSettings();
  prepare();
  await screen.findByRole('link', { name: 'Authorize in Linear' });
  expect(api.install).toHaveBeenCalledWith('scout', expect.objectContaining({ listener: { host: '::1', port: 15123 } }));
  expect(api.saveSetup).not.toHaveBeenCalled();
});

it('shows factual timestamp and signature errors without claiming availability', async () => {
  api.status.mockResolvedValue({ ...base, state: 'connected', clientId: 'synthetic-client', lastSignedWebhookAt: '2026-10-10T06:00:00Z', signatureFailures: 2, listener: { host: '127.0.0.1', port: 14175 } });
  mount(); await screen.findByText('Workspace name unavailable'); await openSettings();
  expect(screen.getByText('Last signed webhook received')).toBeTruthy();
  expect(screen.getByText('127.0.0.1:14175/webhook')).toBeTruthy();
  expect(screen.getByText(/failed signature verification/)).toBeTruthy();
  expect(screen.queryByText(/healthy|online/i)).toBeNull(); expect(screen.queryByLabelText('Webhook signing secret')).toBeNull();
});

it('revoked identity can be removed before starting a separate install', async () => {
  api.status.mockResolvedValue({ ...base, state: 'revoked', lastError: 'Authorization revoked; reinstall.' });
  const client = mount(); await screen.findByText('Authorization revoked'); await openSettings();
  api.status.mockResolvedValue(base); fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith('scout'));
  await screen.findByRole('link', { name: 'Create app in Linear' }); client.clear();
});

it('installation and read errors stay visible without echoing server credential text', async () => {
  api.install.mockRejectedValue(new Error('synthetic-private-error-sentinel'));
  mount(); await screen.findByText('Not connected'); await openSettings();
  prepare();
  await screen.findByText(/Authorization could not start/); expect(screen.queryByText(/private-error-sentinel/)).toBeNull();
});

it('unreadable settings cannot start an installation', async () => {
  api.status.mockRejectedValue(new Error('unavailable'));
  mount(); await screen.findByText('Settings unavailable');
  expect(screen.queryByText('Not connected')).toBeNull();
  expect(screen.getByText('Unknown')).toBeTruthy();
  await openSettings();
  await screen.findByText(/Linear settings could not be read/);
  expect(screen.queryByRole('button', { name: 'Prepare authorization' })).toBeNull();
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
  mount(); await screen.findByText('Workspace name unavailable'); await openSettings();
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
  mount(); await screen.findByText('Workspace name unavailable'); const dialog = await openSettings();
  await within(dialog).findByText(label);
  expect(screen.getByText(/does not verify your public HTTPS ingress/)).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
  if (!listenerStatus || listenerStatus.state === 'unknown') {
    expect(screen.getByText(/No current observation/)).toBeTruthy(); expect(screen.queryByText(/Observed \d/)).toBeNull();
  }
});


it('keeps configuration behind the row and contains/restores keyboard focus on dismissal', async () => {
  mount(); await screen.findByText('Not connected');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByLabelText('Client ID')).toBeNull();
  const opener = screen.getByRole('button', { name: 'Configure Linear' });
  for (const dismiss of ['escape', 'button', 'backdrop']) {
    const dialog = await openSettings();
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close Linear settings' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Prepare authorization' }));
    fireEvent.change(screen.getByLabelText('Webhook signing secret'), { target: { value: 'discarded-secret' } });
    if (dismiss === 'escape') fireEvent.keyDown(dialog, { key: 'Escape' });
    if (dismiss === 'button') fireEvent.click(screen.getByRole('button', { name: 'Close Linear settings' }));
    if (dismiss === 'backdrop') fireEvent.click(dialog.parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  }
  await openSettings();
  expect((screen.getByLabelText('Webhook signing secret') as HTMLInputElement).value).toBe('');
  expect(api.install).not.toHaveBeenCalled(); expect(api.remove).not.toHaveBeenCalled();
});

it('keeps a pending authorization link when the settings are closed and reopened', async () => {
  api.install.mockResolvedValue({ authorizationUrl: 'https://linear.app/oauth/authorize?state=synthetic-state' });
  mount(); await screen.findByText('Not connected'); await openSettings();
  api.status.mockResolvedValue({ ...base, state: 'installing', clientId: 'client-id' });
  prepare();
  await screen.findByRole('link', { name: 'Authorize in Linear' });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Close Linear settings' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Close Linear settings' }));
  await openSettings();
  expect(screen.getByRole('link', { name: 'Authorize in Linear' }).getAttribute('href')).toContain('synthetic-state');
  expect(api.install).toHaveBeenCalledTimes(1);
});

it.each(['install', 'remove'] as const)('cannot dismiss a pending %s or lose its failure', async (operation) => {
  let reject!: (reason: Error) => void;
  api[operation].mockReturnValue(new Promise((_, no) => { reject = no; }));
  if (operation === 'remove') api.status.mockResolvedValue({ ...base, state: 'connected' });
  mount(); await screen.findByText(operation === 'remove' ? 'Workspace name unavailable' : 'Not connected');
  const dialog = await openSettings();
  if (operation === 'remove') fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }));
  else prepare();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBe(dialog);
  fireEvent.click(dialog.parentElement!);
  expect(screen.queryByRole('dialog')).toBe(dialog);
  fireEvent.click(screen.getByRole('button', { name: 'Close Linear settings' }));
  expect(screen.getByRole('dialog')).toBe(dialog);
  await act(async () => reject(new Error('private-failure-sentinel')));
  await screen.findByText(operation === 'remove' ? /Removal failed/ : /Authorization could not start/);
  expect(screen.queryByText(/private-failure-sentinel/)).toBeNull();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});


it('retains the cached installation form and focused input after a background read failure', async () => {
  const client = mount(); await screen.findByText('Not connected'); await openSettings();
  const input = screen.getByLabelText('Client ID');
  fireEvent.change(input, { target: { value: 'unfinished-client' } }); input.focus();
  api.status.mockRejectedValueOnce(new Error('transient-read-error'));
  await act(async () => { await client.refetchQueries({ queryKey: ['agent', 'scout', 'linear'] }); });
  await screen.findByText(/Linear settings could not be read/);
  expect(screen.getByLabelText('Client ID')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe('unfinished-client');
  api.status.mockResolvedValue(base);
  await act(async () => { await client.refetchQueries({ queryKey: ['agent', 'scout', 'linear'] }); });
  expect(document.activeElement).toBe(input); client.clear();
});


it('shows the workspace identity beside a labeled icon button, with listener details only in the dialog', async () => {
  api.status.mockResolvedValue({ ...base, state: 'connected', workspaceName: 'A very long test workspace name', listenerStatus: { state: 'listening' } });
  mount(); await screen.findByText('A very long test workspace name');
  const configure = screen.getByRole('button', { name: 'Configure Linear' });
  expect(configure.textContent).toBe(''); expect(configure.querySelector('svg')).toBeTruthy();
  expect(screen.queryByText('App installed')).toBeNull();
  expect(screen.queryByText('Listening locally')).toBeNull();
  await openSettings();
  expect(screen.getByText('App installed')).toBeTruthy();
  expect(screen.getByText('Listening locally')).toBeTruthy();
});

it('opens a prefilled app with the machine URL and advances to just two credential fields', async () => {
  mount(); await screen.findByText('Not connected'); await openSettings(false);
  const link = await screen.findByRole('link', { name: 'Create app in Linear' });
  const manifest = JSON.parse(new URL(link.getAttribute('href')!).searchParams.get('manifest')!);
  expect(manifest.oauth.client_name).toBe('scout');
  expect(manifest.webhook.url).toBe('https://agents.example.com/webhook');
  expect(manifest.webhook.resourceTypes).toEqual(['AgentSessionEvent', 'AppUserNotification', 'PermissionChange']);
  expect(manifest.oauth.redirect_uris).toEqual(['https://agents.example.com/api/linear/oauth/callback']);
  fireEvent.click(link);
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(screen.getByLabelText('Webhook signing secret')).toBeTruthy();
  expect(screen.queryByLabelText('Port')).toBeNull();
  expect(api.install).not.toHaveBeenCalled();
});

it('finishes on OAuth success and only suggests mentioning or delegating, without a delivery-test gate', async () => {
  api.install.mockResolvedValue({ authorizationUrl: 'https://linear.app/oauth/authorize?state=synthetic-state' });
  const client = mount(); await screen.findByText('Not connected'); await openSettings();
  prepare(); await screen.findByRole('link', { name: 'Authorize in Linear' });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Close Linear settings' }) as HTMLButtonElement).disabled).toBe(false));
  api.status.mockResolvedValue({ ...base, state: 'connected', workspaceName: 'Demo workspace' });
  await act(async () => { await client.refetchQueries({ queryKey: ['agent', 'scout', 'linear'] }); });
  expect(await screen.findByText(/Connected. You can now mention this agent/)).toBeTruthy();
  expect(screen.getByText(/If Linear does not show/).textContent).toContain('check the HTTPS forwarding to this machine');
  expect(screen.queryByRole('link', { name: 'Authorize in Linear' })).toBeNull();
  expect(screen.queryByText(/pending verification|send a test|verify connection/i)).toBeNull();
  expect(api.install).toHaveBeenCalledTimes(1);
  expect(api.saveSetup).not.toHaveBeenCalled();
});

it('directs missing public address to global settings without an inline Linear URL form', async () => {
  api.setup.mockResolvedValue({ listener: { host: '127.0.0.1', port: 15123 }, listenerLocked: false });
  mount(); await screen.findByText('Not connected'); await openSettings(false);
  const link = await screen.findByRole('link', { name: 'Open Server settings' });
  expect(link.getAttribute('href')).toBe('/settings/server#public-url');
  expect(screen.queryByLabelText('Public webhook URL')).toBeNull();
  expect(api.install).not.toHaveBeenCalled();
});

it('lets an expired authorization start again without retaining its old link', async () => {
  api.install.mockResolvedValue({ authorizationUrl: 'https://linear.app/oauth/authorize?state=expired-state' });
  const client = mount(); await screen.findByText('Not connected'); await openSettings();
  api.status.mockResolvedValue({ ...base, state: 'installing' });
  prepare(); await screen.findByRole('link', { name: 'Authorize in Linear' });
  api.status.mockResolvedValue({ ...base, state: 'not_configured', clientId: 'client-id', lastError: 'Installation expired.' });
  await act(async () => { await client.refetchQueries({ queryKey: ['agent', 'scout', 'linear'] }); });
  const restart = await screen.findByRole('button', { name: 'Remove connection' });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByText('Authorization needs attention')));
  expect(screen.queryByRole('link', { name: 'Authorize in Linear' })).toBeNull();
  api.status.mockResolvedValue(base);
  fireEvent.click(restart);
  await screen.findByRole('link', { name: 'Create app in Linear' });
  expect(screen.queryByRole('link', { name: 'Authorize in Linear' })).toBeNull();
  expect(api.remove).toHaveBeenCalledTimes(1);
  expect(api.install).toHaveBeenCalledTimes(1);
});


it('retains entered credentials and explains a failed refresh of machine settings', async () => {
  const client = mount(); await screen.findByText('Not connected'); await openSettings();
  const input = screen.getByLabelText('Client ID');
  fireEvent.change(input, { target: { value: 'unfinished-client' } }); input.focus();
  api.setup.mockRejectedValueOnce(new Error('private-read-failure'));
  await act(async () => { await client.refetchQueries({ queryKey: ['linear', 'setup'] }); });
  await screen.findByText(/Could not refresh machine settings/);
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe('unfinished-client');
  expect((screen.getByRole('button', { name: 'Prepare authorization' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/private-read-failure/)).toBeNull();
  expect(api.install).not.toHaveBeenCalled();
  client.clear();
});


it('offers removal after reloading a consumed or expired pending authorization', async () => {
  api.status.mockResolvedValue({ ...base, clientId: 'expired-client', lastError: 'Installation expired or is being completed. Remove it and prepare again if authorization did not finish.' });
  mount(); await screen.findByText('Not connected'); await openSettings(false);
  expect(screen.queryByRole('link', { name: 'Authorize in Linear' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Create app in Linear' })).toBeNull();
  api.status.mockResolvedValue(base);
  fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }));
  await screen.findByRole('link', { name: 'Create app in Linear' });
  expect(api.remove).toHaveBeenCalledTimes(1);
});


it('keeps exchange-status focus away from Remove when authorization completes', async () => {
  api.status.mockResolvedValue({ ...base, clientId: 'consumed-client' });
  const client = mount(); await screen.findByText('Not connected'); await openSettings(false);
  const summary = screen.getByText('Authorization needs attention');
  await waitFor(() => expect(document.activeElement).toBe(summary));
  api.status.mockResolvedValue({ ...base, state: 'connected', clientId: 'consumed-client' });
  await act(async () => { await client.refetchQueries({ queryKey: ['agent', 'scout', 'linear'] }); });
  expect(document.activeElement).toBe(summary);
  expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Remove connection' }));
  expect(api.remove).not.toHaveBeenCalled();
  client.clear();
});

for (const reason of ['Linear authorization could not be exchanged.', 'Linear authorization was declined.']) it(`returns to existing app setup and keeps focus after ${reason}`, async () => {
  api.status.mockResolvedValue(base);
  api.install.mockResolvedValue({ authorizationUrl: 'https://linear.app/oauth/authorize?state=consumed' });
  const client = mount(); await screen.findByText('Not connected'); await openSettings(); prepare();
  await screen.findByRole('link', { name: 'Authorize in Linear' });
  api.status.mockResolvedValue({ ...base, lastError: reason });
  await act(async () => { await client.refetchQueries({ queryKey: ['agent', 'scout', 'linear'] }); });
  await screen.findByLabelText('Client ID');
  expect(screen.queryByRole('link', { name: 'Create app in Linear' })).toBeNull();
  expect(screen.getByText(/Use your existing Linear app/)).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Authorize in Linear' })).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain(reason);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await screen.findByRole('link', { name: 'Create app in Linear' });
  expect(api.remove).not.toHaveBeenCalled();
});

for (const reason of ['Use a separate Linear app for each agent.', 'Set the Anima public URL in Server settings and refresh the connection form.', 'private-input-sentinel']) {
  it(`shows only allowlisted installation start errors: ${reason}`, async () => {
    api.install.mockRejectedValueOnce(new Error(reason));
    mount(); await screen.findByText('Not connected'); await openSettings(); prepare();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(reason === 'private-input-sentinel' ? 'Authorization could not start.' : reason);
    expect(alert.textContent).not.toContain('private-input-sentinel');
  });
}
