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

  it('reads folded and literal block scalars instead of showing the indicator', () => {
    expect(parseTopLevelYaml([
      'owner: Juno',
      'verification: >-',
      '  Checked against the live tree',
      '  on 2026-10-02.',
      'steps: |',
      '  first line',
      '    kept indent',
      '',
      '  after a gap',
      'verified: 2026-10-02',
    ].join('\n'))).toEqual([
      { key: 'owner', value: 'Juno', block: null },
      { key: 'verification', value: 'Checked against the live tree on 2026-10-02.', block: null },
      { key: 'steps', value: 'first line\n  kept indent\n\nafter a gap', block: null },
      { key: 'verified', value: '2026-10-02', block: null },
    ]);
  });

  it('folds blank and more-indented lines the way YAML does', () => {
    expect(parseTopLevelYaml([
      'summary: >',
      '  one',
      '  two',
      '',
      '  three',
      '    code',
      '  four',
    ].join('\n'))).toEqual([
      { key: 'summary', value: 'one two\nthree\n  code\nfour', block: null },
    ]);
  });

  it('accepts chomping, indentation indicators and a trailing comment', () => {
    expect(parseTopLevelYaml([
      'a: |2-',
      '    two extra',
      'b: >+ # keep',
      '  folded',
      'c: |-',
      '',
    ].join('\n'))).toEqual([
      { key: 'a', value: '  two extra', block: null },
      { key: 'b', value: 'folded', block: null },
      { key: 'c', value: '', block: null },
    ]);
  });

  it('folds a plain or quoted scalar that continues on indented lines', () => {
    expect(parseTopLevelYaml([
      'description: Starts here',
      '  and continues',
      'quote: "Opens here',
      '  and closes"',
      'next: done',
    ].join('\n'))).toEqual([
      { key: 'description', value: 'Starts here and continues', block: null },
      { key: 'quote', value: 'Opens here and closes', block: null },
      { key: 'next', value: 'done', block: null },
    ]);
  });

  it('treats indented comment lines as comments, not value text', () => {
    expect(parseTopLevelYaml([
      'owner: Juno',
      '  # metadata note',
      'quote: "Closed"',
      '  # note',
      'open: "Opens',
      '  # kept',
      '  closes"',
      'plain: first',
      '  second',
      '',
      '  # trailing note',
      'verification: |-',
      '    Checked',
      '  # note',
      'steps: |',
      '  # step one',
      '  run it',
      'next: done',
    ].join('\n'))).toEqual([
      { key: 'owner', value: 'Juno', block: null },
      { key: 'quote', value: 'Closed', block: null },
      { key: 'open', value: 'Opens # kept closes', block: null },
      { key: 'plain', value: 'first second', block: null },
      { key: 'verification', value: 'Checked', block: null },
      { key: 'steps', value: '# step one\nrun it', block: null },
      { key: 'next', value: 'done', block: null },
    ]);
  });

  it('ends a quoted value at its closing quote, even on a later line', () => {
    expect(parseTopLevelYaml([
      'double: "Checked',
      '  against live tree"',
      '  # metadata note',
      "single: 'Checked",
      "  against live tree'",
      '  # metadata note',
      'kept: "Opens',
      '  # kept',
      '  closes" # tail',
      '  # dropped',
      'inline: "a" # c',
      "inline2: 'b' # d",
      'next: done',
    ].join('\n'))).toEqual([
      { key: 'double', value: 'Checked against live tree', block: null },
      { key: 'single', value: 'Checked against live tree', block: null },
      { key: 'kept', value: 'Opens # kept closes', block: null },
      { key: 'inline', value: 'a', block: null },
      { key: 'inline2', value: 'b', block: null },
      { key: 'next', value: 'done', block: null },
    ]);
  });

  it('reads `key: # note` above a block as a bare key', () => {
    expect(parseTopLevelYaml([
      'tags: # list',
      '  - a',
      '  - b',
      'color: #fff',
      'next: x',
    ].join('\n'))).toEqual([
      { key: 'tags', value: null, block: ['  - a', '  - b'] },
      // YAML reads this as null; shown as written, as before.
      { key: 'color', value: '#fff', block: null },
      { key: 'next', value: 'x', block: null },
    ]);
  });

  it('keeps spaces past the indent on a blank block line', () => {
    expect(parseTopLevelYaml([
      'three: |2-',
      '  first',
      '   ',
      '  next',
      'four: |-',
      '  first',
      '    ',
      '  next',
      'folded: >-',
      '  first',
      '    ',
      '  next',
      'tail: |-',
      '  first',
      '    ',
      'next: done',
    ].join('\n'))).toEqual([
      { key: 'three', value: 'first\n \nnext', block: null },
      { key: 'four', value: 'first\n  \nnext', block: null },
      { key: 'folded', value: 'first\n  \nnext', block: null },
      { key: 'tail', value: 'first\n  ', block: null },
      { key: 'next', value: 'done', block: null },
    ]);
  });

  it('keeps leading blank lines of a block scalar', () => {
    expect(parseTopLevelYaml([
      'a: |-',
      '',
      '  Checked',
      'b: >-',
      '',
      '  Checked',
      'c: >',
      '',
      '',
      '  one',
      '  two',
    ].join('\n'))).toEqual([
      { key: 'a', value: '\nChecked', block: null },
      { key: 'b', value: '\nChecked', block: null },
      { key: 'c', value: '\n\none two', block: null },
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
