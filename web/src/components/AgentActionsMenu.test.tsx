/**
 * Connected regression for the ⋯ overflow menu's Disable wiring (PR #688 gate).
 * Exists because the shared-seam claim was unpinned: Milo's gate mutation
 * rewired the menu's running Disable click from `requestDisable()` back to
 * `toggleEnabled(false)` — the forbidden mid-run disable — and the full suite
 * stayed green. The rail's connected test proves the FIRST call site only;
 * this one pins the second:
 *
 *   - running + Disable click → the "Agent is running" notice (single OK),
 *     zero disableAgent / refreshDashboardData calls;
 *   - idle + Disable click → immediate disableAgent + refresh, no dialog.
 *
 * Real useAgentActions + useConfirm + ConfirmModal; only the API/router/
 * directory seams are mocked, mirroring ActionsRail.test.tsx.
 * Note: this setup registers no jest-dom matchers — use plain DOM assertions.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AgentActionsMenu from './AgentActionsMenu';

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

function openMenuAndClickDisable() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  const disable = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Disable',
  );
  expect(disable).toBeTruthy();
  expect((disable as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(disable!);
}

describe('AgentActionsMenu Disable wiring (connected)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    directory.agents = [{ id: 'agent-1', name: 'Nora' }];
    directory.statuses = [{ agentId: 'agent-1', currentItemId: null }];
  });
  afterEach(cleanup);

  it('shows the running notice instead of disabling, from the menu surface', async () => {
    directory.statuses = [{ agentId: 'agent-1', currentItemId: 'item-9' }];
    render(<AgentActionsMenu />);

    openMenuAndClickDisable();

    const dialog = await screen.findByRole('dialog', { name: 'Agent is running' });
    // Notice, not a decision: exactly one button (OK), no Cancel.
    const buttons = Array.from(dialog.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['OK']);

    fireEvent.click(buttons[0]!);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Agent is running' })).toBeNull();
    });
    // The click only explained — nothing was disabled or refreshed.
    expect(api.disableAgent.mock.calls.length).toBe(0);
    expect(api.refreshDashboardData.mock.calls.length).toBe(0);
  });

  it('disables immediately from the menu when the agent is idle', async () => {
    render(<AgentActionsMenu />);

    openMenuAndClickDisable();

    expect(screen.queryByRole('dialog')).toBeNull(); // immediate, not confirmed
    await waitFor(() => {
      expect(api.disableAgent.mock.calls).toEqual([['agent-1']]);
      expect(api.refreshDashboardData.mock.calls.length).toBe(1);
    });
    expect(api.enableAgent.mock.calls.length).toBe(0);
  });
});
