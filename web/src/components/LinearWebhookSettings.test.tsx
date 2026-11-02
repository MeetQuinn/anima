import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import LinearWebhookSettings from './LinearWebhookSettings';

const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('@/api/linear', () => ({ fetchLinearSetup: api.read, saveLinearSetup: api.save }));
const defaults = { listener: { host: '127.0.0.1', port: 14185 }, listenerLocked: false };
beforeEach(() => {
  vi.clearAllMocks();
  api.read.mockResolvedValue(defaults);
});
function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <LinearWebhookSettings />
    </QueryClientProvider>,
  );
}
it('preserves an installed custom listener and keeps URLs read-only', async () => {
  api.read.mockResolvedValue({ webhookUrl: 'https://agents.example.com/webhook', listener: { host: '::1', port: 15123 }, listenerLocked: true });
  mount();
  expect((await screen.findByLabelText('Bind address') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('15123');
  expect(screen.queryByLabelText('Public webhook URL')).toBeNull();
});
it('saves only the listener and reports write failures without server secrets', async () => {
  mount(); await screen.findByLabelText('Port');
  api.save.mockRejectedValueOnce(new Error('private-secret-sentinel'));
  fireEvent.submit(screen.getByRole('button', { name: 'Save listener settings' }).closest('form')!);
  await screen.findByText(/Could not save/);
  expect(screen.queryByText(/private-secret-sentinel/)).toBeNull();
  api.save.mockResolvedValue(defaults);
  fireEvent.submit(screen.getByRole('button', { name: 'Save listener settings' }).closest('form')!);
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
  expect(api.save).toHaveBeenLastCalledWith({ listener: defaults.listener });
});
