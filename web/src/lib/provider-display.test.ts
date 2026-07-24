import { describe, expect, it } from 'vitest';

import { providerValueLabel } from './provider-display';

describe('providerValueLabel', () => {
  it('renders OpenCode DeepSeek model ids as readable model names', () => {
    expect(providerValueLabel('deepseek/deepseek-v4-pro')).toBe('DeepSeek V4 Pro');
    expect(providerValueLabel('deepseek/deepseek-v4-flash')).toBe('DeepSeek V4 Flash');
  });
});
