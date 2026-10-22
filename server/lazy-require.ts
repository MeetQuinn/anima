import { createRequire } from 'node:module';

const requireModule = createRequire(import.meta.url);

/**
 * A package loaded on its first use instead of at import time. Every
 * `anima` command imports every command module, so a large SDK imported at
 * the top of a shared module costs each call its load time, even a call that
 * never uses it. Packages must support synchronous require, including ESM
 * without top-level await on the supported Node versions. The returned value
 * follows require semantics rather than wrapping CommonJS exports in an ESM
 * namespace.
 */
export function lazyRequire<T>(specifier: string): () => T {
  let loaded: T | undefined;
  return () => {
    loaded ??= requireModule(specifier) as T;
    return loaded;
  };
}
