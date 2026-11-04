import { expect, it } from 'vitest';
import { extraValue } from './format';

it.each([
  ['62500.0000000000', '62,500'],
  ['1234.0500', '1,234.05'],
  ['0.0000100', '0.00001'],
  ['9007199254740993.00002', '9,007,199,254,740,993.00002'],
  ['-1200.00', '-1,200'],
  ['Free', 'Free'],
])('formats balance %s without discarding precision or labels', (balance, expected) => {
  expect(extraValue({ label: 'Credits', balance })).toBe(expected);
});

it('keeps currencies, remaining amounts, unlimited and missing values distinct', () => {
  expect(extraValue({ label: 'Balance', balance: '1020.5000', currency: 'USD' })).toBe('1,020.5 USD');
  expect(extraValue({ label: 'Credits', limit: 5000, used: 1250 })).toBe('3,750');
  expect(extraValue({ label: 'Credits', limit: 5000, currency: 'credits' })).toBe('5,000 credits');
  expect(extraValue({ label: 'Credits', unlimited: true })).toBe('∞');
  expect(extraValue({ label: 'Credits' })).toBe('—');
});
