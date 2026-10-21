import { useEffect, useState } from 'react';

// KaTeX (the rehype plugin, the katex engine and its stylesheet) is about a
// third of the KB viewer chunk, and most files have no math, so it loads the
// first time a file needs it.
//
// Math is only `$$…$$` (inline or display) or a ```math / ~~~math fence:
// single-dollar math is off, because "$5 today and $10 tomorrow" is far more
// common in these notes than `$x$`. So a source check decides. A false
// positive (`$$` inside a code block) only loads KaTeX early.
const MATH_SYNTAX = /\$\$|^ {0,3}(?:`{3,}|~{3,})[ \t]*math\b/m;

export function hasMathSyntax(source: string): boolean {
  return MATH_SYNTAX.test(source);
}

type RehypeKatex = (typeof import('rehype-katex'))['default'];

let loaded: RehypeKatex | null = null;
let loading: Promise<RehypeKatex> | null = null;

function loadKatex(): Promise<RehypeKatex> {
  loading ??= Promise.all([import('rehype-katex'), import('katex/dist/katex.min.css')]).then(
    ([mod]) => (loaded = mod.default),
    (error: unknown) => {
      // A failed chunk load (e.g. a deploy replaced it) may succeed next time.
      loading = null;
      throw error;
    },
  );
  return loading;
}

export type MathRendering =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'ready'; plugin: RehypeKatex }
  | { state: 'failed' };

/**
 * How to render `source`'s math. While KaTeX is loading the caller holds the
 * body back, so a math document renders once, already typeset: no raw-TeX
 * flash, and no reflow under a deep-link scroll. If KaTeX cannot load, the
 * body renders without it (the LaTeX stays visible as code).
 */
export function useMathRendering(source: string): MathRendering {
  const needed = hasMathSyntax(source);
  // Both setters take the plugin through a function: it is a function itself,
  // and a bare one would be called as an initializer / updater.
  const [plugin, setPlugin] = useState<RehypeKatex | null>(() => loaded);
  const [failedFor, setFailedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!needed || plugin) return;
    let live = true;
    loadKatex().then(
      (next) => {
        if (live) setPlugin(() => next);
      },
      () => {
        if (live) setFailedFor(source);
      },
    );
    return () => {
      live = false;
    };
  }, [needed, plugin, source]);

  if (!needed) return { state: 'none' };
  if (plugin) return { state: 'ready', plugin };
  if (failedFor === source) return { state: 'failed' };
  return { state: 'loading' };
}
