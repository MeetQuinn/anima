import { readdir } from 'node:fs/promises';

import { WakeQueueService, type InboxItem } from '../../inbox/wake-queue.service.js';
import { reminderServiceForAgent } from '../../reminders/reminder.service.js';
import { isMissingFile } from '../../storage/json-file.js';
import type { Reminder } from '../../../shared/reminder.js';
import { activityServiceForAgent } from '../../activities/activity.service.js';
import { agentsDir } from '../../storage/schema/agent.store.js';
import { SessionStore, type Session } from '../../storage/schema/session.store.js';
import { SubscriptionStore, type SubscriptionRecord } from '../../storage/schema/subscription.store.js';
import type { Activity } from '../../../shared/activity.js';

export interface TestState {
  activities: Record<string, Activity>;
  events: Record<string, InboxItem>;
  subscriptions: Record<string, SubscriptionRecord>;
  reminders: Record<string, Reminder>;
  items: Record<string, InboxItem>;
  sessions: Record<string, Session>;
}

type ActivityState = Pick<TestState, 'activities'>;

export async function loadState(): Promise<TestState> {
  const state = emptyState();
  const agentIds = await listAgentIds();
  await Promise.all(agentIds.map((agentId) => hydrateAgentState(agentId, state)));
  return state;
}

export async function loadAgentState(agentId: string): Promise<TestState> {
  const state = emptyState();
  await hydrateAgentState(agentId, state);
  return state;
}

export function allActivities(state: ActivityState): Activity[] {
  return Object.values(state.activities).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function hydrateAgentState(agentId: string, state: TestState): Promise<void> {
  const queue = new WakeQueueService(agentId);
  const [session, events, subscriptions, reminders, items, activities] = await Promise.all([
    readSession(agentId),
    queue.list(),
    new SubscriptionStore(agentId).list(),
    reminderServiceForAgent(agentId).listAllReminders(),
    queue.list(),
    activityServiceForAgent(agentId).readAll(),
  ]);

  if (session) state.sessions[agentId] = session;
  for (const event of events) state.events[event.id] = event;
  for (const subscription of subscriptions) state.subscriptions[subscription.subscriptionId] = subscription;
  for (const reminder of reminders) state.reminders[reminder.reminderId] = reminder;
  for (const item of items) state.items[item.id] = item;
  for (const activity of activities) state.activities[activity.activityId] = activity;
}

async function readSession(agentId: string): Promise<Session | undefined> {
  return new SessionStore(agentId).read();
}

async function listAgentIds(): Promise<string[]> {
  try {
    const entries = await readdir(agentsDir(), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

function emptyState(): TestState {
  return {
    activities: {},
    events: {},
    subscriptions: {},
    reminders: {},
    items: {},
    sessions: {},
  };
}
