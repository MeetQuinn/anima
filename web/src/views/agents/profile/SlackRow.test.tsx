import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentSlackManifestUpdateInfo } from '@shared/slack-manifest';
import { SlackRow } from './SlackRow';

const api = vi.hoisted(() => ({
  manifest: vi.fn(),
  upgrade: vi.fn(),
  refresh: vi.fn(),
  sync: vi.fn(),
}));
vi.mock('@/api/agents', () => ({
  fetchAgentSlackManifestUpdate: api.manifest,
  upgradeAgentSlackManifest: api.upgrade,
  refreshAgentData: api.refresh,
  syncAgentAvatar: api.sync,
}));

const upToDate: AgentSlackManifestUpdateInfo = {
  agentVersion: 4,
  currentVersion: 4,
  manifestUpdateYaml: '',
  needsUpdate: false,
};

function mount(iconUrl: string | undefined = 'https://avatars.example.com/demo.png') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SlackRow
        agentId="scout"
        agentName="Scout"
        appId="A0SYNTHETIC"
        workspaceName="Demo workspace"
        workspaceIconUrl={iconUrl}
      />
    </QueryClientProvider>,
  );
}
const tile = () => document.querySelector('[data-tile]');

beforeEach(() => {
  vi.clearAllMocks();
  api.manifest.mockResolvedValue(upToDate);
  api.sync.mockResolvedValue({});
});

it('reads like every other connection row: workspace icon and name, one action', async () => {
  mount();
  await waitFor(() => expect(api.manifest).toHaveBeenCalled());
  expect(screen.getByText('Demo workspace')).toBeTruthy();
  expect(tile()?.getAttribute('src')).toBe('https://avatars.example.com/demo.png');
  // The handle is a detail of the dialog, as it is for Linear.
  expect(screen.queryByText('@scout')).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  // Nothing to do: an icon, no words.
  expect(screen.getByRole('button', { name: 'Manage Slack' }).textContent).toBe('');
  expect(screen.queryByRole('link')).toBeNull();
});

it('keeps app settings and avatar sync in the dialog', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Manage Slack' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('heading', { name: 'Connected to Demo workspace' })).toBeTruthy();
  expect(within(dialog).getByText('@scout')).toBeTruthy();
  expect(within(dialog).getByRole('link', { name: /Slack app settings/ }).getAttribute('href')).toBe(
    'https://api.slack.com/apps/A0SYNTHETIC/general',
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Sync avatar from Slack' }));
  await waitFor(() => expect(api.refresh).toHaveBeenCalledWith('scout'));
  expect(api.sync).toHaveBeenCalledWith('scout');

  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('says when the avatar sync fails instead of failing silently', async () => {
  api.sync.mockRejectedValue(new Error('slack down'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Manage Slack' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sync avatar from Slack' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Could not sync the avatar. Try again in a moment.');
  expect(api.refresh).not.toHaveBeenCalled();
});

it('surfaces a pending app update on the row and opens it expanded', async () => {
  api.manifest.mockResolvedValue({
    ...upToDate,
    agentVersion: 3,
    needsUpdate: true,
    manifestUpdateYaml: 'display_information:\n  name: scout\n',
  });
  mount();
  expect(await screen.findByText('Slack app update available')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Review Slack' }).textContent).toBe('Review');
  fireEvent.click(screen.getByRole('button', { name: 'Review Slack' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('button', { name: /Slack app update available/ }).getAttribute('aria-expanded')).toBe(
    'true',
  );
  expect(within(dialog).getByText(/one-time Slack app reinstall/)).toBeTruthy();
});

it.each([
  // The server stores '' when Slack reports no icon.
  ['no icon', ''],
  ['an icon that fails to load', 'https://avatars.example.com/gone.png'],
])('falls back to the workspace initial with %s', async (_, iconUrl) => {
  mount(iconUrl);
  if (iconUrl) fireEvent.error(tile()!);
  await waitFor(() => expect(tile()?.getAttribute('data-tile')).toBe('initial'));
  expect(tile()?.textContent).toBe('D');
});

it('stays open while the new token saves, so a failed save is still shown', async () => {
  api.manifest.mockResolvedValue({ ...upToDate, agentVersion: 3, needsUpdate: true });
  let fail: (error: Error) => void = () => undefined;
  api.upgrade.mockReturnValue(new Promise((_, reject) => (fail = reject)));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Review Slack' }));
  fireEvent.change(screen.getByPlaceholderText(/Bot User OAuth Token/), { target: { value: 'xoxb-synthetic' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.upgrade).toHaveBeenCalled());

  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Close Slack settings' }) as HTMLButtonElement).disabled).toBe(true);

  fail(new Error('invalid_auth'));
  expect(await within(screen.getByRole('dialog')).findByText('invalid_auth')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});
