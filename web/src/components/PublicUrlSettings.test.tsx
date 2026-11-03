import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import PublicUrlSettings from './PublicUrlSettings';

const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), check: vi.fn() }));
vi.mock('@/api/public-url', () => ({
  publicUrlKey: ['server', 'public-url'],
  publicUrlCheckKey: ['server', 'public-url-check'],
  fetchPublicUrl: api.read,
  savePublicUrl: api.save,
  checkPublicUrl: api.check,
}));
vi.mock('@/api/linear', () => ({ linearSetupKey: ['linear', 'setup'] }));

const checked = (result: Record<string, unknown>) => ({ publicUrl: 'https://anima.example.com', passwordSet: true, checkedAt: '2026-11-03T00:00:00Z', ...result });
beforeEach(() => {
  vi.clearAllMocks();
  api.read.mockResolvedValue({});
  api.check.mockResolvedValue(checked({ reachable: true, status: 200 }));
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <PublicUrlSettings />
    </QueryClientProvider>,
  );
  return invalidate;
}
const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;

it('validates a global origin, saves it normalized, refreshes the Linear setup and checks it', async () => {
  const invalidate = mount();
  const input = await screen.findByRole('textbox', { name: 'Public address' });
  expect(save().disabled).toBe(true);
  expect(api.check).not.toHaveBeenCalled();

  fireEvent.change(input, { target: { value: 'https://anima.example.com/webhook' } });
  fireEvent.click(save());
  expect(screen.getByRole('alert').textContent).toContain('with no path');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(api.save).not.toHaveBeenCalled();

  api.save.mockRejectedValueOnce(new Error('private-secret'));
  fireEvent.change(input, { target: { value: 'https://anima.example.com/' } });
  fireEvent.click(save());
  await screen.findByText('Could not save the address. Try again.');
  expect(screen.queryByText(/private-secret/)).toBeNull();

  api.save.mockResolvedValue({ publicUrl: 'https://anima.example.com' });
  fireEvent.click(save());
  await screen.findByText('Saved for all agents');
  expect(api.save).toHaveBeenLastCalledWith('https://anima.example.com');
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['linear', 'setup'] }));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['server', 'public-url-check'] });
  expect((input as HTMLInputElement).value).toBe('https://anima.example.com');
  expect(save().disabled).toBe(true);
});

it('a saved address is checked: one forwarding target, and what to update after changing it', async () => {
  api.read.mockResolvedValue({ publicUrl: 'https://anima.example.com' });
  mount();
  await screen.findByText(/Reachable\. Requests to this address arrive at this Anima\./);
  expect(api.check).toHaveBeenCalledTimes(1);
  expect(screen.getByText('A dashboard password is set. The dashboard asks for it wherever it opens.')).toBeTruthy();
  expect(screen.getByText(/Forward the whole address to this dashboard/)).toBeTruthy();
  expect(screen.queryByText('/api/linear/oauth/callback')).toBeNull();
  expect(screen.getByText(/also update the webhook and callback URLs/)).toBeTruthy();
  expect(save().disabled).toBe(true);
});

it('without a dashboard password and no answer for the dashboard path, the check says a forwarded address is open unless a gateway asks first', async () => {
  api.read.mockResolvedValue({ publicUrl: 'https://anima.example.com' });
  api.check.mockResolvedValue(checked({ reachable: true, status: 200, passwordSet: false }));
  mount();
  await screen.findByText(/No dashboard password is set\. If the whole address is forwarded here, anyone who opens it gets the\s+dashboard unless a sign-in gateway/);
  expect(screen.getByText('npx -y @meetquinn/animactl@latest dashboard-auth set --password-stdin')).toBeTruthy();
});

const WARNING = 'Anyone can open the dashboard at this address';

