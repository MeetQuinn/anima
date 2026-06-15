import { JsonFile } from './json-file.js';

export interface JsonStoreOptions<T> {
  empty: () => T;
  parse: (value: unknown) => T;
  path: () => string;
}

export class JsonStore<T> {
  // Memoize validation by raw-input identity. JsonFile returns the same cached
  // object reference for an unchanged file, so a hot poll loop reads the same
  // reference repeatedly; without this it would re-run the full schema parse on
  // every read. A WeakMap keyed by the raw value lets a write (new reference)
  // fall through to a fresh parse.
  private readonly validated = new WeakMap<object, T>();

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
    return new JsonFile<T>(path, this.options.empty);
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
