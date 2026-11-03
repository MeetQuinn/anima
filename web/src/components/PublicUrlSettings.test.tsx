import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import PublicUrlSettings from './PublicUrlSettings';

const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), setup: vi.fn() }));
vi.mock('@/api/public-url', () => ({
  publicUrlKey: ['server', 'public-url'],
  fetchPublicUrl: api.read,
  savePublicUrl: api.save,
}));
vi.mock('@/api/linear', () => ({ fetchLinearSetup: api.setup }));

beforeEach(() => {
  vi.clearAllMocks();
  api.read.mockResolvedValue({});
  api.setup.mockResolvedValue({ listener: { host: '127.0.0.1', port: 14185 }, listenerLocked: false });
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

it('validates a global origin, saves it normalized and refreshes the Linear setup', async () => {
  const invalidate = mount();
  const input = await screen.findByRole('textbox', { name: 'Public address' });
  expect(save().disabled).toBe(true);
  expect(screen.queryByText('/webhook')).toBeNull();

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
  expect((input as HTMLInputElement).value).toBe('https://anima.example.com');
  expect(save().disabled).toBe(true);
});

it('shows what to forward from a saved address and what to update after changing it', async () => {
  api.read.mockResolvedValue({ publicUrl: 'https://anima.example.com' });
  api.setup.mockResolvedValue({ listener: { host: '::1', port: 15123 }, listenerLocked: true });
  mount();
  const routes = (await screen.findByText(/Forward these routes/)).parentElement!;
  expect(within(routes).getByText('https://anima.example.com')).toBeTruthy();
  expect(within(routes).getByText('/webhook')).toBeTruthy();
  expect(within(routes).getByText('[::1]:15123')).toBeTruthy();
  expect(within(routes).getByText('/api/linear/oauth/callback')).toBeTruthy();
  expect(screen.getByText(/also update the webhook and callback URLs/)).toBeTruthy();
  expect(save().disabled).toBe(true);
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
