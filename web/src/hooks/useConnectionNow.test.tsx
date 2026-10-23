import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentRuntimeHealthSummary } from '@shared/snapshot';
import { slackConnectionDisplay } from '@/lib/slack-connection';
import { useConnectionNow } from './useConnectionNow';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('ages connection state together for surfaces mounted at different times', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T08:00:00Z'));
  const at = new Date().toISOString();
  const health: AgentRuntimeHealthSummary = {
    state: 'healthy',
    updatedAt: at,
    runtime: {
      providerChildExpected: false,
      transports: { slack: { state: 'connected', observedAt: at, since: at, attempts: 0 } },
    },
  };
  function Surface({ name }: { name: string }) {
    const now = useConnectionNow();
    return (
      <output data-testid={name}>{slackConnectionDisplay(health, now.getTime())?.label}</output>
    );
  }
  const first = render(<Surface name="sidebar" />);
  act(() => vi.advanceTimersByTime(2_000));
  const second = render(<Surface name="activity" />);
  act(() => vi.advanceTimersByTime(30_000));
  expect(screen.getByTestId('sidebar').textContent).toBe('Slack connected');
  expect(screen.getByTestId('activity').textContent).toBe('Slack connected');
  act(() => vi.advanceTimersByTime(3_000));
  expect(screen.getByTestId('sidebar').textContent).toBe('Slack status unavailable');
  expect(screen.getByTestId('activity').textContent).toBe('Slack status unavailable');
  first.unmount();
  act(() => vi.advanceTimersByTime(5_000));
  expect(screen.getByTestId('activity').textContent).toBe('Slack status unavailable');
  second.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
