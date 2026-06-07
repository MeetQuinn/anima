import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPromptTemplate } from '../runtime/prompt-template.js';

test('renderPromptTemplate supports variables, sections, and inverted sections', () => {
  const rendered = renderPromptTemplate(
    [
      'Hello {{name}}.',
      '{{#slack}}Slack enabled.{{/slack}}',
      '{{^feishu}}Feishu disabled.{{/feishu}}',
    ].join('\n'),
    {
      feishu: false,
      name: 'Milo',
      slack: true,
    },
  );

  assert.match(rendered, /Hello Milo/);
  assert.match(rendered, /Slack enabled/);
  assert.match(rendered, /Feishu disabled/);
});

test('renderPromptTemplate fails when a template value is missing', () => {
  assert.throws(
    () =>
      renderPromptTemplate('Hello {{name}} from {{transport}}.', {
        name: 'Milo',
      }),
    /Missing prompt template value\(s\): transport/,
  );
});

test('renderPromptTemplate rejects unsupported template features', () => {
  assert.throws(
    () => renderPromptTemplate('Hello {{> partial}}.', { partial: 'x' }),
    /Unsupported prompt template token\(s\): >/,
  );
});
