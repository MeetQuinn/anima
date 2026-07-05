import { describe, expect, it } from 'vitest';

import { extractToc, lineFromHash, uniqueHeadingId } from './markdown-toc';

describe('markdown TOC helpers', () => {
  it('extracts heading text, depth, line, and duplicate ids', () => {
    expect(extractToc([
      '# Intro',
      'text',
      '## Install ###',
      '### Install',
      '#### API & Usage',
    ].join('\n'))).toEqual([
      { depth: 1, text: 'Intro', id: 'intro', line: 1 },
      { depth: 2, text: 'Install', id: 'install', line: 3 },
      { depth: 3, text: 'Install', id: 'install-1', line: 4 },
      { depth: 4, text: 'API & Usage', id: 'api-usage', line: 5 },
    ]);
  });

  it('deduplicates unique heading ids with the provided counts map', () => {
    const counts = new Map<string, number>();
    expect(uniqueHeadingId('A!', counts)).toBe('a');
    expect(uniqueHeadingId('A', counts)).toBe('a-1');
    expect(uniqueHeadingId(' ', counts)).toBe('section');
  });

  it('parses source line hashes only when valid', () => {
    expect(lineFromHash('#L1')).toBe(1);
    expect(lineFromHash('#L42')).toBe(42);
    expect(lineFromHash('#L0')).toBeNull();
    expect(lineFromHash('#l1')).toBeNull();
    expect(lineFromHash('#heading')).toBeNull();
    expect(lineFromHash('')).toBeNull();
  });
});
