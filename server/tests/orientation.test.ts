import test from 'node:test';
import assert from 'node:assert/strict';

import { agentConfigSchema, type AgentConfig } from '../../shared/agent-config.js';
import type { AgentMessageRecord } from '../../shared/messages.js';
import { renderCliError } from '../cli/cli-errors.js';
import type { FeishuChatInfo, FeishuUserBasicInfo } from '../feishu/client.js';
import {
  formatPlaces,
  formatWhois,
  placesForAgent,
  type FeishuOrientationAdapter,
  type OrientationDeps,
  type SlackOrientationAdapter,
  whoisForAgent,
} from '../tools/orientation.js';
import { runPlaces } from '../tools/orientation-cli.js';
import { runSubscriptionList } from '../tools/subscriptions-cli.js';
import type { SubscriptionRecord } from '../inbox/subscription.service.js';
import type { SlackConversationInfo, SlackUserInfo } from '../slack/slack.helper.js';

test('whois overlays this-runtime Slack agents by exact bot id and leaves foreign bots plain', async () => {
  const local = agent({
    profile: { displayName: 'Milo', role: 'Runtime engineer' },
    slack: { botHandle: 'milo', botUserId: 'U-local' },
  });
  const deps = depsFor({
    agents: [local],
    slack: slackAdapter({
      usersByHandle: {
        milo: [slackUser({ id: 'U-local', isAppUser: true, name: 'milo', realName: 'Milo Bot' })],
        somebot: [slackUser({ id: 'U-foreign', isBot: true, name: 'somebot' })],
      },
    }),
  });

  assert.equal(
    formatWhois(await whoisForAgent({ agentId: 'scout', deps, target: '@milo' })),
    'Milo   @milo   U-local   agent · Runtime engineer   (this runtime)',
  );
  assert.equal(
    formatWhois(await whoisForAgent({ agentId: 'scout', deps, target: '@somebot' })),
    'somebot   @somebot   U-foreign   bot   (not managed by this runtime)',
  );
});

test('whois channel output omits topic when Slack did not return one', async () => {
  const deps = depsFor({
    slack: slackAdapter({
      conversationsByName: {
        team: slackChannel({ id: 'C-team', isMember: true, name: 'team', numMembers: 6 }),
      },
    }),
  });

  const rendered = formatWhois(await whoisForAgent({ agentId: 'scout', deps, target: '#team' }));
  assert.equal(rendered, '#team   C-team   channel · you are a member · 6 members');
  assert.doesNotMatch(rendered, /topic=/);
});

test('whois ambiguous handle uses anima.ambiguous_user with whois recovery hint', async () => {
  const deps = depsFor({
    slack: slackAdapter({
      usersByHandle: {
        alex: [
          slackUser({ id: 'U-a', name: 'alex', realName: 'Alex A' }),
          slackUser({ id: 'U-b', name: 'alex', realName: 'Alex B' }),
        ],
      },
    }),
  });

  await assert.rejects(
    () => whoisForAgent({ agentId: 'scout', deps, target: '@alex' }),
    (error) => {
      const rendered = renderCliError(error);
      assert.match(rendered ?? '', /^error anima\.ambiguous_user \(not retryable\): /);
      assert.match(rendered ?? '', /anima whois <id>/);
      assert.match(rendered ?? '', /U-a/);
      assert.match(rendered ?? '', /U-b/);
      return true;
    },
  );
});

test('places sorts newest last, truncates loudly, and never renders thread subscriptions', async () => {
  const channels = Array.from({ length: 52 }, (_, index) => {
    const n = index + 1;
    return slackChannel({
      id: `C-${String(n).padStart(2, '0')}`,
      isMember: true,
      name: `chan-${String(n).padStart(2, '0')}`,
    });
  });
  const messages = channels.map((channel, index) =>
    message({
      channelId: channel.id!,
      channelName: channel.name,
      timestamp: `2026-07-01T00:${String(index).padStart(2, '0')}:00.000Z`,
    })
  );
  const deps = depsFor({
    messages,
    slack: slackAdapter({ memberConversations: channels }),
    subscriptions: [
      threadSub({ channelId: 'C-52', threadTs: '1770000000.000001' }),
    ],
  });

  const rendered = formatPlaces(await placesForAgent({ agentId: 'scout', deps }));
  assert.match(rendered, /^Channels \(52, showing 50 most recent; use --all\)/);
  assert.doesNotMatch(rendered, /C-01/);
  assert.doesNotMatch(rendered, /thread_ts|1770000000\.000001/);
  assert.ok(rendered.indexOf('#chan-51') < rendered.indexOf('#chan-52'));
  assert.match(rendered, /Muted \(0\)\n  - none/);
});

