import test from 'node:test';
import assert from 'node:assert/strict';
import { linearSessionDisplayText } from '../linear/prompt-context.js';

test('people read a delegation as the issue itself, without Linear\'s markup or boilerplate', () => {
  const context = '<issue identifier="SYN-20">\n<title>Count the flaky test</title>\n<description>\nWhy it matters.\n\n* Count failures in `main`.\n* List each run.\n</description>\n<team name="Synthetic"/>\n</issue>\n\n<user-request>\nWork on SYN-20\n</user-request>';
  assert.equal(linearSessionDisplayText(context),
    '**SYN-20 · Count the flaky test**\n\nWhy it matters.\n\n* Count failures in `main`.\n* List each run.');
});

test('every documented part people need is shown: labels, parent, project, threads with authors and mentions', () => {
  const context = [
    '<issue identifier="SYN-12">',
    '<title>Fix login</title>',
    '<description>Users are logged out.</description>',
    '<team name="Engineering"/>',
    '<label>Bug</label>',
    '<label>Auth</label>',
    '<parent-issue identifier="SYN-10">',
    '<title>Session work</title>',
    '<description>Parent context.</description>',
    '</parent-issue>',
    '<project name="Q4 &quot;Auth&quot;">Make sign-in reliable.</project>',
    '</issue>',
    '',
    '<primary-directive-thread comment-id="c1">',
    '<comment author="Ada" created-at="2026-11-04T00:14:27.337Z">',
    '<user id="u1">scout</user> can you take this?',
    '</comment>',
    '</primary-directive-thread>',
    '',
    '<other-thread comment-id="c2">',
    '<comment author="Ben" created-at="not a time">Seen on mobile too.</comment>',
    '<comment author="Ada">Thanks.</comment>',
    '</other-thread>',
    '',
    '<guidance>',
    '<guidance-rule origin="team" team-name="Engineering">Open a PR per change.</guidance-rule>',
    '</guidance>',
  ].join('\n');
  assert.equal(linearSessionDisplayText(context), [
    '**SYN-12 · Fix login**',
    'Labels: Bug, Auth',
    'Users are logged out.',
    'Parent issue SYN-10: Session work\nParent context.',
    'Project: Q4 "Auth"\nMake sign-in reliable.',
    'Thread:\nAda (2026-11-04T00:14Z): @scout can you take this?',
    'Another thread on the issue:\nBen (not a time): Seen on mobile too.\n\nAda: Thanks.',
  ].join('\n\n'), 'Guidance instructs the agent and is left out');
});

test('a request other than the plain delegation is kept', () => {
  assert.equal(linearSessionDisplayText('<issue identifier="SYN-1"><title>T</title></issue><user-request>Only check <user id="u">scout</user>\'s part</user-request>'),
    '**SYN-1 · T**\n\nRequest: Only check @scout\'s part');
});

test('anything outside the documented shape shows Linear\'s context exactly', () => {
  for (const context of [
    'Plain text from an older Linear',
    '<issue identifier="SYN-1"><title>T</title></issue> trailing text',
    '<issue identifier="SYN-1"><title>T</title><estimate>3</estimate></issue>',
    '<issue identifier="SYN-1"><title>T</title><description>Quote: </description> ends early</description></issue>',
    '<issue identifier="SYN-1"><title>T</title>',
    '<new-block>Something Linear adds later</new-block>',
    '<issue identifier="SYN-1"><title>T</title></issue><other-thread><note>x</note></other-thread>',
    '<issue identifier="SYN-1"><title>T</title></issue><guidance><rule>x</rule></guidance>',
    '   ',
  ]) assert.equal(linearSessionDisplayText(context), context, context);
});
