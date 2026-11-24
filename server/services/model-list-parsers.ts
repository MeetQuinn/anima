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
 * `opencode models --verbose` → catalog. For each model OpenCode prints its name,
 * `providerID/id`, then its record as `JSON.stringify(model, null, 2)` writes it: `{`
 * and `}` on lines of their own, everything between indented. A model is a record
 * whose `providerID` and `id` spell the name printed just before it. So an id can hold
 * any character, newlines and a `{` line included, and other output (a wrapper
 * script's notice or JSON log) is no model. Lines may end in CRLF: a terminal (a
 * wrapper that runs OpenCode under `script`, say) prints every newline so, a name's
 * own too. A model's `variants` are its effort menu (the values the runtime's
 * `effort` option takes), and a model without any has no effort control. Deprecated
 * models stay out. Only `providerID`, `id`, status and variant names are read: the
 * record also carries provider headers and options.
 */
export function parseOpenCodeModelsOutput(output: string): ProviderModelCatalog {
  const lines = output.split('\n');
  const bare = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);
  // Where each line starts in the output, and the next `{` and `}` lines at or after it.
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const nextOpen: number[] = [];
  const nextClose: number[] = [];
  for (let index = lines.length - 1, open = -1, close = -1; index >= 0; index -= 1) {
    const line = bare(lines[index]!);
    if (line === '{') open = index;
    if (line === '}') close = index;
    nextOpen[index] = open;
    nextClose[index] = close;
  }
  const models: string[] = [];
  const seen = new Set<string>();
  const menus: [string, string[]][] = [];
  for (let index = 0; index < lines.length; index += 1) {
    // A record starts at a `{` line and ends at the next `}` line; every line between
    // is indented. A `{` line that is not such a start is part of a name, and the
    // record may start at a later one.
    if (bare(lines[index]!) !== '{') continue;
    const end = nextClose[index + 1] ?? -1;
    if (end < 0) break;
    const open = nextOpen[index + 1] ?? -1;
    if (open >= 0 && open < end) continue;
    let info: unknown;
    try {
      info = JSON.parse(lines.slice(index, end + 1).join('\n'));
    } catch {
      continue;
    }
    if (!isPlainRecord(info)) continue;
    const provider = info['providerID'];
    const id = info['id'];
    if (typeof provider !== 'string' || typeof id !== 'string' || !provider.trim() || !id.trim()) continue;
    const model = `${provider}/${id}`;
    const named = [`${model}\n`, `${model.replaceAll('\n', '\r\n')}\r\n`].some((name) => {
      const nameStart = starts[index]! - name.length;
      return nameStart >= 0
        && output.slice(nameStart, starts[index]) === name
        && (nameStart === 0 || output[nameStart - 1] === '\n');
    });
    if (!named) continue;
    index = end;
    if (seen.has(model) || info['status'] === 'deprecated') continue;
    seen.add(model);
    models.push(model);
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
 * A catalog in the form the probe process sends it: each model once, with its menu,
 * and the default as its index in that list. So each id is written once, and as every
 * id and effort name was a JSON string in the CLI's output, in no more bytes than it
 * took there, but for bytes that are not UTF-8: each becomes U+FFFD, three bytes. That
 * bounds the reply the server accepts (see modelListProbe).
 */
export function modelListReply(catalog: ProviderModelCatalog): { defaultModel: number; models: ModelListReplyEntry[] } {
  const menus = catalog.modelReasoningEfforts ?? {};
  return {
    defaultModel: Math.max(0, catalog.models.indexOf(catalog.defaultModel)),
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
  let defaultModel: string | undefined;
  for (const [index, entry] of value['models'].entries()) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || entry[0].trim() === '' || seen.has(entry[0])) continue;
    const model = entry[0];
    seen.add(model);
    models.push(model);
    if (index === value['defaultModel']) defaultModel = model;
    if (Array.isArray(entry[1])) {
      menus.push([model, entry[1].filter((effort): effort is string => typeof effort === 'string' && effort.trim() !== '')]);
    }
  }
  if (models.length === 0) return undefined;
  return { defaultModel: defaultModel ?? models[0]!, modelReasoningEfforts: Object.fromEntries(menus), models };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
