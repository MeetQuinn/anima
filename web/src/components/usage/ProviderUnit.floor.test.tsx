import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ProviderCliRow } from '@shared/provider-cli';
import type { ProviderRuntimeCommandRow } from '@shared/provider-runtime-commands';
import { ProviderUnit } from './ProviderUnit';

// ProviderUnit is mounted alone: its parent (UsagePanel) fetches on mount and
// must never be rendered in a test that only needs a class string.
const management: ProviderCliRow = {
  agents: [],
  installSource: 'claude-native',
  installedVersion: '2.1.214',
  label: 'Claude Code',
  operation: { status: 'idle' },
  provider: 'claude-code',
  state: 'current',
  updateAvailable: false,
  updateMode: 'managed',
};
const runtimeCommand: ProviderRuntimeCommandRow = {
  args: [],
  command: null,
  defaultCommand: 'claude',
  provider: 'claude-code',
};

describe('ProviderUnit runtime command Save', () => {
  it('carries the 44px mobile floor and keeps the 36px desktop height', () => {
    render(
      <ProviderUnit
        expanded
        management={management}
        now={new Date('2026-09-11T07:00:00Z')}
        onApply={() => {}}
        onCopyCommand={() => {}}
        onToggleExpanded={() => {}}
        usages={[]}
        onContextLimitChange={() => {}}
        runtimeCommand={runtimeCommand}
        onRuntimeCommandSave={() => {}}
      />,
    );
    const save = screen.getByRole('button', { name: 'Save' });
    // Pair, not a bare bump: #680/#683 house rule (see ProviderSignIn, PR #705).
    expect(save.classList.contains('min-h-[44px]')).toBe(true);
    expect(save.classList.contains('md:min-h-[36px]')).toBe(true);
  });
});