test('places puts muted rooms in Muted with stale ledger delivery time', async () => {
  const deps = depsFor({
    messages: [
      message({
        channelId: 'C-noisy',
        channelName: 'noisy',
        timestamp: '2026-07-01T00:00:00.000Z',
      }),
    ],
    slack: slackAdapter({
      memberConversations: [slackChannel({ id: 'C-noisy', isMember: true, name: 'noisy' })],
    }),
    subscriptions: [
      channelSub({
        channelId: 'C-noisy',
        mutedAt: '2026-07-02T00:00:00.000Z',
      }),
    ],
  });

  const rendered = formatPlaces(await placesForAgent({ agentId: 'scout', deps }));
  assert.match(rendered, /^Channels \(0\)\n  - none/m);
  assert.match(rendered, /Muted \(1\)\n  #noisy\s+C-noisy\s+last_delivery=2026-07-01T00:00:00.000Z/);
});

test('places reads only the bounded recent message window', async () => {
  const allMessages = Array.from({ length: 510 }, (_, index) => {
    const n = index + 1;
    return message({
      channelDisplayName: `user-${String(n).padStart(3, '0')}`,
      channelId: `D-${String(n).padStart(3, '0')}`,
      timestamp: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
    });
  });
  const listRequests: Array<{ agentId: string; limit: number }> = [];
  const deps = depsFor({});
  deps.listMessages = async (agentId, input) => {
    listRequests.push({ agentId, limit: input.limit });
    return allMessages.slice(-input.limit);
  };

  const result = await placesForAgent({ agentId: 'scout', deps });
  const rendered = formatPlaces(result);
  assert.deepEqual(listRequests, [{ agentId: 'scout', limit: 500 }]);
  assert.equal(result.rows.length, 500);
  assert.ok(result.rows.some((row) => row.id === 'D-011'));
  assert.ok(result.rows.some((row) => row.id === 'D-510'));
  assert.ok(!result.rows.some((row) => row.id === 'D-001'));
  assert.match(rendered, /DMs \(500, showing 50 most recent; use --all\)/);
  assert.doesNotMatch(rendered, /D-001|user-001/);
});

test('Feishu places are honestly labeled as known-to-runtime chats', async () => {
  const scout = agent({
    feishu: { appId: 'cli-test', appSecret: 'secret', botOpenId: 'ou-bot' },
    slack: { botToken: '' },
  });
  const deps = depsFor({
    agent: scout,
    messages: [
      message({
        channelDisplayName: 'Ops Chat',
        channelId: 'oc_ops',
        channelKind: 'group',
        platform: 'feishu',
        timestamp: '2026-07-01T00:00:00.000Z',
      }),
      message({
        channelDisplayName: 'Owner',
        channelId: 'oc_owner',
        channelKind: 'p2p',
        platform: 'feishu',
        timestamp: '2026-07-01T01:00:00.000Z',
      }),
    ],
    feishu: feishuAdapter({
      chats: {
        oc_ops: { chatId: 'oc_ops', chatName: 'Ops Chat', chatType: 'group' },
        oc_owner: { chatId: 'oc_owner', chatName: 'Owner', chatType: 'p2p' },
      },
    }),
  });

  const rendered = formatPlaces(await placesForAgent({ agentId: 'scout', deps }));
  assert.match(rendered, /Feishu known chats \(1\)/);
  assert.match(rendered, /Feishu known DMs \(1\)/);
  assert.doesNotMatch(rendered, /^Feishu Chats/m);
});

test('whois Feishu user output does not invent human or bot status', async () => {
  const scout = agent({
    feishu: { appId: 'cli-test', appSecret: 'secret', botOpenId: 'ou-bot' },
    slack: { botToken: '' },
  });
  const deps = depsFor({
    agent: scout,
    feishu: feishuAdapter({
      users: {
        ou_user: { name: 'Ada', openId: 'ou_user' },
      },
    }),
  });

  assert.equal(
    formatWhois(await whoisForAgent({ agentId: 'scout', deps, target: 'ou_user' })),
    'Ada   ou_user   user',
  );
});

test('subscription list is a quiet alias for places', async () => {
  const deps = depsFor({
    messages: [
      message({
        channelId: 'C-team',
        channelName: 'team',
        timestamp: '2026-07-01T00:00:00.000Z',
      }),
    ],
    slack: slackAdapter({
      memberConversations: [slackChannel({ id: 'C-team', isMember: true, name: 'team' })],
    }),
  });

  const places = await captureStdout(() => runPlaces({ agent: 'scout', all: false }, deps));
  const subscriptions = await captureStdout(() => runSubscriptionList({ agent: 'scout', all: false }, deps));
  assert.equal(subscriptions, places);
  assert.doesNotMatch(subscriptions, /Threads:|quiet threads/);
});

function depsFor(input: {
  agent?: AgentConfig;
  agents?: AgentConfig[];
  feishu?: FeishuOrientationAdapter;
  messages?: AgentMessageRecord[];
  slack?: SlackOrientationAdapter;
  subscriptions?: SubscriptionRecord[];
}): OrientationDeps {
  const scout = input.agent ?? agent();
  const agents = input.agents ?? [scout];
  return {
    async getAgentConfig(agentId) {
      return agents.find((candidate) => candidate.id === agentId) ?? scout;
    },
    async listAgentConfigs() {
      return agents;
    },
    async listMessages() {
      return input.messages ?? [];
    },
    async listSubscriptions() {
      return input.subscriptions ?? [];
    },
    feishuAdapterForAgent() {
      return input.feishu;
    },
    slackAdapterForAgent() {
      return input.slack;
    },
  };
}

function agent(input: {
  feishu?: Partial<AgentConfig['feishu']>;
  profile?: Partial<AgentConfig['profile']>;
  slack?: Partial<AgentConfig['slack']>;
} = {}): AgentConfig {
  return agentConfigSchema('scout').parse({
    id: 'scout',
    profile: {
      displayName: 'Scout',
      role: 'Research agent',
      ...input.profile,
    },
    feishu: {
      ...input.feishu,
    },
    slack: {
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      teamId: 'T-demo',
      ...input.slack,
    },
  });
}

function slackAdapter(input: {
  conversationsById?: Record<string, SlackConversationInfo>;
  conversationsByName?: Record<string, SlackConversationInfo>;
  memberConversations?: SlackConversationInfo[];
  usersByHandle?: Record<string, SlackUserInfo[]>;
  usersById?: Record<string, SlackUserInfo>;
}): SlackOrientationAdapter {
  return {
    async getConversationById(id) {
      return input.conversationsById?.[id];
    },
    async getConversationByName(name) {
      return input.conversationsByName?.[name.replace(/^#/, '').toLowerCase()];
    },
    async getMemberConversations() {
      return input.memberConversations ?? [];
    },
    async getUserById(id) {
      return input.usersById?.[id];
    },
    async getUsersByHandle(handle) {
      return input.usersByHandle?.[handle.replace(/^@/, '').toLowerCase()] ?? [];
    },
  };
}

function feishuAdapter(input: {
  chats?: Record<string, FeishuChatInfo>;
  users?: Record<string, FeishuUserBasicInfo>;
}): FeishuOrientationAdapter {
  return {
    async getChat(chatId) {
      return input.chats?.[chatId];
    },
    async getUser(openId) {
      return input.users?.[openId];
    },
  };
}

function slackUser(input: {
  id: string;
  isAppUser?: boolean;
  isBot?: boolean;
  name?: string;
  realName?: string;
}): SlackUserInfo {
  return {
    id: input.id,
    is_app_user: input.isAppUser,
    is_bot: input.isBot,
    name: input.name,
    profile: {
      real_name: input.realName,
    },
    real_name: input.realName,
  } as SlackUserInfo;
}

function slackChannel(input: {
  id: string;
  isMember?: boolean;
  name?: string;
  numMembers?: number;
  topic?: string;
}): SlackConversationInfo {
  return {
    id: input.id,
    is_channel: true,
    is_member: input.isMember,
    name: input.name,
    name_normalized: input.name,
    num_members: input.numMembers,
    topic: input.topic ? { value: input.topic } : undefined,
  } as SlackConversationInfo;
}

function message(input: {
  channelDisplayName?: string;
  channelId: string;
  channelKind?: string;
  channelName?: string;
  direction?: AgentMessageRecord['direction'];
  platform?: string;
  timestamp: string;
}): AgentMessageRecord {
  return {
    channelDisplayName: input.channelDisplayName,
    channelId: input.channelId,
    channelKind: input.channelKind,
    channelName: input.channelName,
    direction: input.direction ?? 'in',
    kind: 'message',
    messageId: `msg:${input.channelId}:${input.timestamp}`,
    platform: input.platform,
    source: { id: `src:${input.channelId}:${input.timestamp}`, kind: 'inbox' },
    text: 'hello',
    timestamp: input.timestamp,
  };
}

function channelSub(input: {
  channelId: string;
  mutedAt?: string;
}): SubscriptionRecord {
  return {
    agentId: 'scout',
    channelId: input.channelId,
    kind: 'channel',
    ...(input.mutedAt ? { mutedAt: input.mutedAt } : {}),
    subscriptionId: `slack-subscription:scout:${input.channelId}:channel`,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function threadSub(input: {
  channelId: string;
  threadTs: string;
}): SubscriptionRecord {
  return {
    agentId: 'scout',
    channelId: input.channelId,
    kind: 'thread',
    subscriptionId: `slack-subscription:scout:${input.channelId}:thread:${input.threadTs}`,
    threadTs: input.threadTs,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}
