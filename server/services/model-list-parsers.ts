// Parsers for the model lists CLIs print. They run in the model-list probe process
// (model-list-probe.ts), never in the server: some of this output carries
// credentials, and only the catalog a parser returns goes back to the server.

export interface ProviderModelCatalog {
  defaultModel: string;
  modelReasoningEfforts?: Record<string, string[]>;
  models: string[];
}

export interface ModelListParser {
  /** Names the CLI's list in errors, which never carry its output. */
  label: string;
  parse(output: string): ProviderModelCatalog;
}

export const MODEL_LIST_PARSERS = {
  kimi: { label: 'Kimi Code model list', parse: parseKimiProviderList },
  opencode: { label: 'OpenCode model list', parse: parseOpenCodeModelsOutput },
} satisfies Record<string, ModelListParser>;

export type ModelListParserName = keyof typeof MODEL_LIST_PARSERS;

export function isModelListParserName(value: string | undefined): value is ModelListParserName {
  return value !== undefined && Object.hasOwn(MODEL_LIST_PARSERS, value);
}

/**
 * `opencode models --verbose` → catalog. Each model is its `provider/id` on a line of its
 * own, then its JSON. A model's `variants` are its effort menu (the values the
 * runtime's `effort` option takes), and a model without any has no effort control; a
 * model whose JSON does not parse keeps its built-in menu. Deprecated models stay out.
 * Only ids, status and variant names are read: the JSON also carries provider headers
 * and options.
 */
export function parseOpenCodeModelsOutput(output: string): ProviderModelCatalog {
  const blocks: { body: string[]; model: string }[] = [];
  for (const line of output.split(/\r?\n/)) {
    // An id is printable: no control characters, quotes or backslashes.
    if (/^[^\s{}"\\\x00-\x1f\x7f]+\/[^\s"\\\x00-\x1f\x7f]+$/.test(line)) blocks.push({ body: [], model: line });
    else blocks.at(-1)?.body.push(line);
  }
  const models: string[] = [];
  const seen = new Set<string>();
  const menus: [string, string[]][] = [];
  for (const { body, model } of blocks) {
    if (seen.has(model)) continue;
    let info: unknown;
    try {
      info = JSON.parse(body.join('\n'));
    } catch {
      info = undefined;
    }
    if (isPlainRecord(info) && info['status'] === 'deprecated') continue;
    seen.add(model);
    models.push(model);
    if (!isPlainRecord(info)) continue;
    const variants = info['variants'];
    menus.push([model, isPlainRecord(variants) ? Object.keys(variants).filter((name) => name.trim() !== '') : []]);
  }
  if (models.length === 0) throw new Error('OpenCode did not report any models');
  // `fromEntries` keeps an id like `__proto__` an own key.
  return { defaultModel: models[0]!, modelReasoningEfforts: Object.fromEntries(menus), models };
}

/**
 * `kimi provider list --json` → catalog. Only `models` is read: `providers` holds
 * credentials. Each key is an alias `session/set_model` takes; `supportEfforts` is the
 * effort menu (the values of the runtime's `thinking` option), and a model without it
 * has no effort control.
 */
export function parseKimiProviderList(output: string): ProviderModelCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('Kimi Code provider list was not JSON');
  }
  const entries = isPlainRecord(parsed) && isPlainRecord(parsed['models']) ? parsed['models'] : {};
  const models: string[] = [];
  const seen = new Set<string>();
  const menus: [string, string[]][] = [];
  for (const [alias, info] of Object.entries(entries)) {
    const model = alias.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
    const efforts = isPlainRecord(info) && Array.isArray(info['supportEfforts']) ? info['supportEfforts'] : [];
    menus.push([
      model,
      [
        ...new Set(
          efforts
            .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
            .map((value) => value.trim()),
        ),
      ],
    ]);
  }
  if (models.length === 0) throw new Error('Kimi Code did not report any models');
  return { defaultModel: models[0]!, modelReasoningEfforts: Object.fromEntries(menus), models };
}

/** One model in a probe's reply: its id, then its effort menu when it has an entry. */
type ModelListReplyEntry = [string] | [string, string[]];

/**
 * A catalog in the form the probe process sends it: each model once, with its menu.
 * Each id costs a few bytes more than it did in the CLI's output, which bounds the
 * reply the server accepts (see modelListProbe).
 */
export function modelListReply(catalog: ProviderModelCatalog): { defaultModel: string; models: ModelListReplyEntry[] } {
  const menus = catalog.modelReasoningEfforts ?? {};
  return {
    defaultModel: catalog.defaultModel,
    models: catalog.models.map((model): ModelListReplyEntry => (Object.hasOwn(menus, model) ? [model, menus[model]!] : [model])),
  };
}

/**
 * A probe's reply as the server takes it: string ids, and their string effort
 * menus. Anything else in the value is dropped.
 */
export function modelListCatalog(value: unknown): ProviderModelCatalog | undefined {
  if (!isPlainRecord(value) || !Array.isArray(value['models'])) return undefined;
  const models: string[] = [];
  const seen = new Set<string>();
  const menus: [string, string[]][] = [];
  for (const entry of value['models']) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || entry[0].trim() === '' || seen.has(entry[0])) continue;
    const model = entry[0];
    seen.add(model);
    models.push(model);
    if (Array.isArray(entry[1])) {
      menus.push([model, entry[1].filter((effort): effort is string => typeof effort === 'string' && effort.trim() !== '')]);
    }
  }
  if (models.length === 0) return undefined;
  const defaultModel = typeof value['defaultModel'] === 'string' && seen.has(value['defaultModel'])
    ? value['defaultModel']
    : models[0]!;
  return { defaultModel, modelReasoningEfforts: Object.fromEntries(menus), models };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
