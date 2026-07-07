export function resolveKbHref(
  href: string,
  currentFilePath: string,
): { path: string; hash: string } | null {
  if (!href || href.startsWith('#')) return null; // in-page anchor
  // Absolute URL (any scheme) → external
  if (/^[a-z][a-z\d+\-.]*:/i.test(href)) return null;
  try {
    // Rooting the base at the current file lets URL handle `..` and `./` correctly.
    const resolved = new URL(href, `http://x/${currentFilePath}`);
    if (resolved.host !== 'x') return null;
    const path = resolved.pathname.slice(1); // strip leading '/'
    return path ? { path, hash: resolved.hash } : null;
  } catch {
    return null;
  }
}

// Minimal hast element shape — enough to read a <picture>'s children without
// pulling the full hast types in.
export type HastElement = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastElement[];
};

/**
 * Resolve a relative asset reference (raw HTML `<img src>` / `<source srcset>`)
 * to the KB raw-bytes endpoint, matching what the Markdown `img` component does.
 * Absolute URLs, anchors, and root-absolute paths are left untouched.
 */
export function resolveRawSrc(
  src: string,
  rawPath: (filePath: string) => string,
  currentFilePath: string,
): string {
  if (!src || /^[a-z][a-z\d+\-.]*:/i.test(src) || src.startsWith('#') || src.startsWith('/')) {
    return src;
  }
  const resolved = resolveKbHref(src, currentFilePath);
  return resolved ? rawPath(resolved.path) : src;
}

/**
 * Decide whether a <picture><source> applies on our always-light content panel.
 * A `prefers-color-scheme: dark` source never matches (the panel is light); a
 * `light` one always does; any other media (e.g. width) is evaluated live.
 */
export function sourceMatchesLight(media: unknown): boolean {
  if (typeof media !== 'string' || media.trim() === '') return true;
  if (/prefers-color-scheme:\s*dark/i.test(media)) return false;
  if (/prefers-color-scheme:\s*light/i.test(media)) return true;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      return window.matchMedia(media).matches;
    } catch {
      return true;
    }
  }
  return true;
}

/** Resolve every candidate URL inside a srcset (hast may store it as an array). */
export function resolveSrcset(
  srcset: unknown,
  rawPath: (filePath: string) => string,
  currentFilePath: string,
): string | undefined {
  const raw = Array.isArray(srcset) ? srcset.join(', ') : typeof srcset === 'string' ? srcset : '';
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((candidate) => {
      const [url, ...descriptor] = candidate.split(/\s+/);
      return [resolveRawSrc(url, rawPath, currentFilePath), ...descriptor].join(' ').trim();
    })
    .join(', ');
}