it('warns prominently when Anima opened the dashboard through the address without signing in', async () => {
  api.read.mockResolvedValue({ publicUrl: 'https://anima.example.com' });
  api.check.mockResolvedValue(checked({ reachable: true, status: 200, passwordSet: false, dashboard: { open: true, status: 200 } }));
  mount();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain(WARNING);
  expect(alert.textContent).toContain('Anima opened it through this address without signing in.');
  expect(alert.textContent).toContain('let /webhooks/ through');
  expect(within(alert).getByText('npx -y @meetquinn/animactl@latest dashboard-auth set --password-stdin')).toBeTruthy();
  // Still reachable, and no line beside it says what protects the dashboard.
  const status = screen.getByRole('status');
  expect(status.textContent).toContain('Reachable. Requests to this address arrive at this Anima.');
  expect(status.textContent).not.toMatch(/password|gateway|couldn’t open/);
  expect(screen.getAllByRole('alert')).toHaveLength(1);
});

it.each([
  [{ passwordSet: true, dashboard: { open: false, status: 401 } }, 'A dashboard password is set. The dashboard asks for it wherever it opens.'],
  [{ passwordSet: true, dashboard: { open: false, status: 302 } }, 'A dashboard password is set. The dashboard asks for it wherever it opens.'],
  [{ passwordSet: false, dashboard: { open: false, status: 302 } }, 'No dashboard password is set, but Anima couldn’t open the dashboard through this address without signing in (HTTP 302). Keep what is in front of it.'],
  [{ passwordSet: false, dashboard: { open: false, status: 404 } }, 'Anima couldn’t open the dashboard through this address without signing in (HTTP 404).'],
])('no warning when the dashboard did not open at the address: %o', async (result, message) => {
  api.read.mockResolvedValue({ publicUrl: 'https://anima.example.com' });
  api.check.mockResolvedValue(checked({ reachable: true, status: 200, ...result }));
  mount();
  await screen.findByText(/Reachable\. Requests to this address arrive at this Anima\./);
  expect(screen.getByRole('status').textContent).toContain(message);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(WARNING)).toBeNull();
});

it('warns even when Linear’s path is blocked, next to what is in the way', async () => {
  api.read.mockResolvedValue({ publicUrl: 'https://anima.example.com' });
  api.check.mockResolvedValue(checked({ reachable: false, failure: 'gateway', status: 403, passwordSet: false, dashboard: { open: true, status: 200 } }));
  mount();
  await screen.findByText('Not reachable yet');
  const alerts = screen.getAllByRole('alert');
  expect(alerts.map((alert) => alert.textContent?.includes(WARNING))).toEqual([false, true]);
});

it.each([
  [{ failure: 'gateway', status: 302 }, 'A sign-in page or access rule answered (HTTP 302). Let /webhooks/ through it'],
  [{ failure: 'elsewhere', status: 404 }, 'Something answered (HTTP 404), but not this Anima.'],
  [{ failure: 'unreachable', status: 530 }, 'Anima couldn’t reach itself at this address (HTTP 530).'],
  [{ failure: 'unreachable' }, 'Anima couldn’t reach itself at this address. Check that your tunnel is running'],
  [{ failure: 'timeout' }, 'The address didn’t answer within 5 seconds.'],
])('an unreachable address names what is in the way: %o', async (result, message) => {
  api.read.mockResolvedValue({ publicUrl: 'https://anima.example.com' });
  api.check.mockResolvedValueOnce(checked({ reachable: false, ...result }));
  mount();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Not reachable yet');
  expect(alert.textContent).toContain(message);
  fireEvent.click(within(alert).getByRole('button', { name: 'Check again' }));
  await screen.findByText(/Reachable\. Requests to this address arrive at this Anima\./);
});

it('a failed read offers a retry instead of an empty form', async () => {
  api.read.mockRejectedValueOnce(new Error('private-read-error'));
  mount();
  await screen.findByText(/Could not read the public address/);
  expect(screen.queryByRole('textbox', { name: 'Public address' })).toBeNull();
  expect(screen.queryByText(/private-read-error/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('textbox', { name: 'Public address' });
});
