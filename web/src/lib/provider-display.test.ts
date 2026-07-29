import { describe, expect, it } from 'vitest';

import { providerValueLabel } from './provider-display';

describe('providerValueLabel', () => {
  it('renders version-pinned Claude model ids as readable model names', () => {
    expect(providerValueLabel('claude-opus-4-8')).toBe('Claude Opus 4.8');
    expect(providerValueLabel('claude-opus-4-6')).toBe('Claude Opus 4.6');
    expect(providerValueLabel('claude-sonnet-4-6')).toBe('Claude Sonnet 4.6');
  });

  it('renders OpenCode DeepSeek model ids as readable model names', () => {
    expect(providerValueLabel('deepseek/deepseek-v4-pro')).toBe('DeepSeek V4 Pro');
    expect(providerValueLabel('deepseek/deepseek-v4-flash')).toBe('DeepSeek V4 Flash');
  });
});
