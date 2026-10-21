import { act, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// main.tsx renders at import time, so each test sets the router it should see,
// then imports a fresh copy of the module.
const routerState = vi.hoisted(() => ({ router: null as unknown }));
vi.mock('./router', () => ({
  get router() {
    return routerState.router;
  },
}));

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountMain() {
  await act(async () => {
    await import('./main');
  });
}

it('keeps the app running and only reports when an error reaches window', async () => {
  routerState.router = createMemoryRouter([{ path: '/', element: <p>app alive</p> }]);
  await mountMain();
  await screen.findByText('app alive');

  const error = new Error('<img src="x">handler failed');
  act(() => {
    window.dispatchEvent(new ErrorEvent('error', { message: error.message, error }));
  });

  expect(screen.getByText('app alive')).toBeTruthy();
  expect(document.querySelector('#root img')).toBeNull();
  expect(fetch).toHaveBeenCalledWith('/api/client-errors', expect.objectContaining({ method: 'POST' }));
});

it('shows the shared fallback, as text, when rendering fails outside the routes', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  routerState.router = {
    get state() {
      throw new Error('<b>router failed</b>');
    },
  };
  await mountMain();

  await screen.findByText('Something went wrong');
  expect(screen.getByText('<b>router failed</b>')).toBeTruthy();
  expect(document.querySelector('#root b')).toBeNull();
});
