import { useState } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { activityRow } from '@/lib/activities';
import type { ActivityFeedItem } from '@/lib/activity-feed';
import type { Activity } from '@shared/activity';
import { StepRow } from './AuditRows';

// StepRow calls activityRow exactly once per render, so its call count is the
// row's render count (React's Profiler also fires when the Profiler element
// itself re-renders, which is what the parent does here, so it cannot serve).
vi.mock('@/lib/activities', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/activities')>();
  return { ...mod, activityRow: vi.fn(mod.activityRow) };
});
const renders = vi.mocked(activityRow);

type StepItem = Extract<ActivityFeedItem, { kind: 'step' }>;

class CountingResizeObserver {
  static created = 0;
  constructor() {
    CountingResizeObserver.created += 1;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function activity(activityId: string, target: string): Activity {
  return {
    activityId,
    type: 'tool.call.started',
    createdAt: '2026-09-13T10:00:00.000Z',
    payload: { tool: 'claude.read', providerToolName: 'Read', target },
  };
}

// A parent that rebuilds the step item wrapper on every render (exactly what
// buildStepItems does after each poll) around the SAME activity record.
function Harness({ record }: { record: Activity }) {
  const [, bump] = useState(0);
  const item: StepItem = { kind: 'step', activity: record, timestamp: record.createdAt };
  return (
    <div>
      <button onClick={() => bump((n) => n + 1)}>rerender</button>
      <StepRow item={item} time="10:00" />
    </div>
  );
}

describe('StepRow memoisation', () => {
  const originalRO = globalThis.ResizeObserver;
  beforeEach(() => {
    renders.mockClear();
    CountingResizeObserver.created = 0;
    globalThis.ResizeObserver = CountingResizeObserver as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = originalRO;
  });

  it('skips re-render and keeps its ResizeObserver when the activity record is unchanged', () => {
    const record = activity('a1', 'src/index.ts');
    const { getByText } = render(<Harness record={record} />);
    expect(renders).toHaveBeenCalledTimes(1);
    expect(CountingResizeObserver.created).toBe(1);

    act(() => getByText('rerender').click());
    act(() => getByText('rerender').click());
    // Parent rendered twice more with a fresh item wrapper each time; the
    // memoised row must not render again nor rebuild its observer.
    expect(renders).toHaveBeenCalledTimes(1);
    expect(CountingResizeObserver.created).toBe(1);
  });

  it('re-renders when the activity record itself changes (positive control)', () => {
    const { rerender, getByText } = render(<Harness record={activity('a1', 'src/index.ts')} />);
    expect(renders).toHaveBeenCalledTimes(1);
    rerender(<Harness record={activity('a1', 'src/other.ts')} />);
    expect(renders).toHaveBeenCalledTimes(2);
    expect(getByText('src/other.ts')).toBeTruthy();
    // The secondary text changed, so the overflow measurement re-arms once.
    expect(CountingResizeObserver.created).toBe(2);
  });
});
