import { quoteIfNeeded } from './slack-target.js';

type OutcomeValue = string | number;
export type OutcomePart = string | [key: string, value: OutcomeValue];

export function outcomeLine(verb: string, parts: OutcomePart[] = [], opts?: { note?: string }): string {
  const renderedParts = parts.map(renderOutcomePart).join(', ');
  const details = renderedParts ? ` ${renderedParts}.` : '';
  const note = opts?.note ? ` Note: ${opts.note}` : '';
  return `${verb} successfully.${details}${note}`;
}

function renderOutcomePart(part: OutcomePart): string {
  if (typeof part === 'string') return part;
  return `${part[0]}=${quoteIfNeeded(String(part[1]))}`;
}
