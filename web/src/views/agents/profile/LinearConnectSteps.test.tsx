// @vitest-environment-options {"url":"http://anima-host:4174"}
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LinearConnectSteps } from './LinearConnectSteps';

vi.mock('@/api/linear', () => ({
  fetchLinearSetup: async () => ({
    publicUrl: 'https://agents.example.com',
    callbackUrl: 'https://agents.example.com/api/linear/oauth/callback',
    webhookUrl: 'https://agents.example.com/webhook',
    listener: { host: '127.0.0.1', port: 14185 },
    listenerLocked: false,
  }),
}));

it('uses the configured public callback even when the dashboard has a non-loopback HTTP origin', async () => {
  render(<QueryClientProvider client={new QueryClient()}><LinearConnectSteps agentName="Milo" busy={false} disabled={false} onInstall={vi.fn()} /></QueryClientProvider>);
  const link = await screen.findByRole('link', { name: 'Create app in Linear' });
  const manifest = JSON.parse(new URL(link.getAttribute('href')!).searchParams.get('manifest')!);
  expect(manifest.oauth.redirect_uris).toEqual(['https://agents.example.com/api/linear/oauth/callback']);
  expect(manifest.webhook.url).toBe('https://agents.example.com/webhook');
  expect(screen.getByText(/Forward \/webhook to 127.0.0.1:14185/).textContent).toContain('dashboard’s loopback listener');
  expect(screen.getByText(/Forward \/webhook/).closest('details')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByLabelText('OAuth callback URL')).toBeNull();
  fireEvent.change(screen.getByLabelText('App name'), { target: { value: 'LinearBot' } });
  expect(screen.getByRole('alert').textContent).toContain('app name');
});
