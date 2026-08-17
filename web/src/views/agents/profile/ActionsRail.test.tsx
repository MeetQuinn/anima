/**
 * Connected + presentational regression for the Profile Actions rail
 * (task #185, PR #677 gate). Exists because the rail's destructive wiring was
 * unpinned: Milo's gate mutation swapped `onRemove={confirmRemove}` for
 * `confirmRestart` and the whole suite stayed green. These tests pin:
 *
 *   1. Connected `ProfileActionsRail` (real useAgentActions + useConfirm +
 *      ConfirmModal; only the API/router/directory seams mocked):
 *      each confirm plate opens ITS OWN dialog and executes ITS OWN effect —
 *      Rotate→rotateAgentSession, Restart→restartAgent,
 *      Remove→removeAgent + navigate home — against the route agent's id.
 *   2. The immediate (no-confirm) Disable/Enable path hits
 *      disableAgent/enableAgent + refreshDashboardData.
 *   3. Disable while running (totoday 08-17): the button stays LIVE, the
 *      click opens the "Agent is running" notice (single OK, no Cancel),
 *      and disableAgent is NEVER called — the notice must not interrupt or
 *      disable anything.
 *   4. Presentational gating matrix: disabled blocks Restart,
 *      `showRestart={false}` (provider-health suppression) renders no
 *      Restart plate at all.
 *
 * Note: this setup registers no jest-dom matchers — use plain DOM assertions.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionsRail, ProfileActionsRail } from './ActionsRail';

const api = vi.hoisted(() => ({
  disableAgent: vi.fn(async () => {}),
  enableAgent: vi.fn(async () => {}),
  fetchAgentDiagnostics: vi.fn(async () => ({})),
  removeAgent: vi.fn(async () => {}),
  restartAgent: vi.fn(async () => {}),
  rotateAgentSession: vi.fn(async () => {}),
  refreshDashboardData: vi.fn(),
}));
vi.mock('@/api/agents', () => api);

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({
  useParams: () => ({ agentId: 'agent-1' }),
  useNavigate: () => navigateMock,
}));

const directory = vi.hoisted(() => ({
  agents: [{ id: 'agent-1', name: 'Nora' }] as unknown[],
  statuses: [{ agentId: 'agent-1', currentItemId: null }] as unknown[],
}));
vi.mock('@/hooks/useAgentDirectory', () => ({
  useAgents: () => ({ data: directory.agents }),
  useAgentStatuses: () => ({ data: directory.statuses }),
}));

function railButton(name: RegExp): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

async function confirmDialog(dialogName: string, confirmLabel: string) {
  const dialog = await screen.findByRole('dialog', { name: dialogName });
  const confirmButton = Array.from(dialog.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === confirmLabel,
  );
  expect(confirmButton).toBeTruthy();
  fireEvent.click(confirmButton!);
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull();
  });
}

describe('ProfileActionsRail (connected)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    directory.agents = [{ id: 'agent-1', name: 'Nora' }];
    directory.statuses = [{ agentId: 'agent-1', currentItemId: null }];
  });
  afterEach(cleanup);

  it('maps each confirm plate to its own dialog and effect for the route agent', async () => {
    render(<ProfileActionsRail />);

    // Rotate → its dialog → rotateAgentSession only.
    fireEvent.click(railButton(/Rotate session/));
    await confirmDialog('Rotate primary session?', 'Confirm');
    expect(api.rotateAgentSession.mock.calls).toEqual([['agent-1']]);
    expect(api.restartAgent.mock.calls.length).toBe(0);
    expect(api.removeAgent.mock.calls.length).toBe(0);

    // Restart → its dialog → restartAgent only.
    fireEvent.click(railButton(/Restart agent/));
    await confirmDialog('Restart this agent?', 'Restart');
    expect(api.restartAgent.mock.calls).toEqual([['agent-1']]);
    expect(api.removeAgent.mock.calls.length).toBe(0);

    // Remove → its dialog → removeAgent + navigate home. This is the exact
    // cross-wire the gate mutation exposed: the Remove plate must not reach
    // any other effect.
    expect(navigateMock.mock.calls.length).toBe(0);
    fireEvent.click(railButton(/Remove agent/));
    await confirmDialog('Remove this agent?', 'Remove');
    expect(api.removeAgent.mock.calls).toEqual([['agent-1']]);
    expect(navigateMock.mock.calls).toEqual([['/']]);
    // One effect per plate: totals unchanged elsewhere.
    expect(api.rotateAgentSession.mock.calls.length).toBe(1);
    expect(api.restartAgent.mock.calls.length).toBe(1);
  });

  it('runs the immediate Disable path (no confirm) with a dashboard refresh', async () => {
    render(<ProfileActionsRail />);

    fireEvent.click(railButton(/^Disable$/));
    expect(screen.queryByRole('dialog')).toBeNull(); // immediate, not confirmed
    await waitFor(() => {
      expect(api.disableAgent.mock.calls).toEqual([['agent-1']]);
      expect(api.refreshDashboardData.mock.calls.length).toBe(1);
    });
    expect(api.enableAgent.mock.calls.length).toBe(0);
  });

  it('keeps Disable live while running and shows the notice instead of disabling', async () => {
    directory.statuses = [{ agentId: 'agent-1', currentItemId: 'item-9' }];
    render(<ProfileActionsRail />);

    const disable = railButton(/^Disable$/);
    expect(disable.disabled).toBe(false); // always clickable (totoday 08-17)

    fireEvent.click(disable);
    const dialog = await screen.findByRole('dialog', { name: 'Agent is running' });
    // Notice, not a decision: exactly one button (OK), no Cancel.
    const buttons = Array.from(dialog.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['OK']);
    // The notice promises it never interrupts work — pin that copy.
    expect(dialog.textContent).toContain('Disabling never interrupts work in progress');

    fireEvent.click(buttons[0]!);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Agent is running' })).toBeNull();
    });
    // Nothing was disabled or refreshed — the click only explained.
    expect(api.disableAgent.mock.calls.length).toBe(0);
    expect(api.refreshDashboardData.mock.calls.length).toBe(0);
  });

  it('runs the immediate Enable path when the agent is disabled', async () => {
    directory.agents = [{ id: 'agent-1', name: 'Nora', enabled: false }];
    render(<ProfileActionsRail />);

    fireEvent.click(railButton(/^Enable$/));
    await waitFor(() => {
      expect(api.enableAgent.mock.calls).toEqual([['agent-1']]);
      expect(api.refreshDashboardData.mock.calls.length).toBe(1);
    });
    expect(api.disableAgent.mock.calls.length).toBe(0);
    // Disabled agent: Restart plate present (no provider issue) but inert.
    expect(railButton(/Restart agent/).disabled).toBe(true);
  });
});

describe('ActionsRail (presentational gating matrix)', () => {
  afterEach(cleanup);

  const baseProps = {
    enabled: true,
    toggling: false,
    copyingDiagnostics: false,
    diagnosticsCopied: false,
    showRestart: true,
    onToggleEnabled: () => {},
    onRotateSession: () => {},
    onRestart: () => {},
    onCopyDiagnostics: () => {},
    onRemove: () => {},
  };

  it('leaves Disable live when idle and Restart live when enabled', () => {
    render(<ActionsRail {...baseProps} />);
    expect(railButton(/^Disable$/).disabled).toBe(false);
    expect(railButton(/Restart agent/).disabled).toBe(false);
  });

  it('suppresses the Restart plate entirely under provider-health suppression', () => {
    render(<ActionsRail {...baseProps} showRestart={false} />);
    expect(screen.queryByRole('button', { name: /Restart agent/ })).toBeNull();
    // The rest of the rail is intact.
    expect(railButton(/Rotate session/)).toBeTruthy();
    expect(railButton(/Remove agent/)).toBeTruthy();
  });
});
