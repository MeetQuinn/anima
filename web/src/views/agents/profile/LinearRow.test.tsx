import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { LinearStatus } from '@shared/linear';
import type { LinearSetup } from '@shared/linear-setup';
import { LinearRow } from './LinearRow';

const api = vi.hoisted(() => ({
  status: vi.fn(),
  install: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  setup: vi.fn(),
  check: vi.fn(),
  open: vi.fn(),
  readAddress: vi.fn(),
  saveAddress: vi.fn(),
  saveSecret: vi.fn(),
}));
vi.mock('@/api/linear', () => ({
  fetchLinearStatus: api.status,
  installLinear: api.install,
  removeLinear: api.remove,
  fetchLinearSetup: api.setup,
  linearSetupKey: ['linear', 'setup'],
  openLinearAuthorization: api.open,
  saveLinearClientSecret: api.saveSecret,
}));
vi.mock('@/api/public-url', () => ({
  publicUrlKey: ['server', 'public-url'],
  publicUrlCheckKey: ['server', 'public-url-check'],
  fetchPublicUrl: api.readAddress,
  savePublicUrl: api.saveAddress,
  checkPublicUrl: api.check,
}));
vi.mock('@/api/agents', () => ({ refreshAgentData: api.refresh }));

const base: LinearStatus = { state: 'not_configured', signatureFailures: 0 };
const setup: LinearSetup = {
  publicUrl: 'https://agents.example.com',
  callbackUrl: 'https://agents.example.com/api/linear/oauth/callback',
  webhookUrl: 'https://agents.example.com/webhooks/linear',
};
const authorizationUrl = 'https://linear.app/oauth/authorize?state=synthetic-state';
const connected: LinearStatus = {
  ...base,
  state: 'connected',
  clientId: 'synthetic-client',
  installationId: 'installation-1',
  clientSecretSaved: true,
  workspaceName: 'Demo workspace',
};

function mount(props: { initialOpen?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LinearRow agentId="scout" agentName="Scout" {...props} />
    </QueryClientProvider>,
  );
  return client;
}
async function openDialog(action = 'Connect') {
  const opener = screen.getByRole('button', { name: `${action} Linear` });
  opener.focus();
  fireEvent.click(opener);
  return screen.findByRole('dialog', { name: 'Linear' });
}
function fillCredentials() {
  for (const [label, value] of [
    ['Client ID', 'client-id'],
    ['Client secret', 'synthetic-client-secret-sentinel'],
    ['Webhook signing secret', 'synthetic-signing-sentinel'],
  ]) {
    const input = screen.getByLabelText(label) as HTMLInputElement;
    if (!input.value) fireEvent.change(input, { target: { value } });
  }
}
async function startAuthorizing() {
  fireEvent.click(await screen.findByRole('button', { name: 'I already have one' }));
  fillCredentials();
  fireEvent.click(screen.getByRole('button', { name: /Authorize in Linear/ }));
}
const closeButton = () => screen.getByRole('button', { name: 'Close Linear settings' }) as HTMLButtonElement;
const refetch = (client: QueryClient, queryKey: readonly string[]) =>
  act(async () => {
    await client.refetchQueries({ queryKey });
  });

beforeEach(() => {
  vi.clearAllMocks();
  api.setup.mockResolvedValue(setup);
  api.status.mockResolvedValue(base);
  api.remove.mockResolvedValue({ removed: true });
  api.readAddress.mockResolvedValue({});
  api.check.mockResolvedValue({ publicUrl: setup.publicUrl, reachable: true, status: 200, passwordSet: true, checkedAt: '2026-11-03T00:00:00Z' });
});

