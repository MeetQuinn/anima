import { describe, expect, it } from 'vitest';

import { dedentBlock, parseFrontmatter, parseTopLevelYaml, stripQuotes } from './frontmatter';

describe('frontmatter parsing', () => {
  it('strips matching single and double quotes', () => {
    expect(stripQuotes('"Guide"')).toBe('Guide');
    expect(stripQuotes("'Guide'")).toBe('Guide');
    expect(stripQuotes('"Guide')).toBe('"Guide');
  });

  it('parses scalar, list, and block values', () => {
    expect(parseTopLevelYaml([
      'title: "Guide"',
      'tags:',
      '  - docs',
      '  - "kb"',
      'notes:',
      '  line one',
      '  line two',
    ].join('\n'))).toEqual([
      { key: 'title', value: 'Guide', block: null },
      { key: 'tags', value: null, block: ['  - docs', '  - "kb"'] },
      { key: 'notes', value: null, block: ['  line one', '  line two'] },
    ]);
  });

  it('splits valid frontmatter from the markdown body', () => {
    expect(parseFrontmatter('---\ntitle: Test\n---\n# Body')).toEqual({
      entries: [{ key: 'title', value: 'Test', block: null }],
      body: '# Body',
    });
  });

  it('leaves content untouched when frontmatter is absent or malformed', () => {
    const plain = '# Body\n---\ntitle: no';
    expect(parseFrontmatter(plain)).toEqual({ entries: null, body: plain });

    const malformed = '---\n  nope\n---\n# Body';
    expect(parseFrontmatter(malformed)).toEqual({ entries: null, body: malformed });
  });

  it('dedents block values by their common indentation', () => {
    expect(dedentBlock(['    one', '      two', ''])).toEqual(['one', '  two', '']);
  });
});
