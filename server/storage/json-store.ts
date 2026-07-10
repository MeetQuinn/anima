import { JsonFile } from './json-file.js';

export interface JsonStoreOptions<T> {
  empty: () => T;
  parse: (value: unknown) => T;
  path: () => string;
  /**
   * The write root the paths of this store belong to.
   *
   * Must come from the same authority as `path()`. A store told its home
   * explicitly - `new AgentHealthStore({ animaHome })` - derives `path()` from
   * that home, so its write root is that home, not whatever `resolveAnimaHome()`
   * reports at write time. Take the two from different authorities and the guard
   * protects a root the target does not live under: the target then reads as
   * "outside the root" and is recursively recreated, which is the whole defect.
   *
   * Defaults to the ambient root, captured once per path in `file()`.
   */
  writeRoot?: () => string;
}

export class JsonStore<T> {
  // Memoize validation by raw-input identity. JsonFile returns the same cached
  // object reference for an unchanged file, so a hot poll loop reads the same
  // reference repeatedly; without this it would re-run the full schema parse on
  // every read. A WeakMap keyed by the raw value lets a write (new reference)
  // fall through to a fresh parse.
  private readonly validated = new WeakMap<object, T>();

  // One JsonFile per path, for the life of this store.
  //
  // Not a performance memo. A JsonFile captures its write root when it is
  // constructed, so constructing a fresh one per operation - which this class
  // used to do - re-derived the root on every read/write/update and threw the
  // capture away. `resolveAnimaHome()` names a different directory once the
  // current one is deleted, so the second write after a teardown protected the
  // wrong root and recursively rebuilt the home. Capturing here, at the
  // long-lived store, is what makes the root outlive the directory it names.
  //
  // Keyed by path, not stored as a single field, because `path()` is a thunk:
  // under `withAnimaHome()` one module-global store legitimately serves several
  // homes, and each path carries its own root. The map is bounded by the number
  // of distinct paths a store ever sees (one, for the per-agent stores).
  private readonly files = new Map<string, JsonFile<T>>();

  constructor(private readonly options: JsonStoreOptions<T>) {}

  async read(): Promise<T> {
    const path = this.options.path();
    return this.parse(await this.file(path).read(), path);
  }

  async write(value: T): Promise<void> {
    const path = this.options.path();
    await this.file(path).write(this.parse(value, path));
  }

  async update(op: (current: T) => T | Promise<T>): Promise<T> {
    const path = this.options.path();
    return this.file(path).update(async (raw) => {
      const current = this.parse(raw, path);
      return this.parse(await op(current), path);
    });
  }

  private file(path: string): JsonFile<T> {
    const existing = this.files.get(path);
    if (existing) return existing;
    // `writeRoot` undefined -> JsonFile falls back to the ambient root, captured
    // now, at first use of this path, and held from here on.
    const created = new JsonFile<T>(path, this.options.empty, this.options.writeRoot?.());
    this.files.set(path, created);
    return created;
  }

  private parse(value: unknown, path: string): T {
    const memoKey = typeof value === 'object' && value !== null ? (value as object) : undefined;
    if (memoKey) {
      const cached = this.validated.get(memoKey);
      if (cached !== undefined) return cached;
    }
    try {
      const result = this.options.parse(value);
      if (memoKey) this.validated.set(memoKey, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${path}: ${message}`);
    }
  }
}
