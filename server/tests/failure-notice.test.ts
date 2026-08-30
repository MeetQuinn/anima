import test from 'node:test';
import assert from 'node:assert/strict';

import { makeSlackEvent } from './helpers/slack.js';
import {
  failureNoticeText,
  postRuntimeFailureNotice,
  shouldNotifyRequester,
  slackFailureNoticePost,
} from '../runtime/failure-notice.js';
import type { InboxItem } from '../inbox/wake-queue.service.js';

const base = { teamId: 'T-demo', text: 'hello', userId: 'U1' };

test('failure notice only targets messages that addressed the agent', () => {
  const dm = makeSlackEvent({ ...base, channelId: 'D-user', wakeReason: 'dm' });
  const mention = makeSlackEvent({ ...base, channelId: 'C-room', wakeReason: 'mention', ts: '1770000010.000001' });
  const follow = makeSlackEvent({ ...base, channelId: 'C-room', wakeReason: 'channel_follow' });
  const threadFollow = makeSlackEvent({ ...base, channelId: 'C-room', wakeReason: 'thread_follow', threadTs: '1770000000.000001' });
  const legacyDm = makeSlackEvent({ ...base, channelId: 'D-user' });

  assert.equal(shouldNotifyRequester(dm), true);
  assert.equal(shouldNotifyRequester(mention), true);
  assert.equal(shouldNotifyRequester(follow), false);
  assert.equal(shouldNotifyRequester(threadFollow), false);
  assert.equal(shouldNotifyRequester(legacyDm), true);

  const failure = { error: new Error('API Error: 529 Overloaded (api status 529)'), retryAttempts: 3, retryClass: 'transient' as const };
  assert.deepEqual(slackFailureNoticePost(dm, failure), {
    channel: 'D-user',
    text: failureNoticeText(failure),
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.deepEqual(slackFailureNoticePost(mention, failure), {
    channel: 'C-room',
    text: failureNoticeText(failure),
    thread_ts: '1770000010.000001',
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.equal(slackFailureNoticePost(follow, failure), undefined);
});

test('failure notice text is short and names the reason class', () => {
  assert.equal(
    failureNoticeText({ error: new Error('API Error: 529 Overloaded. This is a server-side issue (api status 529)'), retryAttempts: 3, retryClass: 'transient' }),
    "⚠️ I couldn't process this message (model provider error after 3 retries: 529 Overloaded. This is a server-side issue). Please send it again.",
  );
  assert.equal(
    failureNoticeText({
      error: new Error("API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup).\n\nTry rephrasing."),
      retryAttempts: 3,
      retryClass: 'transient',
    }),
    "⚠️ I couldn't process this message (the model provider refused the request after 3 retries). Please send it again.",
  );
  assert.equal(
    failureNoticeText({ error: new Error('Failed to authenticate. API Error: 403 Request not allowed (api status 403)'), retryAttempts: 0, retryClass: 'terminal' }),
    "⚠️ I couldn't process this message (model provider authentication failed). Please send it again.",
  );
  assert.equal(
    failureNoticeText({ error: new Error("You've hit your session limit · resets 2:10pm (api status 429)"), retryAttempts: 6, retryClass: 'rate_limit_deferrals_exhausted' }),
    "⚠️ I couldn't process this message (the model provider stayed rate-limited). Please send it again.",
  );
  const long = failureNoticeText({ error: new Error(`API Error: ${'x'.repeat(400)}`), retryAttempts: 1, retryClass: 'transient' });
  assert.ok(long.length < 260, `notice too long: ${long.length}`);
});

test('postRuntimeFailureNotice posts to Slack for a mention and skips passive follows', async () => {
  const posts: unknown[] = [];
  const slackClient = { chat: { postMessage: async (payload: unknown) => { posts.push(payload); return { ok: true }; } } };
  const failure = { error: new Error('API Error: 529 Overloaded (api status 529)'), retryAttempts: 3, retryClass: 'transient' as const };
  const mention: InboxItem = makeSlackEvent({ ...base, channelId: 'C-room', wakeReason: 'mention', ts: '1770000010.000001' });
  const follow: InboxItem = makeSlackEvent({ ...base, channelId: 'C-room', wakeReason: 'channel_follow' });

  assert.equal(await postRuntimeFailureNotice({ agentId: 'scout', failure, item: follow, runtimeKind: 'claude-code', slackClient: slackClient as never }), false);
  assert.equal(posts.length, 0);

  // No activity home is set up here; the notice itself must still succeed and
  // activity recording failures must not surface.
  const posted = await postRuntimeFailureNotice({
    agentId: 'scout',
    failure,
    item: mention,
    logger: { error: () => {} },
    runtimeKind: 'claude-code',
    slackClient: slackClient as never,
  });
  assert.equal(posted, true);
  assert.deepEqual(posts, [{
    channel: 'C-room',
    text: failureNoticeText(failure),
    thread_ts: '1770000010.000001',
    unfurl_links: false,
    unfurl_media: false,
  }]);
});
