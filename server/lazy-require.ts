import { createRequire } from 'node:module';

const requireModule = createRequire(import.meta.url);

/**
 * A CommonJS package loaded on its first use instead of at import time. Every
 * `anima` command imports every command module, so a large SDK imported at
 * the top of a shared module costs each call its load time, even a call that
 * never uses it. Node keeps one module cache for `require` and `import`, so
 * this is the same module object an import would give.
 */
export function lazyRequire<T>(specifier: string): () => T {
  let loaded: T | undefined;
  return () => {
    loaded ??= requireModule(specifier) as T;
    return loaded;
  };
}
