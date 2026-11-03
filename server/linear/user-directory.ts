import { linearUserDirectoryStore, type LinearUserDirectoryFile } from '../storage/schema/cache.js';
import type { LinearSender } from './webhook.js';

// Linear people seen in webhooks, shared by every agent on this machine.
// Every event carries its sender's name and avatar, so the latest event
// refreshes the entry and no API lookup is needed. Message history joins these
// in when it is read; the message ledger never stores avatars.

export const LINEAR_USER_DIRECTORY_LIMIT = 1000;

// An unchanged entry is rewritten at most once a day, so `updatedAt` tracks
// when the person was last seen without a write for every event.
const SEEN_REFRESH_MS = 24 * 60 * 60 * 1000;

export interface LinearUserProfile { name?: string; avatarUrl?: string }

export async function rememberLinearUser(sender: LinearSender, now = new Date()): Promise<void> {
  const name = sender.name?.trim() || undefined;
  const avatarUrl = httpsUrl(sender.avatarUrl);
  const known = (await linearUserDirectoryStore.read()).users[sender.id];
  if (known && known.name === name && known.avatarUrl === avatarUrl
    && now.getTime() - Date.parse(known.updatedAt) < SEEN_REFRESH_MS) return;
  await linearUserDirectoryStore.update((file) => ({
    users: withinLimit({
      ...file.users,
      [sender.id]: { ...(name ? { name } : {}), ...(avatarUrl ? { avatarUrl } : {}), updatedAt: now.toISOString() },
    }),
  }));
}

export async function linearUserProfiles(ids: Iterable<string>): Promise<Map<string, LinearUserProfile>> {
  const { users } = await linearUserDirectoryStore.read();
  const profiles = new Map<string, LinearUserProfile>();
  for (const id of ids) {
    const user = Object.hasOwn(users, id) ? users[id] : undefined;
    if (user && (user.name || user.avatarUrl)) {
      profiles.set(id, { ...(user.name ? { name: user.name } : {}), ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}) });
    }
  }
  return profiles;
}

// Keep the people seen most recently.
function withinLimit(users: LinearUserDirectoryFile['users']): LinearUserDirectoryFile['users'] {
  const entries = Object.entries(users);
  if (entries.length <= LINEAR_USER_DIRECTORY_LIMIT) return users;
  entries.sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt));
  return Object.fromEntries(entries.slice(0, LINEAR_USER_DIRECTORY_LIMIT));
}

function httpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
