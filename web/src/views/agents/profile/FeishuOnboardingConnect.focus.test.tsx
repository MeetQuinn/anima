import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RecommendedPermissionsState } from './FeishuOnboardingConnect';

// Focus contract for the Feishu onboarding skip warning, which adopts
// `useDialogFocus` in batch B-flat of the residual `aria-modal` work.
//
// It had NO focus lifecycle at all before: opening it left focus on the "Skip
// for now" link behind the overlay, so the first Tab walked the onboarding form
// underneath a dialog that says "this turns features off", and closing it left
// focus wherever it had wandered. Every case here is therefore an instrument —
// each one fails against the pre-change file.
//
// Rendered in `preview` mode so the scope query is disabled: this measures the
// dialog's focus lifecycle, not the permissions fetch.
//
// NOTE: web vitest is not wired into CI yet (issue #344) - run locally.

function renderPermissionsStep() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecommendedPermissionsState agentId="nora" onContinue={() => {}} preview />
    </QueryClientProvider>,
  );
}

describe('Feishu onboarding skip warning — focus contract', () => {
  it('lands focus on the control that keeps the user in the flow', () => {
    // Not "Skip anyway": the safe control is the one that changes nothing.
    renderPermissionsStep();
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep setting up' }));
  });

  it('keeps Tab inside the warning instead of the form underneath', () => {
    renderPermissionsStep();
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
    renderPermissionsStep();
    const opener = screen.getByRole('button', { name: 'Skip for now' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).not.toBe(opener);

    fireEvent.click(screen.getByRole('button', { name: 'Keep setting up' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