it('connects in this tab: one click on Authorize goes to the returned Linear link and keeps the dialog busy', async () => {
  api.install.mockResolvedValue({ authorizationUrl });
  mount();
  await screen.findByText('Not connected');
  await openDialog();
  expect(await screen.findByRole('heading', { name: 'Connect Scout to Linear' })).toBeTruthy();
  await startAuthorizing();
  await waitFor(() => expect(api.open).toHaveBeenCalledWith(authorizationUrl));
  expect(api.install).toHaveBeenCalledWith('scout', {
    clientId: 'client-id',
    clientSecret: 'synthetic-client-secret-sentinel',
    signingSecret: 'synthetic-signing-sentinel',
    callbackUrl: 'https://agents.example.com/api/linear/oauth/callback',
  });
  expect((screen.getByRole('button', { name: /Opening Linear/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(closeButton().disabled).toBe(true);
  expect((screen.getByLabelText('Webhook signing secret') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
  expect(screen.queryByRole('link', { name: /Authorize/ })).toBeNull();
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-signing-sentinel');
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-client-secret-sentinel');
});

it('coming Back from Linear out of the page cache lets the user act again', async () => {
  api.install.mockResolvedValue({ authorizationUrl });
  mount();
  await screen.findByText('Not connected');
  await openDialog();
  await startAuthorizing();
  await waitFor(() => expect(api.open).toHaveBeenCalledTimes(1));
  expect(closeButton().disabled).toBe(true);
  act(() => {
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
  });
  expect(closeButton().disabled).toBe(true);
  act(() => {
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  });
  expect(closeButton().disabled).toBe(false);
});

it('shows whether Linear can reach the public address while connecting', async () => {
  api.check.mockResolvedValueOnce({ publicUrl: setup.publicUrl, reachable: false, failure: 'gateway', status: 302, passwordSet: true, checkedAt: '2026-11-03T00:00:00Z' });
  mount();
  await screen.findByText('Not connected');
  const dialog = await openDialog();
  const alert = await within(dialog).findByRole('alert');
  expect(alert.textContent).toContain('Not reachable yet');
  expect(alert.textContent).toContain('A sign-in page or access rule answered (HTTP 302). Let /webhooks/ through it');
  api.check.mockResolvedValueOnce({ publicUrl: setup.publicUrl, reachable: true, status: 200, passwordSet: true, checkedAt: '2026-11-03T00:00:01Z' });
  fireEvent.click(within(alert).getByRole('button', { name: 'Check again' }));
  await within(dialog).findByText(/Reachable\. Linear can deliver events here\./);
  expect(api.check).toHaveBeenCalledTimes(2);
});

for (const reason of [
  'Use a separate Linear app for each agent.',
  'Set the Anima public URL in Server settings and refresh the connection form.',
  'private-input-sentinel',
]) {
  it(`shows only allowlisted reasons when authorization cannot start: ${reason}`, async () => {
    api.install.mockRejectedValueOnce(new Error(reason));
    mount();
    await screen.findByText('Not connected');
    await openDialog();
    await startAuthorizing();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(reason === 'private-input-sentinel' ? 'Authorization could not start.' : reason);
    expect(alert.textContent).not.toContain('private-input-sentinel');
    expect(api.open).not.toHaveBeenCalled();
    expect(closeButton().disabled).toBe(false);
    expect((screen.getByLabelText('Webhook signing secret') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
  });
}

it.each(['install', 'remove'] as const)('cannot dismiss a pending %s or lose its failure', async (operation) => {
  let reject!: (reason: Error) => void;
  api[operation].mockReturnValue(new Promise((_, no) => (reject = no)));
  if (operation === 'remove') api.status.mockResolvedValue(connected);
  mount();
  await screen.findByText(operation === 'remove' ? 'Demo workspace' : 'Not connected');
  const dialog = await openDialog(operation === 'remove' ? 'Manage' : 'Connect');
  if (operation === 'remove') {
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  } else await startAuthorizing();
  await waitFor(() => expect(closeButton().disabled).toBe(true));
  fireEvent.keyDown(dialog, { key: 'Escape' });
  fireEvent.click(dialog.parentElement!);
  expect(screen.getByRole('dialog')).toBe(dialog);
  await act(async () => reject(new Error('private-failure-sentinel')));
  await screen.findByText(operation === 'remove' ? /Could not disconnect/ : /Authorization could not start/);
  expect(screen.queryByText(/private-failure-sentinel/)).toBeNull();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps setup behind the row and contains and restores keyboard focus on dismissal', async () => {
  mount();
  await screen.findByText('Not connected');
  expect(screen.queryByRole('dialog')).toBeNull();
  const opener = screen.getByRole('button', { name: 'Connect Linear' });
  expect(opener.getAttribute('aria-haspopup')).toBe('dialog');
  for (const dismiss of ['escape', 'button', 'backdrop']) {
    const dialog = await openDialog();
    expect(document.activeElement).toBe(dialog);
    await screen.findByRole('link', { name: 'Create app in Linear' });
    await within(dialog).findByText(/Reachable\./);
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton());
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    // The public address check closes the dialog's content.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Check again' }));
    fireEvent.click(screen.getByRole('button', { name: 'I already have one' }));
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'discarded-client-secret' } });
    fireEvent.change(screen.getByLabelText('Webhook signing secret'), { target: { value: 'discarded-secret' } });
    if (dismiss === 'escape') fireEvent.keyDown(dialog, { key: 'Escape' });
    if (dismiss === 'button') fireEvent.click(closeButton());
    if (dismiss === 'backdrop') fireEvent.click(dialog.parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  }
  await openDialog();
  fireEvent.click(await screen.findByRole('button', { name: 'I already have one' }));
  expect((screen.getByLabelText('Webhook signing secret') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
  expect(api.install).not.toHaveBeenCalled();
  expect(api.remove).not.toHaveBeenCalled();
});

it('opens straight into the dialog when returning from Linear', async () => {
  api.status.mockResolvedValue(connected);
  mount({ initialOpen: true });
  const dialog = await screen.findByRole('dialog', { name: 'Linear' });
  expect(await within(dialog).findByRole('heading', { name: 'Connected to Demo workspace' })).toBeTruthy();
});

it.each([
  {
    name: 'declined',
    status: { lastError: 'Linear authorization was declined. Prepare authorization again when ready.' },
    title: 'Authorization was declined in Linear',
    body: 'Authorize again whenever you’re ready.',
    removable: false,
  },
  {
    name: 'exchange failure',
    status: {
      lastError:
        'Linear authorization could not be exchanged (HTTP 400). Check the Client ID, registered redirect URL and network, then prepare authorization again.',
    },
    title: 'Authorization couldn’t be completed',
    body: 'Check the Client ID and Client secret, that the app’s callback URL in Linear uses your public address, and this machine’s network. Then authorize again. Details: HTTP 400.',
    removable: false,
  },
  {
    name: 'exchange rejected the app credentials',
    status: {
      lastError:
        'Linear authorization could not be exchanged (HTTP 400 invalid_client). Check the Client ID, client secret, registered redirect URL and network, then prepare authorization again.',
    },
    title: 'Authorization couldn’t be completed',
    body: 'Linear didn’t accept the Client ID and Client secret. Copy both again from the app’s page in Linear, then authorize again. Details: HTTP 400 invalid_client.',
    removable: false,
  },
  {
    name: 'identity failure',
    status: {
      lastError:
        'Linear app identity could not be verified (connection failed). Check the app configuration and network, then prepare authorization again.',
    },
    title: 'Anima couldn’t verify the app',
    body: 'Details: connection failed.',
    removable: false,
  },
  {
    name: 'expired',
    status: {
      clientId: 'client-id',
      lastError: 'Installation expired or is being completed. Remove it and prepare again if authorization did not finish.',
    },
    title: 'The last authorization expired',
    body: 'Authorize again with your existing app.',
    removable: false,
  },
  {
    name: 'unfinished',
    status: { state: 'installing', clientId: 'client-id' },
    title: 'Authorization wasn’t finished',
    body: 'Authorize again with your existing app.',
    removable: true,
  },
  {
    name: 'revoked',
    status: { state: 'revoked', clientId: 'client-id', lastError: 'Authorization revoked; reinstall.' },
    title: 'Linear access was revoked',
    body: 'Authorize again with your existing app to reconnect.',
    removable: true,
  },
] as const)('$name: names the problem on the row, focuses it in the dialog and resumes at the existing app', async (c) => {
  api.status.mockResolvedValue({ ...base, ...c.status });
  mount();
  await screen.findByText(c.title);
  const dialog = await openDialog('Review');
  const notice = (await within(dialog).findByText(c.title)).closest('[role="alert"]') as HTMLElement;
  expect(notice.textContent).toContain(c.body);
  await waitFor(() => expect(document.activeElement).toBe(notice));
  expect(screen.getByText('Using an app you already created.')).toBeTruthy();
  expect(screen.getByLabelText('Client ID')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Create app in Linear' })).toBeNull();
  expect(dialog.textContent).not.toMatch(/prepare (authorization )?again|reinstall/i);
  expect(Boolean(screen.queryByRole('button', { name: 'Disconnect from Linear instead' }))).toBe(c.removable);
  expect(api.remove).not.toHaveBeenCalled();
});

it('a revoked identity can be disconnected before starting over', async () => {
  api.status.mockResolvedValue({ ...base, state: 'revoked', clientId: 'client-id' });
  mount();
  await screen.findByText('Linear access was revoked');
  await openDialog('Review');
  api.status.mockResolvedValue(base);
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect from Linear instead' }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith('scout'));
  await screen.findByRole('link', { name: 'Create app in Linear' });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('asks for the public address in place when it is missing, then continues to the steps', async () => {
  api.setup.mockResolvedValue({});
  mount();
  await screen.findByText('Not connected');
  const dialog = await openDialog();
  expect(await within(dialog).findByRole('heading', { name: 'Give Anima a public address' })).toBeTruthy();
  const input = screen.getByLabelText('Public address');
  expect(document.activeElement).toBe(input);
  // One forwarding target; no per-integration routes to copy.
  expect(within(dialog).getByText(/Forward the whole address to this dashboard/)).toBeTruthy();
  expect(within(dialog).queryByText('/api/linear/oauth/callback')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Create app in Linear' })).toBeNull();
  api.saveAddress.mockResolvedValue({ publicUrl: 'https://agents.example.com' });
  api.setup.mockResolvedValue(setup);
  fireEvent.change(input, { target: { value: 'https://agents.example.com/' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await within(dialog).findByRole('heading', { name: 'Connect Scout to Linear' });
  expect(api.saveAddress).toHaveBeenCalledWith('https://agents.example.com');
  expect(screen.getByRole('link', { name: 'Create app in Linear' })).toBeTruthy();
  expect(api.install).not.toHaveBeenCalled();
});

it('connected: OAuth success is done, with facts, no delivery-test gate, and a confirmed disconnect', async () => {
  const lastEvent = new Date(Date.now() - 12 * 60_000).toISOString();
  api.status.mockResolvedValue({
    ...connected,
    lastSignedWebhookAt: lastEvent,
    signatureFailures: 2,
    listenerStatus: { state: 'listening', observedAt: lastEvent },
  });
  mount();
  await screen.findByText('Demo workspace');
  expect(screen.queryByText('Listening')).toBeNull();
  await waitFor(() => expect(api.refresh).toHaveBeenCalledWith('scout'));
  const dialog = await openDialog('Manage');
  expect(within(dialog).getByRole('heading', { name: 'Connected to Demo workspace' })).toBeTruthy();
  expect(within(dialog).getByText('Mention Scout in Linear or delegate an issue to it.')).toBeTruthy();
  const fact = (label: string) => within(dialog).getByText(label).nextElementSibling!;
  expect(fact('Local listener').textContent).toBe('Listening');
  expect(fact('Last event').textContent).not.toBe('None yet');
  expect(fact('Last event').getAttribute('title')).toBeTruthy();
  expect(fact('Client ID').textContent).toBe('synthetic-client');
  // Stored and accepted: nothing to do, so no action is offered.
  expect(fact('Client secret').textContent).toBe('Stored on this machine');
  expect(within(dialog).queryByRole('button', { name: /Client secret/ })).toBeNull();
  expect(within(dialog).getByText(/2 requests claiming this app failed/)).toBeTruthy();
  expect(dialog.textContent).not.toMatch(/pending verification|send a test|verify connection|healthy|online/i);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByLabelText('Webhook signing secret')).toBeNull();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
  expect(within(dialog).getByText('Stop Linear here? The app stays in Linear.')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
  expect(api.remove).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
  api.status.mockResolvedValue(base);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledTimes(1));
  await within(dialog).findByRole('link', { name: 'Create app in Linear' });
});

it.each([
  ['address_in_use', 'Its local port is already in use. Free it, or set another port in linearWebhook in config.json.'],
  ['permission_denied', 'Permission to bind its local port was denied.'],
  ['address_unavailable', 'Its local address is unavailable.'],
  ['other', 'Its local receiver could not start. Check the runtime logs.'],
] as const)('a detected listener failure (%s) is named, with a way to fix it', async (reason, message) => {
  api.status.mockResolvedValue({
    ...connected,
    listenerStatus: { state: 'failed', reason, observedAt: '2026-10-11T00:00:00Z' },
  });
  mount();
  await screen.findByText('Not receiving events');
  const dialog = await openDialog('Manage');
  const alert = within(dialog).getByRole('alert');
  expect(alert.textContent).toContain('Anima can’t receive Linear events');
  expect(alert.textContent).toContain(message);
  expect(within(alert).queryByRole('link')).toBeNull();
  expect(within(dialog).getByText('Local listener').nextElementSibling!.textContent).toBe('Failed');
});

it.each([
  [{ state: 'unknown' }, 'Not observed yet'],
  [undefined, 'Not observed yet'],
  [{ state: 'stopped', observedAt: '2026-10-11T00:00:00Z' }, 'Stopped'],
] as const)('without a detected failure, nothing blames the port: %s', async (listenerStatus, label) => {
  api.status.mockResolvedValue({ ...connected, listenerStatus });
  mount();
  await screen.findByText('Demo workspace');
  expect(screen.queryByText('Not receiving events')).toBeNull();
  const dialog = await openDialog('Manage');
  expect(within(dialog).getByText('Local listener').nextElementSibling!.textContent).toBe(label);
  expect(within(dialog).getByText('Last event').nextElementSibling!.textContent).toBe('None yet');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(dialog.textContent).not.toMatch(/\bport\b/i);
  expect(dialog.textContent).toContain(
    'Check the public address, and the app’s webhook URL and event subscriptions in Linear.',
  );
  expect(within(dialog).getByRole('link', { name: 'public address' }).getAttribute('href')).toBe('/settings/server#public-url');
});

it('an unreadable status cannot start an installation and recovers on retry', async () => {
  api.status.mockRejectedValue(new Error('unavailable'));
  mount();
  await screen.findByText('Status unavailable');
  expect(screen.getByText('Unavailable')).toBeTruthy();
  expect(screen.queryByText('Not connected')).toBeNull();
  const dialog = await openDialog();
  await within(dialog).findByText(/Could not read Linear status/);
  expect(screen.queryByRole('button', { name: /Authorize in Linear/ })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Create app in Linear' })).toBeNull();
  api.status.mockResolvedValue(base);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
  await within(dialog).findByRole('heading', { name: 'Connect Scout to Linear' });
  expect(api.install).not.toHaveBeenCalled();
});

it.each([
  ['status', ['agent', 'scout', 'linear'], 'Could not refresh Linear status.'],
  ['machine settings', ['linear', 'setup'], 'Could not refresh machine settings.'],
] as const)('a failed background refresh of %s keeps typed input and focus but pauses Authorize', async (_, key, message) => {
  const client = mount();
  await screen.findByText('Not connected');
  await openDialog();
  fireEvent.click(await screen.findByRole('button', { name: 'I already have one' }));
  fillCredentials();
  const input = screen.getByLabelText('Client ID') as HTMLInputElement;
  input.focus();
  const failing = key[0] === 'agent' ? api.status : api.setup;
  failing.mockRejectedValueOnce(new Error('private-read-failure'));
  await refetch(client, key);
  expect((await screen.findByRole('alert')).textContent).toContain(message);
  expect(screen.getByLabelText('Client ID')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('client-id');
  expect((screen.getByRole('button', { name: /Authorize in Linear/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/private-read-failure/)).toBeNull();
  await refetch(client, key);
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect((screen.getByRole('button', { name: /Authorize in Linear/ }) as HTMLButtonElement).disabled).toBe(false);
  expect(api.install).not.toHaveBeenCalled();
  client.clear();
});

it('an installation made before secrets were kept offers a quiet Add, checked by Linear before it is stored', async () => {
  api.status.mockResolvedValue({ ...connected, clientSecretSaved: false });
  api.saveSecret.mockResolvedValue({ result: 'saved' });
  mount();
  await screen.findByText('Demo workspace');
  // Not stored is not a failure: nothing on the row and no alert in the dialog.
  expect(screen.queryByText('Credentials not accepted')).toBeNull();
  const dialog = await openDialog('Manage');
  expect(within(dialog).queryByRole('alert')).toBeNull();
  const fact = within(dialog).getByText('Client secret', { selector: 'dt' }).nextElementSibling as HTMLElement;
  expect(fact.textContent).toBe('Not storedAdd');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add Client secret' }));
  const input = within(dialog).getByLabelText('Client secret') as HTMLInputElement;
  expect(input.type).toBe('text');
  expect(input.getAttribute('autocomplete')).toBe('off');
  expect(input.hasAttribute('data-1p-ignore')).toBe(true);
  const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(input, { target: { value: ' synthetic-client-secret-sentinel ' } });
  api.status.mockResolvedValue(connected);
  const reads = api.status.mock.calls.length;
  fireEvent.click(save);
  await within(dialog).findByText('Client secret saved.');
  expect(api.saveSecret).toHaveBeenCalledWith('scout', {
    installationId: 'installation-1',
    clientSecret: 'synthetic-client-secret-sentinel',
  });
  expect(within(dialog).queryByLabelText('Client secret')).toBeNull();
  await waitFor(() => expect(api.status.mock.calls.length).toBeGreaterThan(reads));
  await waitFor(() => expect(fact.textContent).toBe('Stored on this machineClient secret saved.'));
  expect(within(dialog).queryByRole('button', { name: /Client secret/ })).toBeNull();
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-client-secret-sentinel');
  expect(dialog.textContent).not.toContain('synthetic-client-secret-sentinel');
});

it.each([
  ['rejected', 'Linear didn’t accept this Client secret. Check that it belongs to the app with this Client ID.'],
  ['expired', 'Linear no longer accepts this authorization. Authorize again to reconnect.'],
  ['unavailable', 'Couldn’t check it with Linear. Nothing was saved; try again later.'],
  [
    'unsaved',
    'Anima couldn’t store Linear’s answer, so nothing was saved. Try again. If Linear has ended this authorization, you’ll be asked to authorize again.',
  ],
  ['changed', 'This connection changed meanwhile, so nothing was saved.'],
  ['request failed', 'Couldn’t save it. Try again.'],
] as const)('a secret that was not saved (%s) says why and keeps nothing typed', async (result, message) => {
  api.status.mockResolvedValue({ ...connected, clientSecretSaved: false });
  if (result === 'request failed') api.saveSecret.mockRejectedValue(new Error('private-failure-sentinel'));
  else api.saveSecret.mockResolvedValue({ result });
  mount();
  await screen.findByText('Demo workspace');
  const dialog = await openDialog('Manage');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add Client secret' }));
  const input = within(dialog).getByLabelText('Client secret') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'synthetic-client-secret-sentinel' } });
  const reads = api.status.mock.calls.length;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  const alert = await within(dialog).findByRole('alert');
  expect(alert.textContent).toBe(message);
  // Every outcome, including a lost answer, re-reads what is actually stored.
  await waitFor(() => expect(api.status.mock.calls.length).toBeGreaterThan(reads));
  // Only Linear's invalid_client answer may call the secret wrong.
  if (result !== 'rejected') expect(alert.textContent).not.toMatch(/accept this Client secret|wrong|incorrect|invalid/i);
  expect(input.value).toBe('');
  expect(within(dialog).getByText('Client secret', { selector: 'dt' }).nextElementSibling!.textContent).toContain('Not stored');
  expect(dialog.textContent).not.toContain('private-failure-sentinel');
});

it('a secret that does not match Linear’s rules is not sent', async () => {
  api.status.mockResolvedValue({ ...connected, clientSecretSaved: false });
  mount();
  await screen.findByText('Demo workspace');
  const dialog = await openDialog('Manage');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add Client secret' }));
  fireEvent.change(within(dialog).getByLabelText('Client secret'), { target: { value: 'has a space' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Paste the Client secret exactly as Linear shows it.');
  expect(api.saveSecret).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(within(dialog).queryByLabelText('Client secret')).toBeNull();
  expect(within(dialog).queryByRole('alert')).toBeNull();
});

it.each([
  [false, 'Add', 'Access couldn’t be renewed. Add the app’s Client secret below, from its page in Linear.'],
  [
    true,
    'Replace',
    'Access couldn’t be renewed. Check the Client ID and Client secret on the app’s page in Linear, and replace the secret below if it changed.',
  ],
] as const)('only an invalid_client answer from Linear raises an alert (secret stored: %s)', async (saved, action, body) => {
  api.status.mockResolvedValue({ ...connected, clientSecretSaved: saved, clientRejected: true });
  mount();
  await screen.findByText('Credentials not accepted');
  expect(screen.getByText('Demo workspace')).toBeTruthy();
  const dialog = await openDialog('Manage');
  const alert = within(dialog).getByRole('alert');
  expect(alert.textContent).toBe(`Linear didn’t accept this app’s credentials${body}`);
  expect(alert.textContent).not.toMatch(/disconnected|broken|revoked/i);
  expect(within(dialog).getByRole('button', { name: `${action} Client secret` })).toBeTruthy();
  expect(within(dialog).getByRole('heading', { name: 'Connected to Demo workspace' })).toBeTruthy();
  // The header must not promise work the alert says can't happen.
  const header = within(dialog).getByRole('heading', { name: 'Connected to Demo workspace' }).closest('header')!;
  expect(header.textContent).toContain('Scout can’t work in Linear until Linear accepts this app’s credentials.');
  expect(header.textContent).not.toContain('Mention');
  expect(header.querySelector('.text-health-ok')).toBeNull();
  expect(header.querySelector('.text-health-error svg')).toBeTruthy();
});

it('a lost answer for a secret Linear still rejects asks to try again', async () => {
  api.status.mockResolvedValue({ ...connected, clientRejected: true });
  api.saveSecret.mockRejectedValue(new Error('private-failure-sentinel'));
  mount();
  await screen.findByText('Credentials not accepted');
  const dialog = await openDialog('Manage');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Replace Client secret' }));
  fireEvent.change(within(dialog).getByLabelText('Client secret'), { target: { value: 'synthetic-client-secret-sentinel' } });
  const reads = api.status.mock.calls.length;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText('Couldn’t save it. Try again.')).toBeTruthy();
  expect(api.status.mock.calls.length).toBeGreaterThan(reads);
  expect((within(dialog).getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
  expect(dialog.textContent).not.toContain('private-failure-sentinel');
});

it('a save whose answer is lost shows what was actually stored', async () => {
  api.status.mockResolvedValue({ ...connected, clientSecretSaved: false });
  api.saveSecret.mockImplementation(async () => {
    // The server stored the secret, but its answer never arrived.
    api.status.mockResolvedValue({ ...connected, clientSecretSaved: true });
    throw new Error('private-failure-sentinel');
  });
  mount();
  await screen.findByText('Demo workspace');
  const dialog = await openDialog('Manage');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add Client secret' }));
  fireEvent.change(within(dialog).getByLabelText('Client secret'), { target: { value: 'synthetic-client-secret-sentinel' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  const fact = within(dialog).getByText('Client secret', { selector: 'dt' }).nextElementSibling!;
  // Stored and accepted: nothing to try again, and no claim that it failed.
  await waitFor(() => expect(fact.textContent).toBe('Stored on this machine'));
  expect(within(dialog).queryByLabelText('Client secret')).toBeNull();
  expect(within(dialog).queryByRole('alert')).toBeNull();
  expect(dialog.textContent).not.toMatch(/Couldn’t save|Nothing was (stored|saved)/);
  expect(dialog.textContent).not.toContain('private-failure-sentinel');
});
