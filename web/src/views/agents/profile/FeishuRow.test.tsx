import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentFeishuScopeCheckState, AgentFeishuScopeStatus } from '@shared/agent-config';
import { FeishuRow } from './FeishuRow';

const api = vi.hoisted(() => ({
  scopes: vi.fn(),
  refresh: vi.fn(),
  sync: vi.fn(),
}));
vi.mock('@/api/agents', () => ({
  fetchAgentFeishuScopeStatus: api.scopes,
  refreshAgentData: api.refresh,
  syncAgentFeishuAvatar: api.sync,
}));

function scopeStatus(state: AgentFeishuScopeCheckState): AgentFeishuScopeStatus {
  return {
    appId: 'cli_synthetic',
    connected: true,
    profileName: { granted: state === 'granted', scope: 'contact:user.basic_profile:readonly', state },
    recommended: { granted: state === 'granted', missingScopes: [], scopes: [], state },
  } as AgentFeishuScopeStatus;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FeishuRow agentId="scout" agentName="Scout" appId="cli_synthetic" botOpenId="ou_synthetic" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.sync.mockResolvedValue({});
});

it.each(['granted', 'not_connected'] as const)('stays quiet when permissions are %s', async (state) => {
  api.scopes.mockResolvedValue(scopeStatus(state));
  mount();
  await waitFor(() => expect(api.scopes).toHaveBeenCalled());
  const manage = await screen.findByRole('button', { name: 'Manage Feishu' });
  expect(manage.textContent).toBe('');
  expect(screen.queryByText(/permissions/i)).toBeNull();
  fireEvent.click(manage);
  expect(within(screen.getByRole('dialog')).queryByText('Authorize Feishu permissions')).toBeNull();
});

it('puts missing permissions on the row and the checklist in the dialog, from one request', async () => {
  api.scopes.mockResolvedValue(scopeStatus('missing'));
  mount();
  expect(await screen.findByText('Permissions to authorize')).toBeTruthy();
  const review = screen.getByRole('button', { name: 'Review Feishu' });
  expect(review.textContent).toBe('Review');
  fireEvent.click(review);
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Authorize Feishu permissions')).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: 'Recheck access' })).toBeTruthy();
  // The card in the dialog reads the row's answer, it does not ask again.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(api.scopes).toHaveBeenCalledTimes(1);
});

it('quiets the row once a recheck in the dialog finds the permissions on', async () => {
  api.scopes.mockResolvedValue(scopeStatus('missing'));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Review Feishu' }));
  api.scopes.mockResolvedValue(scopeStatus('granted'));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Recheck access' }));
  expect(await screen.findByText(/Recommended Feishu permissions are on/)).toBeTruthy();
  expect(screen.queryByText('Permissions to authorize')).toBeNull();
  expect(screen.getByRole('button', { name: 'Manage Feishu' }).textContent).toBe('');
});

it.each([
  ['the check fails', () => api.scopes.mockRejectedValue(new Error('feishu down'))],
  ['Feishu cannot say', () => api.scopes.mockResolvedValue(scopeStatus('unknown'))],
])('says so when %s instead of looking healthy', async (_, arrange) => {
  arrange();
  mount();
  expect(await screen.findByText('Could not check Feishu permissions')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Review Feishu' }));
  expect(within(screen.getByRole('dialog')).getByText('Authorize Feishu permissions')).toBeTruthy();
  // Opening the dialog does not send the row back to loading.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByText('Could not check Feishu permissions')).toBeTruthy();
  expect(api.scopes).toHaveBeenCalledTimes(1);
});
