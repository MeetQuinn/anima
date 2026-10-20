import { createRequire } from 'node:module';

const requireModule = createRequire(import.meta.url);

/**
 * A CommonJS package loaded on its first use instead of at import time. Every
 * `anima` command imports every command module, so a large SDK imported at
 * the top of a shared module costs each call its load time, even a call that
 * never uses it. Node keeps one CommonJS module cache for `require` and
 * `import`, so the exports are the same functions, classes and values an
 * import binds. Only the namespace object of `import * as` is not returned.
 */
export function lazyRequire<T>(specifier: string): () => T {
  let loaded: T | undefined;
  return () => {
    loaded ??= requireModule(specifier) as T;
    return loaded;
  };
}
