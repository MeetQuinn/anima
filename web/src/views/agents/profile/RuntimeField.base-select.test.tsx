import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { providerCatalog, type ProviderAvailability } from '@shared/provider-catalog';

import { providerCatalogForAvailability } from '@/lib/provider-availability';
import { RuntimeRow } from './RuntimeField';

// RuntimeField.test.tsx stands plain buttons in for the Select, so it never sees what
// the real Base UI Select does on its own: when the selected value leaves the item
// list, Base UI moves it back to the value the Select opened with (or null) and
// reports that through onValueChange. These cases drive the real Select.
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
});

const providerOptions = providerCatalog();
const sol = 'gpt-6.2-sol';
const astra = 'gpt-6.2-astra';
const terra = 'gpt-6.1-terra';
const solXhigh = { kind: 'codex-cli', model: sol, reasoningEffort: 'xhigh' };

function codexList(models: string[], efforts: Record<string, string[]>): ProviderAvailability[] {
  return [
    {
      checkedAt: '2026-11-24T00:00:00.000Z',
      defaultModel: terra,
      kind: 'codex-cli',
      modelReasoningEfforts: efforts,
      models,
      present: true,
    },
  ];
}

function openRuntime(
  provider: Record<string, unknown>,
  onCommit: (...args: never[]) => Promise<void>,
  availability: ProviderAvailability[] | null = null,
) {
  const row = (next: ProviderAvailability[] | null) => (
    <RuntimeRow
      provider={provider as never}
      providerOptions={providerCatalogForAvailability(providerOptions, next)}
      providerAvailability={next}
      isActive
      onCommit={onCommit as never}
    />
  );
  const { rerender } = render(row(availability));
  fireEvent.click(screen.getByRole('button', { name: /·/ }));
  return {
    dialog: within(screen.getByRole('dialog', { name: 'Runtime' })),
    listArrives: (next: ProviderAvailability[]) => rerender(row(next)),
  };
}

// Opens the Select from the keyboard, presses an option, and waits for the popup to
// finish closing, as an operator's next move would.
async function pick(field: string, option: string) {
  const trigger = screen.getByRole('combobox', { name: field });
  fireEvent.keyDown(trigger, { key: 'ArrowDown', code: 'ArrowDown' });
  const item = await screen.findByRole('option', { name: option });
  fireEvent.pointerDown(item, { pointerType: 'mouse', button: 0 });
  fireEvent.pointerUp(item, { pointerType: 'mouse', button: 0 });
  fireEvent.click(item, { detail: 1 });
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
}

function saveButton(dialog: ReturnType<typeof within>) {
  return dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
}

describe('Runtime modal with the real Select', () => {
  it('a picked model the live list drops stays dropped while the saved model is still listed', async () => {
    const onCommit = vi.fn(async () => {});
    const { dialog, listArrives } = openRuntime(solXhigh, onCommit);
    fireEvent.click(dialog.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Request fast mode' }));
    await pick('Model', 'GPT-6.2 Astra');
    expect(dialog.getByRole('combobox', { name: 'Model' }).textContent).toContain('Astra');

    listArrives(codexList([sol, terra], { [sol]: ['high', 'xhigh'], [terra]: ['high'] }));
    await act(async () => {});
    expect(dialog.getByRole('combobox', { name: 'Model' }).textContent).toContain('Pick a model');
    expect(dialog.getByText(/GPT-6.2 Astra is no longer in the model list/)).toBeTruthy();
    expect(saveButton(dialog).disabled).toBe(true);
    fireEvent.click(saveButton(dialog));
    expect(screen.queryByRole('dialog', { name: 'Save and apply when idle?' })).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();

    await pick('Model', 'GPT-6.1 Terra');
    fireEvent.click(saveButton(dialog));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Save and apply when idle?' })).getByRole('button', { name: 'Save' }),
    );
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith(
      { kind: 'codex-cli', model: terra, reasoningEffort: 'high', fastMode: true },
      expect.anything(),
    );
  });

  it('a picked model dropped while the restart confirm is open sends nothing', async () => {
    const onCommit = vi.fn(async () => {});
    const { dialog, listArrives } = openRuntime(solXhigh, onCommit);
    await pick('Model', 'GPT-6.2 Astra');
    fireEvent.click(saveButton(dialog));
    listArrives(codexList([sol, terra], { [sol]: ['high', 'xhigh'], [terra]: ['high'] }));
    await act(async () => {});
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Save and apply when idle?' })).getByRole('button', { name: 'Save' }),
    );
    await act(async () => {});
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Runtime' })).toBeTruthy();
    expect(dialog.getByRole('combobox', { name: 'Model' }).textContent).toContain('Pick a model');
    expect(saveButton(dialog).disabled).toBe(true);
  });

  it('an untouched saved level the live menu drops is not swapped for a level the effort menu opened with', async () => {
    const onCommit = vi.fn(async () => {});
    // Terra has no levels, so the effort menu closes; Astra opens it again on High.
    const { dialog, listArrives } = openRuntime(
      solXhigh,
      onCommit,
      codexList([sol, astra, terra], { [sol]: ['high', 'xhigh'], [astra]: ['high'], [terra]: [] }),
    );
    await pick('Model', 'GPT-6.1 Terra');
    expect(dialog.queryByRole('combobox', { name: 'Reasoning effort' })).toBeNull();
    await pick('Model', 'GPT-6.2 Astra');
    await pick('Model', 'GPT-6.2 Sol');
    expect(dialog.getByRole('combobox', { name: 'Reasoning effort' }).textContent).toContain('Extra High');

    listArrives(codexList([sol, astra, terra], { [sol]: ['high'], [astra]: ['high'], [terra]: [] }));
    await act(async () => {});
    fireEvent.click(dialog.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Request fast mode' }));
    fireEvent.click(saveButton(dialog));
    const confirm = screen.queryByRole('dialog', { name: 'Save and apply when idle?' });
    if (confirm) fireEvent.click(within(confirm).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith({ fastMode: true }, expect.anything());
  });
});
