// @vitest-environment-options {"url":"http://anima-host:4174"}
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LinearConnectSteps } from './LinearConnectSteps';

vi.mock('@/api/linear', () => ({
  fetchLinearSetup: async () => ({
    webhookUrl: 'https://agents.example.com/webhook',
    listener: { host: '127.0.0.1', port: 14185 },
    listenerLocked: false,
  }),
}));

it('opens callback options on a non-loopback HTTP dashboard and identifies the invalid field', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LinearConnectSteps
        agentName="Milo"
        busy={false}
        disabled={false}
        onBusy={vi.fn()}
        onInstall={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const callback = await screen.findByLabelText('OAuth callback URL');
  const options = callback.closest('details')!;
  expect(options.open).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('Set an HTTPS or loopback callback');
  expect(screen.queryByRole('link', { name: 'Create app in Linear' })).toBeNull();
  fireEvent.change(callback, {
    target: { value: 'https://anima.example.com/api/linear/oauth/callback' },
  });
  expect(screen.queryByRole('alert')).toBeNull();
  const manifest = JSON.parse(
    new URL(
      screen.getByRole('link', { name: 'Create app in Linear' }).getAttribute('href')!,
    ).searchParams.get('manifest')!,
  );
  expect(manifest.oauth.redirect_uris).toEqual([
    'https://anima.example.com/api/linear/oauth/callback',
  ]);
  fireEvent.change(screen.getByLabelText('App name'), { target: { value: 'LinearBot' } });
  expect(screen.getByRole('alert').textContent).toContain('app name');
  expect(screen.getByRole('alert').textContent).not.toContain('callback');
  expect(options.open).toBe(true);
});
