import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderMrkdwn } from './mrkdwn';

// Bare-URL linkification (totoday 08-30): outbound agent text is stored raw —
// it never went through Slack's linkifier, so it carries no <url> entities.
// The dashboard renderer must make bare http(s) URLs clickable itself, without
// disturbing Slack entities, code spans, or surrounding CJK punctuation.

function renderNodes(text: string) {
  return render(<div>{renderMrkdwn(text)}</div>);
}

describe('renderMrkdwn bare URLs', () => {
  it('links a bare URL glued to CJK punctuation, keeping the punctuation as text', () => {
    // The exact shape from nico's DM: full-width colon before, list dash line.
    renderNodes(
      '- infra（secret 定义，**Draft**）：https://github.com/MeetQuinn/lunapark-infra/pull/158\n- lunapark：https://github.com/MeetQuinn/lunapark/pull/8814，checks 全绿',
    );
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/MeetQuinn/lunapark-infra/pull/158',
      'https://github.com/MeetQuinn/lunapark/pull/8814',
    ]);
    // Trailing full-width comma stays outside the link.
    expect(links[1]?.textContent).toBe('https://github.com/MeetQuinn/lunapark/pull/8814');
    // Bold inside the same line still renders.
    expect(screen.getByText('Draft').tagName).toBe('STRONG');
  });

  it('strips sentence punctuation but keeps balanced parentheses in the path', () => {
    renderNodes('see https://en.wikipedia.org/wiki/Foo_(bar), then https://example.com/x.');
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'https://example.com/x',
    ]);
  });

  it('leaves Slack entities and code spans alone', () => {
    renderNodes('<https://example.com/a|Docs> and `https://example.com/code` and <https://example.com/b>');
    const links = screen.getAllByRole('link');
    // Entity links only — the code span URL is not linked.
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(links[0]?.textContent).toBe('Docs');
    expect(screen.getByText('https://example.com/code').tagName).toBe('CODE');
  });

  it('opens in a new tab like entity links', () => {
    renderNodes('https://example.com/only');
    const link = screen.getByRole('link');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });
});
