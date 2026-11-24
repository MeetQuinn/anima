import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderAvailability } from '@shared/provider-catalog';
import { queryKeys } from '@/lib/query-keys';
import { AgentCreateFlow } from './index';

// The create page picks a provider, model and effort before the provider check
// answers, and again when it does (auto-select). Codex's model list and effort
// menus come from that check, so every pick must follow the menus it returns.
const api = vi.hoisted(() => ({ createAgent: vi.fn(), fetchProviderAvailability: vi.fn() }));

vi.mock('@/api/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/agents')>()),
  createAgent: api.createAgent,
}));
vi.mock('@/api/system', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/system')>()),
  fetchProviderAvailability: api.fetchProviderAvailability,
}));

// Plain buttons stand in for the Base UI Select (see RuntimeField.test.tsx).
vi.mock('@/components/ui/select', async () => {
  const React = await import('react');
  const Ctx = React.createContext<{ value?: string; onValueChange?: (value: string) => void }>({});
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: React.ReactNode;
    }) => <Ctx.Provider value={{ value, onValueChange }}>{children}</Ctx.Provider>,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectValue: ({ children }: { children: ((value: string) => React.ReactNode) | React.ReactNode }) => {
      const { value } = React.useContext(Ctx);
      return <span>{typeof children === 'function' ? children(value ?? '') : value}</span>;
    },
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children, disabled }: { value: string; children: React.ReactNode; disabled?: boolean }) => {
      const { onValueChange } = React.useContext(Ctx);
      return (
        <button type="button" disabled={disabled} onClick={() => onValueChange?.(value)}>
          {children}
        </button>
      );
    },
  };
});

function codexOnly(efforts: Record<string, string[]>, models = Object.keys(efforts)): ProviderAvailability[] {
  return [
    {
      checkedAt: '2026-11-24T00:00:00.000Z',
      defaultModel: models[0],
      kind: 'codex-cli',
      modelReasoningEfforts: efforts,
      models,
      present: true,
    },
    { kind: 'claude-code', present: false },
  ];
}

function renderFlow(availability?: ProviderAvailability[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (availability) client.setQueryData(queryKeys.providerAvailability(), availability);
  client.setQueryData(queryKeys.workspacePlatform(), 'slack');
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AgentCreateFlow firstRun={false} onClose={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

async function submittedProvider(): Promise<Record<string, unknown>> {
  fireEvent.change(screen.getByPlaceholderText('e.g. Aria'), { target: { value: 'Demo' } });
  fireEvent.change(screen.getByPlaceholderText('e.g. Full-stack developer'), { target: { value: 'catalog test' } });
  fireEvent.click(screen.getByRole('button', { name: /Create agent/ }));
  await waitFor(() => expect(api.createAgent).toHaveBeenCalledTimes(1));
  return (api.createAgent.mock.calls[0]![0] as { provider: Record<string, unknown> }).provider;
}

describe('create page: effort follows the menu of the model it sends', () => {
  beforeEach(() => {
    api.createAgent.mockReset().mockRejectedValue(new Error('stop after the request'));
    api.fetchProviderAvailability.mockReset();
  });

  it('auto-selecting Codex takes a level its menu offers', async () => {
    renderFlow(codexOnly({ 'gpt-6.1-terra': ['high'] }));
    await waitFor(() => expect(screen.getAllByText('GPT-6.1 Terra').length).toBeGreaterThan(0));
    expect(await submittedProvider()).toEqual({ kind: 'codex-cli', model: 'gpt-6.1-terra', reasoningEffort: 'high' });
  });

  it('auto-selecting a Codex model with no levels sends no effort', async () => {
    renderFlow(codexOnly({ 'gpt-6.1-terra': [] }));
    await waitFor(() => expect(screen.getAllByText('GPT-6.1 Terra').length).toBeGreaterThan(0));
    expect(await submittedProvider()).toEqual({ kind: 'codex-cli', model: 'gpt-6.1-terra' });
  });

  // Two OpenCode providers can give a model the same name, and a third model can be
  // named what one of those shows with its id; every row still shows its own id.
  for (const [model, shown, effort] of [
    ['review-a/chat', 'review-a/chat', 'high'],
    ['review-b/chat', 'Review Chat (review-b/chat)', 'low'],
    ['review-a/extra-chat', 'Review Chat (review-a/chat) (review-a/extra-chat)', 'medium'],
  ]) it(`tells ${model} apart from models named alike, in the menu and on the pick`, async () => {
    renderFlow([
      {
        checkedAt: '2026-11-25T00:00:00.000Z',
        defaultModel: 'review-a/chat',
        kind: 'opencode-cli',
        modelLabels: {
          'review-a/chat': 'Review Chat',
          'review-a/extra-chat': 'Review Chat (review-a/chat)',
          'review-b/chat': 'Review Chat',
        },
        modelReasoningEfforts: { 'review-a/chat': ['high'], 'review-a/extra-chat': ['medium'], 'review-b/chat': ['low'] },
        models: ['review-a/chat', 'review-b/chat', 'review-a/extra-chat'],
        present: true,
      },
      { kind: 'claude-code', present: false },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review Chat (review-b/chat)' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Review Chat' })).toBeNull();
    expect(screen.getAllByRole('button', { name: shown })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: shown }));
    // The selected value shows the pick the same way, and no other row does.
    expect(screen.getAllByText(shown)).toHaveLength(2);
    expect(await submittedProvider()).toEqual({ kind: 'opencode-cli', model, reasoningEffort: effort });
  });

  it('a pick made before the live list arrives moves to the default when the list lacks it', async () => {
    let answer!: (value: ProviderAvailability[]) => void;
    api.fetchProviderAvailability.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'GPT-5.5' }));
    answer(codexOnly({ 'gpt-6.2-astra': ['low', 'high'], 'gpt-6.1-terra': ['high'] }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'GPT-5.5' })).toBeNull());
    expect(await submittedProvider()).toEqual({ kind: 'codex-cli', model: 'gpt-6.2-astra', reasoningEffort: 'low' });
  });
});
