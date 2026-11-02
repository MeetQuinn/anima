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
it('saves a public URL with default bind settings and reports validation and write failures', async () => {
  mount();
  const url = await screen.findByLabelText('Public webhook URL');
  expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('14185');
  fireEvent.change(url, { target: { value: 'https://127.0.0.1/webhook' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Save webhook settings' }).closest('form')!);
  expect(screen.getByRole('alert').textContent).toContain('public HTTPS');
  expect(api.save).not.toHaveBeenCalled();
  api.save.mockRejectedValueOnce(new Error('private-secret-sentinel'));
  fireEvent.change(url, { target: { value: 'https://agents.example.com/webhook' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Save webhook settings' }).closest('form')!);
  await screen.findByText(/Could not save/);
  expect(screen.queryByText(/private-secret-sentinel/)).toBeNull();
  api.save.mockResolvedValue({ ...defaults, webhookUrl: 'https://agents.example.com/webhook' });
  fireEvent.submit(screen.getByRole('button', { name: 'Save webhook settings' }).closest('form')!);
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
  expect(api.save).toHaveBeenLastCalledWith({
    webhookUrl: 'https://agents.example.com/webhook',
    listener: defaults.listener,
  });
});
it('preserves and locks an installed custom listener while allowing public address editing', async () => {
  api.read.mockResolvedValue({
    webhookUrl: 'https://old.example.com/webhook',
    listener: { host: '::1', port: 15123 },
    listenerLocked: true,
  });
  mount();
  await screen.findByLabelText('Public webhook URL');
  expect((screen.getByLabelText('Bind address') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('15123');
  expect((screen.getByLabelText('Public webhook URL') as HTMLInputElement).disabled).toBe(false);
  expect(screen.getByText(/update the webhook URL in existing Linear apps/)).toBeTruthy();
});
