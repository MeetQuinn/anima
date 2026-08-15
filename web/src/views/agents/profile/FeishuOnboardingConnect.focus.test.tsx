import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { queryKeys } from '@/lib/query-keys';
import { RecommendedPermissionsState } from './FeishuOnboardingConnect';
import type { AgentFeishuScopeStatus } from '@shared/agent-config';

// Focus and semantics contract for the Feishu onboarding skip warning, which
// adopts `useDialogFocus` in batch B-flat of the residual `aria-modal` work.
//
// It had NO focus lifecycle at all before: opening it left focus on the "Skip
// for now" link behind the overlay, so the first Tab walked the onboarding form
// underneath a dialog that says "this turns features off", and closing it left
// focus wherever it had wandered. Every case here fails against the pre-change
// file. Where a single case mixes an instrument with a regression guard, the
// case says which assertion is which — a guard that gets described as evidence
// is how a green tick starts meaning nothing.
//
// Runs in CI (`pnpm --dir web test`) and locally the same way.

const scopeStatus = vi.hoisted(() => vi.fn());
vi.mock('@/api/agents', () => ({
  connectAgentFeishu: vi.fn(),
  fetchAgentFeishuScopeStatus: scopeStatus,
  refreshDashboardData: vi.fn(),
  startAgentFeishuAppRegistration: vi.fn(),
}));

const TITLE = 'Skipping leaves some teammate and document features off';

/** Preview mode disables the query; use it for the plain focus cases. */
function renderPreview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecommendedPermissionsState agentId="nora" onContinue={() => {}} preview />
    </QueryClientProvider>,
  );
}

function scopeState(state: 'granted' | 'missing'): AgentFeishuScopeStatus {
  return {
    appId: 'cli_test',
    connected: true,
    profileName: { granted: state === 'granted', scope: 'contact:user.basic_profile:readonly', state },
    recommended: {
      granted: state === 'granted',
      missingScopes: [],
      scopes: [],
      state,
    },
  } as AgentFeishuScopeStatus;
}

/**
 * Live-query mode, so the step can resolve underneath the open dialog. Returns
 * the client so a case can flip the cached scope state the way a background
 * refetch would.
 */
function renderLive() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  scopeStatus.mockResolvedValue(scopeState('missing'));
  client.setQueryData(queryKeys.agentFeishuScopes('nora'), scopeState('missing'));
  const view = render(
    <QueryClientProvider client={client}>
      <RecommendedPermissionsState agentId="nora" onContinue={() => {}} />
    </QueryClientProvider>,
  );
  return { client, view };
}

function setScopes(client: QueryClient, state: 'granted' | 'missing') {
  scopeStatus.mockResolvedValue(scopeState(state));
  act(() => {
    client.setQueryData(queryKeys.agentFeishuScopes('nora'), scopeState(state));
  });
}

describe('Feishu onboarding skip warning — focus contract', () => {
  it('lands focus on the control that keeps the user in the flow', () => {
    // Not "Skip anyway": the safe control is the one that changes nothing.
    renderPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep setting up' }));
  });

  it('exposes its title as the accessible name and its warning as the description', () => {
    // The dialog has to be findable BY NAME, not as "the anonymous dialog".
    // Both ids are resolved through the DOM rather than compared as strings: an
    // `aria-labelledby` pointing at nothing passes a string check and reads as
    // nothing to a screen reader.
    renderPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));

    const dialog = screen.getByRole('dialog', { name: TITLE });
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!);
    expect(description?.textContent).toContain('Feishu Drive and cloud documents');
  });

  it('keeps Tab inside the warning instead of the form underneath', () => {
    renderPreview();
    const opener = screen.getByRole('button', { name: 'Skip for now' });
    fireEvent.click(opener);

    const keep = screen.getByRole('button', { name: 'Keep setting up' });
    const skip = screen.getByRole('button', { name: 'Skip anyway' });

    // Keep is the last control, so a forward Tab wraps to the first one inside
    // the dialog rather than reaching the onboarding form behind it.
    const forward = fireEvent.keyDown(keep, { key: 'Tab' });
    expect(forward).toBe(false);
    expect(document.activeElement).toBe(skip);
    expect(document.activeElement).not.toBe(opener);

    const backward = fireEvent.keyDown(skip, { key: 'Tab', shiftKey: true });
    expect(backward).toBe(false);
    expect(document.activeElement).toBe(keep);
  });

  it('returns focus to the link that opened it', () => {
    renderPreview();
    const opener = screen.getByRole('button', { name: 'Skip for now' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).not.toBe(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Keep setting up' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes with the step and comes back focused, instead of leaking its layer', async () => {
    // Milo's red on 6a64fc9d. The permissions step returns early once the scopes
    // read `granted`, and that return does not clear `skipModal` — so a
    // background refetch removed the dialog while the hook stayed registered
    // with `open === true`: a layer in the shared focus stack with no node under
    // it. The warning is now its own mounted component, so the registration
    // cannot outlive the node — unmounting IS the close.
    //
    // Which half of this case measures what, because they are not the same:
    //
    //   - The granted assertions are a REGRESSION GUARD, not evidence. They hold
    //     against the leaking head too. Restoring focus to the opener is not on
    //     the table here and asserting it would be asserting a wish: the same
    //     commit that removes the dialog replaces the whole step, so "Skip for
    //     now" is gone as well. What must hold is that focus is not stranded
    //     inside a detached subtree.
    //   - The coming-back assertion is the INSTRUMENT. `skipModal` survives the
    //     round trip, so the warning reappears when the step does. While the
    //     hook stayed registered across the gap its effect never re-ran, so the
    //     dialog came back with focus still on `document.body` — a modal nobody's
    //     keyboard was in. Remounting re-runs it.
    //
    // Measured, not assumed: the other consequence a leaked layer might have —
    // a later dialog failing to trap Tab — does not reproduce. A `ConfirmDelete`
    // opened after the leak focuses, traps and restores identically on both
    // heads, because the stale entry holds a null root and its listener returns.
    const { client } = renderLive();
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep setting up' }));

    setScopes(client, 'granted');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    expect(document.activeElement).toBe(document.body);

    setScopes(client, 'missing');

    // Deliberately no accessible-name query here: this half measures the focus
    // registration and nothing else, so it stays red for exactly one reason.
    const keep = await screen.findByRole('button', { name: 'Keep setting up' });
    expect(document.activeElement).toBe(keep);
  });
});
