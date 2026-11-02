import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import PublicUrlSettings from './PublicUrlSettings';
const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('@/api/public-url', () => ({
  publicUrlKey: ['server', 'public-url'],
  fetchPublicUrl: api.read,
  savePublicUrl: api.save,
}));
beforeEach(() => {
  vi.clearAllMocks();
  api.read.mockResolvedValue({ dashboardPort: 14174 });
});
it('validates a global origin, saves it normalized and refreshes the connection form', async () => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <PublicUrlSettings />
    </QueryClientProvider>,
  );
  const input = await screen.findByLabelText('Public URL');
  const submit = () =>
    fireEvent.submit(screen.getByRole('button', { name: 'Save public address' }).closest('form')!);
  fireEvent.change(input, { target: { value: 'https://anima.example.com/webhook' } });
  submit();
  expect(screen.getByRole('alert').textContent).toContain('without a path');
  expect(api.save).not.toHaveBeenCalled();
  api.save.mockRejectedValueOnce(new Error('private-secret'));
  fireEvent.change(input, { target: { value: 'https://anima.example.com/' } });
  submit();
  await screen.findByText(/Could not save/);
  expect(screen.queryByText(/private-secret/)).toBeNull();
  api.save.mockResolvedValue({ publicUrl: 'https://anima.example.com', dashboardPort: 14174 });
  submit();
  await screen.findByText(/Public address saved/);
  expect(api.save).toHaveBeenLastCalledWith('https://anima.example.com');
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['linear', 'setup'] }));
});
