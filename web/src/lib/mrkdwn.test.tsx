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

// GFM block + inline constructs (totoday 08-30, "fix all"): outbound records
// store the agent's original GFM, which Slack renders but the dashboard
// previously showed as source text.
describe('renderMrkdwn GFM constructs', () => {
  it('renders headings with heavier weight', () => {
    renderNodes('### Release plan\nbody line');
    const heading = screen.getByText('Release plan');
    expect(heading.className).toContain('font-semibold');
    expect(screen.getByText('body line')).toBeTruthy();
  });

  it('renders md links with the shared link style and new-tab attrs', () => {
    renderNodes('see [the PR](https://example.com/pr/7) for details');
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://example.com/pr/7');
    expect(link.textContent).toBe('the PR');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('renders blockquote runs as one quote block', () => {
    const { container } = renderNodes('intro\n> quoted one\n> quoted **two**\nafter');
    const quote = container.querySelector('blockquote');
    // <br> contributes nothing to textContent.
    expect(quote?.textContent).toBe('quoted onequoted two');
    expect(quote?.querySelector('strong')?.textContent).toBe('two');
    expect(container.textContent).toContain('after');
  });

  it('renders strikethrough', () => {
    const { container } = renderNodes('done ~~old plan~~ now');
    expect(container.querySelector('del')?.textContent).toBe('old plan');
  });

  it('renders pipe tables with header and body cells', () => {
    const { container } = renderNodes(
      '| Host | State |\n| --- | --- |\n| mac | **ok** |\n| devbox | pending |',
    );
    const table = container.querySelector('table');
    expect(table).toBeTruthy();
    // Consumers sit in overflow-x-hidden ancestors: a wide table must be
    // reachable by its own scroll wrapper (Nora, #715 render gate).
    expect(table?.parentElement?.className).toContain('overflow-x-auto');
    expect(table?.querySelectorAll('th').length).toBe(2);
    expect(table?.querySelectorAll('td').length).toBe(4);
    expect(table?.querySelector('td strong')?.textContent).toBe('ok');
  });

  it('keeps multi-line fenced code as one block, untouched by other rules', () => {
    const { container } = renderNodes('```\n# not a heading\n| a | b |\nhttps://example.com/raw\n```');
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe('# not a heading\n| a | b |\nhttps://example.com/raw');
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders block-free text exactly as before (lines and <br>)', () => {
    const { container } = renderNodes('one\n\ntwo *bold* three');
    expect(container.querySelectorAll('br').length).toBe(2);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(container.querySelector('blockquote')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
  });
});
