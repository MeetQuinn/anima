import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderInlineCode } from './inline-code';

describe('renderInlineCode', () => {
  afterEach(cleanup);

  it('renders backticked commands inside <code> elements with no literal backticks', () => {
    const { container } = render(
      <p>
        {renderInlineCode(
          'Install OpenCode so `opencode --version` works, then run `opencode auth login`.',
        )}
      </p>,
    );
    const codes = Array.from(container.querySelectorAll('code')).map((node) => node.textContent);
    expect(codes).toEqual(['opencode --version', 'opencode auth login']);
    expect(container.textContent).toBe(
      'Install OpenCode so opencode --version works, then run opencode auth login.',
    );
    expect(container.textContent).not.toContain('`');
  });

  it('returns plain strings unchanged when no backticks are present', () => {
    const { container } = render(<p>{renderInlineCode('Sign in to load available models.')}</p>);
    expect(container.querySelectorAll('code')).toHaveLength(0);
    expect(container.textContent).toBe('Sign in to load available models.');
  });
});
