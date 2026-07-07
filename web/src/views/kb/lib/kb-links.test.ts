import { describe, expect, it, vi } from 'vitest';

import { buildKbRawPath } from '@/lib/url-state';
import { resolveKbHref, resolveRawSrc, resolveSrcset, sourceMatchesLight } from './kb-links';

// resolveRawSrc/resolveSrcset now take an injected raw-path builder (so the same
// helpers serve the agent Files surface); the KB builder reproduces the prior
// `/kb/raw/<id>/…` behavior these assertions pin.
const kbRaw = (filePath: string) => buildKbRawPath('kb1', filePath);

describe('KB link resolution', () => {
  it('resolves relative KB hrefs against the current file path', () => {
    expect(resolveKbHref('./install.md', 'docs/guide.md')).toEqual({
      path: 'docs/install.md',
      hash: '',
    });
    expect(resolveKbHref('../index.md#top', 'docs/guides/intro.md')).toEqual({
      path: 'docs/index.md',
      hash: '#top',
    });
  });

  it('does not resolve anchors, absolute URLs, or empty hrefs as KB links', () => {
    expect(resolveKbHref('#intro', 'docs/guide.md')).toBeNull();
    expect(resolveKbHref('https://example.com/doc', 'docs/guide.md')).toBeNull();
    expect(resolveKbHref('mailto:a@example.com', 'docs/guide.md')).toBeNull();
    expect(resolveKbHref('', 'docs/guide.md')).toBeNull();
  });

  it('resolves raw asset src values while leaving external, anchor, and root paths untouched', () => {
    expect(resolveRawSrc('../img/a b.png', kbRaw, 'docs/guide.md')).toBe('/kb/raw/kb1/img/a%2520b.png');
    expect(resolveRawSrc('https://example.com/a.png', kbRaw, 'docs/guide.md')).toBe('https://example.com/a.png');
    expect(resolveRawSrc('#icon', kbRaw, 'docs/guide.md')).toBe('#icon');
    expect(resolveRawSrc('/static/a.png', kbRaw, 'docs/guide.md')).toBe('/static/a.png');
  });

  it('resolves every URL candidate in a srcset string or array', () => {
    expect(resolveSrcset('img/a.png 1x, ../b.png 2x', kbRaw, 'docs/guide.md')).toBe(
      '/kb/raw/kb1/docs/img/a.png 1x, /kb/raw/kb1/b.png 2x',
    );
    expect(resolveSrcset(['img/a.png 1x', '../b.png 2x'], kbRaw, 'docs/guide.md')).toBe(
      '/kb/raw/kb1/docs/img/a.png 1x, /kb/raw/kb1/b.png 2x',
    );
    expect(resolveSrcset(undefined, kbRaw, 'docs/guide.md')).toBeUndefined();
  });

  it('matches light media rules and delegates other queries to matchMedia', () => {
    expect(sourceMatchesLight(undefined)).toBe(true);
    expect(sourceMatchesLight('(prefers-color-scheme: dark)')).toBe(false);
    expect(sourceMatchesLight('(prefers-color-scheme: light)')).toBe(true);

    const matchMedia = vi.fn().mockReturnValue({ matches: false });
    vi.stubGlobal('matchMedia', matchMedia);
    expect(sourceMatchesLight('(min-width: 900px)')).toBe(false);
    expect(matchMedia).toHaveBeenCalledWith('(min-width: 900px)');
    vi.unstubAllGlobals();
  });
});
