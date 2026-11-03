// @vitest-environment-options {"url":"http://anima-host:4174"}
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { LinearSetup } from '@shared/linear-setup';
import { LinearConnectSteps } from './LinearConnectSteps';

const setup: LinearSetup = {
  publicUrl: 'https://agents.example.com',
  callbackUrl: 'https://agents.example.com/api/linear/oauth/callback',
  webhookUrl: 'https://agents.example.com/webhook',
  listener: { host: '127.0.0.1', port: 14185 },
  listenerLocked: false,
};
const avatar = 'https://avatars.slack-edge.com/2026-01-01/123_abc_72.png';

function mount(props: Partial<Parameters<typeof LinearConnectSteps>[0]> = {}) {
  const onInstall = vi.fn(async () => {});
  render(<LinearConnectSteps agentName="Milo" setup={setup} busy={false} disabled={false} onInstall={onInstall} {...props} />);
  return onInstall;
}
const manifestOf = (link: HTMLElement) => JSON.parse(new URL(link.getAttribute('href')!).searchParams.get('manifest')!);
const step = (n: number) => screen.getByText(new RegExp(`^Step ${n}`)).closest('li')!;

it('prefills the app from the machine address, names it after the agent and uses a public avatar as its icon', () => {
  mount({ avatarUrl: avatar });
  const link = screen.getByRole('link', { name: 'Create app in Linear' });
  const manifest = manifestOf(link);
  expect(manifest.oauth.client_name).toBe('Milo');
  expect(manifest.oauth.redirect_uris).toEqual(['https://agents.example.com/api/linear/oauth/callback']);
  expect(manifest.webhook.url).toBe('https://agents.example.com/webhook');
  expect(manifest.display).toEqual({ iconUrl: avatar });
  expect(screen.getByText(/with this avatar/)).toBeTruthy();
  expect(link.getAttribute('target')).toBe('_blank');
  // Machine plumbing lives with the address setting, not in each agent's steps.
  expect(screen.queryByText(/\/webhook/)).toBeNull();
  expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
});

it('creates the app without an icon when the avatar is not a public HTTPS image', () => {
  mount({ avatarUrl: '/api/agents/milo/avatar' });
  expect(manifestOf(screen.getByRole('link', { name: 'Create app in Linear' })).display).toBeUndefined();
  expect(screen.queryByText(/with this avatar/)).toBeNull();
  expect(document.querySelector('img')).toBeNull();
});

it('explains an invalid app name and withholds the creation link until it is fixed', () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  const input = screen.getByLabelText('App name in Linear');
  fireEvent.change(input, { target: { value: 'LinearBot' } });
  expect(screen.getByRole('alert').textContent).toContain('without “Linear”');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(screen.queryByRole('link', { name: 'Create app in Linear' })).toBeNull();
  fireEvent.change(input, { target: { value: 'Milo Reviewer' } });
  expect(manifestOf(screen.getByRole('link', { name: 'Create app in Linear' })).oauth.client_name).toBe('Milo Reviewer');
});

it('reveals credentials after the app step, enables Authorize only with both values and clears the secret after submitting', async () => {
  const onInstall = mount();
  expect(step(1).getAttribute('aria-current')).toBe('step');
  expect(screen.queryByLabelText('Client ID')).toBeNull();
  expect(screen.queryByRole('button', { name: /Authorize in Linear/ })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'I already have one' }));
  expect(screen.getByText('Using an app you already created.')).toBeTruthy();
  expect(step(2).getAttribute('aria-current')).toBe('step');
  const authorize = screen.getByRole('button', { name: /Authorize in Linear/ }) as HTMLButtonElement;
  expect(authorize.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: ' client-id ' } });
  expect(authorize.disabled).toBe(true);
  const secret = screen.getByLabelText('Webhook signing secret') as HTMLInputElement;
  // Pasted, not remembered: no password input, so browsers offer no saved or generated passwords.
  expect(secret.type).toBe('text');
  expect(secret.getAttribute('autocomplete')).toBe('off');
  expect(screen.getByLabelText('Client ID').getAttribute('autocomplete')).toBe('off');
  expect(document.querySelector('input[type="password"]')).toBeNull();
  fireEvent.change(secret, { target: { value: 'synthetic-signing-sentinel' } });
  expect(authorize.disabled).toBe(false);
  expect(step(3).getAttribute('aria-current')).toBe('step');

  fireEvent.click(authorize);
  await waitFor(() => expect(onInstall).toHaveBeenCalledTimes(1));
  expect(onInstall).toHaveBeenCalledWith({
    clientId: 'client-id',
    signingSecret: 'synthetic-signing-sentinel',
    callbackUrl: 'https://agents.example.com/api/linear/oauth/callback',
    listener: { host: '127.0.0.1', port: 14185 },
  });
  await waitFor(() => expect(secret.value).toBe(''));
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-signing-sentinel');
});

it('clicking Create marks the app step done so the credentials come next', () => {
  mount();
  fireEvent.click(screen.getByRole('link', { name: 'Create app in Linear' }));
  expect(screen.getByText('Opened in Linear.')).toBeTruthy();
  expect(screen.getByLabelText('Client ID')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Change' }));
  expect(screen.getByRole('link', { name: 'Create app in Linear' })).toBeTruthy();
});

it('a retry starts at the credentials of the existing app and shows why the last attempt could not start', () => {
  mount({ retrying: true, error: 'Use a separate Linear app for each agent.' });
  expect(screen.getByText('Using an app you already created.')).toBeTruthy();
  expect(screen.getByText(/Enter them again/)).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toBe('Use a separate Linear app for each agent.');
});

it('disabled or busy forms cannot authorize', () => {
  mount({ retrying: true, busy: true });
  expect((screen.getByLabelText('Client ID') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: /Opening Linear/ }) as HTMLButtonElement).disabled).toBe(true);
});
