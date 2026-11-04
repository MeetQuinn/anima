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
    // One of each element that is not a list: a second would overwrite or drop the first.
    '<issue identifier="SYN-1"><title>T</title><description>Before </description><description> After</description></issue>',
    '<issue identifier="SYN-1"><title>T</title><title>U</title></issue>',
    '<issue identifier="SYN-1"><title>T</title><parent-issue identifier="SYN-0"><description>A</description><description>B</description></parent-issue></issue>',
    '<issue identifier="SYN-1"><title>T</title></issue><issue identifier="SYN-2"><title>U</title></issue>',
    '<issue identifier="SYN-1"><title>T</title></issue><user-request>A</user-request><user-request>B</user-request>',
    // The team is left out only while it is the documented empty element.
    '<issue identifier="SYN-1"><title>T</title><team name="Engineering">New context</team></issue>',
    // Undocumented or repeated attributes.
    '<issue identifier="SYN-1" state="Blocked"><title>T</title></issue>',
    '<issue identifier="SYN-1"><title lang="en">T</title></issue>',
    '<issue identifier="SYN-1"><title>T</title></issue><other-thread><comment author="Ada" role="owner">x</comment></other-thread>',
    '<issue identifier="SYN-1"><title>T</title></issue><other-thread><comment author="Ada" author="Ben">x</comment></other-thread>',
    '<issue identifier="SYN-1"><title>T</title></issue><guidance><guidance-rule origin="team" project-name="P">x</guidance-rule></guidance>',
  ]) assert.equal(linearSessionDisplayText(context), context, context);
});

test('a comment time is shortened only when it names its zone, the same in every server zone', () => {
  const context = '<issue identifier="SYN-1"><title>T</title></issue><other-thread>'
    + '<comment author="Ada" created-at="2026-01-08 16:33:12">No zone.</comment>'
    + '<comment author="Ben" created-at="2026-11-04T08:14:27+08:00">Offset.</comment>'
    + '<comment author="Cy" created-at="2026-11-04 00:15:00Z">UTC.</comment>'
    + '</other-thread>';
  const expected = '**SYN-1 · T**\n\nAnother thread on the issue:\nAda (2026-01-08 16:33:12): No zone.\n\nBen (2026-11-04T00:14Z): Offset.\n\nCy (2026-11-04T00:15Z): UTC.';
  const zone = process.env.TZ;
  try {
    for (const tz of ['Asia/Shanghai', 'UTC', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      assert.equal(linearSessionDisplayText(context), expected, tz);
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
