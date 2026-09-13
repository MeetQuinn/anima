import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProviderSessionStatsSummary } from '@shared/snapshot';
import { ContextOccupancy } from './SessionStats';

function stats(
  partial: Omit<ProviderSessionStatsSummary, 'activityId' | 'createdAt'> &
    Partial<Pick<ProviderSessionStatsSummary, 'activityId' | 'createdAt'>>,
): ProviderSessionStatsSummary {
  return {
    activityId: 'actv_test_context_occupancy',
    createdAt: '2026-09-13T00:00:00.000Z',
    ...partial,
  };
}

describe('ContextOccupancy', () => {
  it('uses model window when auto-compact exceeds it', () => {
    render(
      <ContextOccupancy
        stats={stats({
          currentContextTokens: 90_000,
          autoCompactWindow: 272_000,
          contextWindow: 200_000,
        })}
      />,
    );
    expect(screen.getByText('45%')).toBeTruthy();
    expect(screen.getByText('full')).toBeTruthy();
    expect(
      screen.getByText(/90K \/ 200K model window · auto-compact 272K · as of latest activity/),
    ).toBeTruthy();
  });

  it('keeps to-compact when compact threshold is within the model window', () => {
    render(
      <ContextOccupancy
        stats={stats({
          currentContextTokens: 90_000,
          autoCompactWindow: 180_000,
          contextWindow: 200_000,
        })}
      />,
    );
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('to compact')).toBeTruthy();
    expect(
      screen.getByText(/90K \/ 180K · model window 200K · as of latest activity/),
    ).toBeTruthy();
  });

  it('keeps to-compact when compact threshold equals the model window', () => {
    render(
      <ContextOccupancy
        stats={stats({
          currentContextTokens: 100_000,
          autoCompactWindow: 200_000,
          contextWindow: 200_000,
        })}
      />,
    );
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('to compact')).toBeTruthy();
    expect(
      screen.getByText(/100K \/ 200K · model window 200K · as of latest activity/),
    ).toBeTruthy();
  });
});
