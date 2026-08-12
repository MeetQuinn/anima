import { describe, expect, it } from 'vitest';

import { formatTokens } from './format';

describe('formatTokens', () => {
  it('prints counts below a thousand in full', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(999)).toBe('999');
  });

  it('keeps one decimal below a mantissa of 100 and drops it above', () => {
    expect(formatTokens(2_400)).toBe('2.4K');
    expect(formatTokens(87_600)).toBe('87.6K');
    expect(formatTokens(99_949)).toBe('99.9K');
    // 100 and up is the switch to whole units, not a rounding accident.
    expect(formatTokens(99_950)).toBe('100K');
    expect(formatTokens(123_400)).toBe('123K');
  });

  it('strips a trailing .0 rather than printing it', () => {
    expect(formatTokens(1_000)).toBe('1K');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(2_000_000_000)).toBe('2B');
  });

  it('promotes the unit when rounding carries the mantissa to 1000', () => {
    // The regression this pins: 999,500 / 1,000 is 999.5, which prints as a
    // rounded `1000`. "1000K" is a number wearing the unit below the one it
    // belongs to. Both ends of the carrying window are checked, plus the value
    // just under it, so a fix that simply moved the threshold would fail here.
    expect(formatTokens(999_499)).toBe('999K');
    expect(formatTokens(999_500)).toBe('1M');
    expect(formatTokens(999_999)).toBe('1M');
    expect(formatTokens(1_000_000)).toBe('1M');

    // Same carry, one unit up.
    expect(formatTokens(999_499_999)).toBe('999M');
    expect(formatTokens(999_500_000)).toBe('1B');
    expect(formatTokens(999_999_999)).toBe('1B');
  });

  it('scales past a billion instead of running the mantissa up in millions', () => {
    // The formatter this replaced had no billions branch and printed "2450M".
    expect(formatTokens(1_000_000_000)).toBe('1B');
    expect(formatTokens(2_450_000_000)).toBe('2.5B');
    expect(formatTokens(87_600_000_000)).toBe('87.6B');
  });

  it('has no unit above B, so a mantissa that large is printed as-is', () => {
    // Not reachable from real usage data; pinned so the promotion loop's top
    // edge is a stated choice rather than an untested branch.
    expect(formatTokens(999_500_000_000)).toBe('1000B');
  });
});
