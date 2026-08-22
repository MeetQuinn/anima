import { describe, expect, it } from 'vitest';

import {
  extractToc,
  lineFromHash,
  parseHeadingLabel,
  resolveHeadingId,
  stripExplicitHeadingIds,
  uniqueHeadingId,
} from './markdown-toc';

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

  it('parses and strips pandoc-style explicit heading ids', () => {
    expect(parseHeadingLabel('Title {#custom-id}')).toEqual({
      text: 'Title',
      explicitId: 'custom-id',
    });
    expect(parseHeadingLabel('00:04:39 · Foo {#000439}')).toEqual({
      text: '00:04:39 · Foo',
      explicitId: '000439',
    });
    expect(parseHeadingLabel('No marker')).toEqual({
      text: 'No marker',
      explicitId: null,
    });
  });

  it('uses explicit {#id} as the TOC anchor and strips it from render text', () => {
    const src = [
      '## 00:04:39 · Intro {#000439}',
      'body',
      '## Next',
    ].join('\n');
    expect(extractToc(src)).toEqual([
      { depth: 2, text: '00:04:39 · Intro', id: '000439', line: 1 },
      { depth: 2, text: 'Next', id: 'next', line: 3 },
    ]);
    expect(stripExplicitHeadingIds(src)).toBe(
      ['## 00:04:39 · Intro', 'body', '## Next'].join('\n'),
    );
  });

  it('leaves non-marker # lines byte-identical, including inside fences', () => {
    const src = [
      '## Real {#keep}',
      '```bash',
      '# cleanup ##',
      '# step {#v1.2}',
      '```',
      '## Plain trailing ##',
    ].join('\n');
    expect(stripExplicitHeadingIds(src)).toBe(
      [
        '## Real',
        '```bash',
        '# cleanup ##',
        '# step {#v1.2}',
        '```',
        '## Plain trailing ##',
      ].join('\n'),
    );
  });

  it('resolves short TOC hashes to a unique slug prefix', () => {
    const ids = [
      '000439-a-a',
      '001452--8h',
      'transcript',
    ];
    expect(resolveHeadingId('000439', ids)).toBe('000439-a-a');
    expect(resolveHeadingId('000439-a-a', ids)).toBe('000439-a-a');
    expect(resolveHeadingId('missing', ids)).toBeNull();
    // Ambiguous prefix must not guess.
    expect(resolveHeadingId('00', ['001452-a', '001752-b'])).toBeNull();
  });

  it('matches walden livestream TOC short anchors to slugified headings', () => {
    const toc = extractToc([
      '# Transcript',
      '## 目录',
      '## 00:04:39 · 三日线巨量 / 别阴谋论 A 上 A 下',
      '## 00:14:52 · 减仓纪律 · 日线抛压 / ≥8h 供应',
    ].join('\n'));
    const ids = toc.map((e) => e.id);
    expect(resolveHeadingId('000439', ids)).toBe(toc[2].id);
    expect(resolveHeadingId('001452', ids)).toBe(toc[3].id);
    expect(toc[2].id.startsWith('000439-')).toBe(true);
  });
});
