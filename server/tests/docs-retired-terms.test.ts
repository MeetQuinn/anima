import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const readerFacingFiles = [
  'README.md',
  ...markdownFiles(join(process.cwd(), 'templates'), { recursive: false }),
  ...markdownFiles(join(process.cwd(), 'docs'), { recursive: true }).filter(
    (file) => !relative(process.cwd(), file).split('/').includes('design'),
  ),
].map((file) => relative(process.cwd(), file).split('/').join('/'));

const retiredAliases = [
  'memory-coherence pass',
  'memory tidy',
  'Dream pass',
  // The standing prompt used this spelling before the docs-unification rename.
  'Dream/consolidation pass',
  'Attention suggestion:',
  'Anima system message:',
  'Anima system note:',
];

test('reader-facing docs and templates do not use retired terms', () => {
  const violations: string[] = [];

  for (const file of readerFacingFiles) {
    const text = contentToScan(file, readFileSync(join(process.cwd(), file), 'utf8'));
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const searchable = stripInlineCode(line).toLowerCase();
      for (const alias of retiredAliases) {
        if (searchable.includes(alias.toLowerCase())) violations.push(`${file}:${index + 1}: ${alias}`);
      }
      if (/\bprerelease\b/i.test(searchable)) violations.push(`${file}:${index + 1}: prerelease`);
    }
  }

  assert.deepEqual(violations, [], `Retired reader-facing terms found:\n${violations.join('\n')}`);
});

function contentToScan(file: string, text: string) {
  if (file !== 'docs/concepts.md') return text;
  const retiredTermsHeading = '\n## Retired terms\n';
  const index = text.indexOf(retiredTermsHeading);
  if (index === -1) return text;
  return text.slice(0, index);
}

function markdownFiles(dir: string, opts: { recursive: boolean }): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && opts.recursive) return markdownFiles(path, opts);
    if (entry.isFile() && entry.name.endsWith('.md')) return [path];
    return [];
  });
}

function stripInlineCode(line: string) {
  return line.replace(/`[^`]*`/g, '');
}
