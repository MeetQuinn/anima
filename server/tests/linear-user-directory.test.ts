import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LinearWebhook, linearEventSender } from '../linear/webhook.js';
import { LINEAR_USER_DIRECTORY_LIMIT, linearUserProfiles, rememberLinearUser } from '../linear/user-directory.js';
import { linearUserDirectoryStore } from '../storage/schema/cache.js';
import { messageFromInboxItem } from '../messages/message.projection.js';
import { enrichInboundAvatars } from '../web/message-profiles.js';
import type { LinearInboxItem } from '../../shared/inbox.js';
import { withTempAnimaHome } from './helpers/harness.js';
import { created, install, prompted } from './helpers/linear.js';

const avatar = 'https://public.linear.app/synthetic/avatar.png';

test('a webhook names its sender with their avatar, and a malformed avatar never rejects it', () => {
  const event = created();
  if (event.type !== 'AgentSessionEvent') throw new Error('fixture');
  event.agentSession.creator = { name: 'Synthetic requester', avatarUrl: avatar };
  assert.deepEqual(linearEventSender(LinearWebhook.parse(event)), { id: event.agentSession.creatorId, name: 'Synthetic requester', avatarUrl: avatar });

  const prompt = prompted();
  if (prompt.type !== 'AgentSessionEvent') throw new Error('fixture');
  const author = randomUUID();
  prompt.agentActivity = { ...prompt.agentActivity!, userId: author, user: { id: author, name: 'Synthetic author', avatarUrl: avatar } };
  assert.deepEqual(linearEventSender(LinearWebhook.parse(prompt)), { id: author, name: 'Synthetic author', avatarUrl: avatar });

  const actor = randomUUID();
  const notification = { type: 'AppUserNotification', action: 'issueMention', appUserId: install.appUserId,
    organizationId: install.organizationId, oauthClientId: install.clientId, webhookTimestamp: Date.now(),
    notification: { id: randomUUID(), type: 'issueMention', userId: install.appUserId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      actorId: actor, actor: { id: actor, name: 'Synthetic teammate', avatarUrl: 42 } } };
  assert.deepEqual(linearEventSender(LinearWebhook.parse(notification)), { id: actor, name: 'Synthetic teammate' });
  const idOnly = { ...notification, notification: { ...notification.notification, actor: undefined } };
  assert.equal(linearEventSender(LinearWebhook.parse(idOnly)), undefined, 'An id alone never overwrites a known profile');

  const permissions = LinearWebhook.parse({ type: 'PermissionChange', action: 'teamAccessChanged', appUserId: install.appUserId,
    organizationId: install.organizationId, oauthClientId: install.clientId, webhookTimestamp: Date.now(),
    createdAt: new Date().toISOString(), canAccessAllPublicTeams: true, addedTeamIds: [], removedTeamIds: [] });
  assert.equal(linearEventSender(permissions), undefined);
});

test('the directory keeps the latest name and https avatar per Linear user', async (t) => withTempAnimaHome(async () => {
  const id = randomUUID();
  await rememberLinearUser({ id, name: 'Before', avatarUrl: avatar });
  assert.deepEqual(await linearUserProfiles([id, randomUUID(), 'constructor', '__proto__']), new Map([[id, { name: 'Before', avatarUrl: avatar }]]));

  const update = t.mock.method(linearUserDirectoryStore, 'update');
  await rememberLinearUser({ id, name: 'Before', avatarUrl: avatar });
  assert.equal(update.mock.callCount(), 0, 'An unchanged sender is not written again');
  const nextDay = new Date(Date.now() + 25 * 60 * 60 * 1000);
  await rememberLinearUser({ id, name: 'Before', avatarUrl: avatar }, nextDay);
  assert.equal(update.mock.callCount(), 1, 'A day later the same sender refreshes when they were last seen');
  assert.equal((await linearUserDirectoryStore.read()).users[id]?.updatedAt, nextDay.toISOString());

  await rememberLinearUser({ id, name: 'After', avatarUrl: 'http://insecure.example/avatar.png' });
  assert.deepEqual((await linearUserProfiles([id])).get(id), { name: 'After' });
  await rememberLinearUser({ id, avatarUrl: 'javascript:alert(1)' });
  assert.equal((await linearUserProfiles([id])).size, 0);
}));

test('the directory keeps only the most recently seen people', async () => withTempAnimaHome(async () => {
  const users: Record<string, { name: string; updatedAt: string }> = {};
  for (let n = 0; n < LINEAR_USER_DIRECTORY_LIMIT; n++) {
    users[`user-${n}`] = { name: `Person ${n}`, updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() };
  }
  await linearUserDirectoryStore.write({ users });
  await rememberLinearUser({ id: 'newcomer', name: 'Newcomer' }, new Date(Date.UTC(2026, 1, 1)));
  const kept = (await linearUserDirectoryStore.read()).users;
  assert.equal(Object.keys(kept).length, LINEAR_USER_DIRECTORY_LIMIT);
  assert.ok(kept.newcomer && kept['user-1'] && !kept['user-0']);
}));

test('Linear history shows the sender\'s current name and avatar from the directory', async () => withTempAnimaHome(async () => {
  const sender = randomUUID();
  const item: LinearInboxItem = {
    id: 'linear:item', kind: 'linear', installationId: install.id, organizationId: install.organizationId, sessionId: randomUUID(),
    action: 'created', text: 'Synthetic request', receivedAt: new Date().toISOString(), humanRequested: true,
    actorId: sender, actorName: 'Old name',
    handling: { status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), queuedAt: new Date().toISOString() },
  };
  const message = messageFromInboxItem(item)!;
  assert.equal(message.actorUserId, sender);
  assert.equal(message.actorAvatarUrl, undefined, 'The ledger record carries no avatar');

  const page = { entries: [message, { ...message, direction: 'out' as const, messageId: 'out' }], nextCursor: null };
  assert.equal(await enrichInboundAvatars('scout', page), page, 'Nothing known yet leaves the page as is');
  await rememberLinearUser({ id: sender, name: 'Current name', avatarUrl: avatar });
  const [inbound, outbound] = (await enrichInboundAvatars('scout', page)).entries;
  assert.equal(inbound!.actorDisplayName, 'Current name');
  assert.equal(inbound!.actorAvatarUrl, avatar);
  assert.equal(outbound!.actorAvatarUrl, undefined);
}));
