import Mustache from 'mustache';

export interface PromptTemplateContext {
  [key: string]: boolean | number | string | null | PromptTemplateContext;
}

type MustacheToken = [
  type: string,
  value: string,
  start: number,
  end: number,
  children?: MustacheToken[],
  closeIndex?: number,
];

const ALLOWED_TOKEN_TYPES = new Set(['text', 'name', '&', '#', '^']);

export function renderPromptTemplate(
  template: string,
  context: PromptTemplateContext,
): string {
  const tokens = Mustache.parse(template) as MustacheToken[];
  validateTokens(tokens, context);
  return Mustache.render(
    template,
    context,
    {},
    { escape: (value) => String(value) },
  );
}

function validateTokens(
  tokens: MustacheToken[],
  context: PromptTemplateContext,
): void {
  const missing = new Set<string>();
  const unsupported = new Set<string>();
  for (const token of walkTokens(tokens)) {
    const [type, name] = token;
    if (!ALLOWED_TOKEN_TYPES.has(type)) unsupported.add(type);
    if (type !== 'text' && !hasPath(context, name)) missing.add(name);
  }
  if (unsupported.size) {
    throw new Error(
      `Unsupported prompt template token(s): ${[...unsupported].sort().join(", ")}`,
    );
  }
  if (missing.size) {
    throw new Error(
      `Missing prompt template value(s): ${[...missing].sort().join(", ")}`,
    );
  }
}

function* walkTokens(tokens: MustacheToken[]): Generator<MustacheToken> {
  for (const token of tokens) {
    yield token;
    const children = token[4];
    if (isTokenArray(children)) yield* walkTokens(children);
  }
}

function isTokenArray(value: unknown): value is MustacheToken[] {
  return Array.isArray(value) && value.every(Array.isArray);
}

function hasPath(context: PromptTemplateContext, path: string): boolean {
  if (path === '.') return true;
  let current: unknown = context;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined;
}
