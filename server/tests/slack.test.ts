import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebClient } from '@slack/web-api';

import { SlackProfileResolver } from '../inbox/slack-profiles.js';
import { SlackWorkspaceDirectoryService } from '../slack/workspace-directory.service.js';
import { resolveSlackChannelArgument } from '../tools/slack-channel-resolver.js';
import {
  extractReadableSlackChannelMentions,
  extractReadableSlackUserMentions,
  extractReadableSlackUserIdMentions,
  extractSlackChannelMentionIds,
  extractSlackUserMentionIds,
  replaceReadableSlackChannelMentions,
  replaceReadableSlackUserIdMentions,
  replaceReadableSlackUserMentions,
  replaceSlackChannelMentions,
  replaceSlackUserMentions,
} from '../slack/slack.helper.js';

test('Slack text helpers extract and replace mentions', () => {
  assert.deepEqual(extractSlackUserMentionIds('hi <@U123> and <@U456|legacy> and <@U123>'), ['U123', 'U456']);
  assert.equal(
    replaceSlackUserMentions('hi <@U123> and <@U456|legacy> and <@U789>', new Map([['U123', '@alice'], ['U456', '@bob']])),
    'hi @alice and @bob and @U789',
  );
  assert.deepEqual(extractSlackChannelMentionIds('see <#C123|product> and <#G456> and <#C123|product>'), ['C123', 'G456']);
  assert.equal(replaceSlackChannelMentions('see <#C123|product> and <#G456>', new Map([['C123', '#support']])), 'see #support and #G456');
});

test('Slack text helpers convert readable mentions to Slack markup', () => {
  assert.deepEqual(extractReadableSlackUserMentions('cc @alice, @bob.smith and <@U123>'), ['alice', 'bob.smith']);
  assert.equal(
    replaceReadableSlackUserMentions('cc @alice, @unknown and <@U123>', new Map([['alice', 'U123']])),
    'cc <@U123>, @unknown and <@U123>',
  );
  assert.deepEqual(extractReadableSlackUserMentions('试一下：@nora，中文里也能@alice'), ['nora', 'alice']);
  assert.deepEqual(extractReadableSlackUserMentions('literal `@nora` stays plain'), []);
  assert.equal(
    replaceReadableSlackUserMentions('试一下：@nora，中文里也能@alice；email a@b.com and <@U123>', new Map([['alice', 'U123'], ['nora', 'U456']])),
    '试一下：<@U456>，中文里也能<@U123>；email a@b.com and <@U123>',
  );
  assert.deepEqual(extractReadableSlackChannelMentions('see #product, #team-updates and <#C123>'), ['product', 'team-updates']);
  assert.deepEqual(extractReadableSlackChannelMentions('options: #1 then #2, but #course-reports is a channel'), ['course-reports']);
  assert.deepEqual(extractReadableSlackChannelMentions('看：#dev，中文里也能#product'), ['dev', 'product']);
  assert.deepEqual(extractReadableSlackChannelMentions('literal `#dev` stays plain'), []);
  assert.equal(
    replaceReadableSlackChannelMentions('see #product, #unknown and <#C123>', new Map([['product', 'C123']])),
    'see <#C123>, #unknown and <#C123>',
  );
  assert.equal(
    replaceReadableSlackChannelMentions('看：#dev，中文里也能#product；url https://example.com/#section', new Map([['dev', 'C-dev'], ['product', 'C-product']])),
    '看：<#C-dev>，中文里也能<#C-product>；url https://example.com/#section',
  );
});

test('Slack text helpers convert raw user ids outside code spans', () => {
  assert.deepEqual(extractReadableSlackUserIdMentions('cc @U123 and `@U456` then ```\n@U789\n```'), ['U123']);
  assert.equal(
    replaceReadableSlackUserIdMentions('cc @U123 and <@U456> but `@U789` and ```\n@U999\n```'),
    'cc <@U123> and <@U456> but `@U789` and ```\n@U999\n```',
  );
  assert.equal(
    replaceReadableSlackUserMentions('cc `please @alice` and @alice', new Map([['alice', 'U123']])),
    'cc `please @alice` and <@U123>',
  );
});

test('Slack workspace directory resolves username and display name handles', async () => {
  const client = fakeSlackApi({
    users: {
      list: async () => ({
        members: [
          {
            id: 'U123',
            name: 'alice',
            profile: { display_name: 'alice', real_name: 'Alice Example' },
          },
        ],
        ok: true,
      }),
    },
  });

  const directory = new SlackWorkspaceDirectoryService({ client });

  assert.equal((await directory.getUserByHandle('alice')).id, 'U123');
  assert.equal((await directory.getUserByHandle('Alice Example')).id, 'U123');
});

test('Slack workspace directory caches user lists by team', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-directory-cache-'));
  const previousHome = process.env.ANIMA_HOME;
  process.env.ANIMA_HOME = stateDir;
  try {
    let calls = 0;
    const client = fakeSlackApi({
      users: {
        list: async () => {
          calls += 1;
          return {
            members: [{ id: 'U123', name: 'alice', profile: { display_name: 'Alice' } }],
            ok: true,
          };
        },
      },
    });

    const directory = new SlackWorkspaceDirectoryService({ client, teamId: 'T123' });

    assert.equal((await directory.getUserByHandle('alice')).id, 'U123');
    assert.equal((await directory.getUserByHandle('alice')).id, 'U123');
    assert.equal(calls, 1);
  } finally {
    if (previousHome === undefined) delete process.env.ANIMA_HOME;
    else process.env.ANIMA_HOME = previousHome;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Slack directory cache accepts user change events', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-directory-event-'));
  const previousHome = process.env.ANIMA_HOME;
  process.env.ANIMA_HOME = stateDir;
  try {
    const client = fakeSlackApi({
      users: {
        list: async () => {
          throw new Error('users.list should not be called for a fresh event cache hit');
        },
      },
    });
    const directory = new SlackWorkspaceDirectoryService({ client, teamId: 'T123' });

    await directory.applyEvent({
      team: 'T123',
      type: 'user_change',
      user: { id: 'U123', name: 'alice', profile: { display_name: 'Alice' } },
    });

    assert.equal((await directory.getUserByHandle('alice')).id, 'U123');
  } finally {
    if (previousHome === undefined) delete process.env.ANIMA_HOME;
    else process.env.ANIMA_HOME = previousHome;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Slack channel resolver treats raw channel ids as already resolved', async () => {
  assert.deepEqual(await resolveSlackChannelArgument({ channel: 'C123ABC' }), { id: 'C123ABC' });
});

test('Slack channel resolver requires a WebClient for readable names', async () => {
  await assert.rejects(
    () => resolveSlackChannelArgument({ channel: '#team' }),
    /Slack WebClient is required to resolve Slack channel name: #team\. Pass a channel ID or configure slack\.botToken\./,
  );
});

test('Slack channel resolver resolves readable names through the workspace directory', async () => {
  const client = fakeSlackApi({
    conversations: {
      list: async () => ({
        channels: [{ id: 'C123', name: 'team', name_normalized: 'team' }],
        ok: true,
      }),
    },
  });

  assert.deepEqual(await resolveSlackChannelArgument({ channel: '#team', client }), { id: 'C123', name: 'team' });
});

test('Slack channel resolver resolves DM handles through the workspace directory', async () => {
  const client = fakeSlackApi({
    users: {
      list: async () => ({
        members: [{ id: 'U123', name: 'alice', profile: { display_name: 'Alice' } }],
        ok: true,
      }),
    },
  });

  assert.deepEqual(await resolveSlackChannelArgument({ channel: '@alice', client }), {
    dmHandle: 'alice',
    dmUserId: 'U123',
    id: 'D123',
  });
});

test('SlackProfileResolver caches Slack timezone metadata with the handle profile', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-profile-cache-'));
  const previousHome = process.env.ANIMA_HOME;
  process.env.ANIMA_HOME = stateDir;
  let calls = 0;
  try {
    const client = fakeSlackApi({
      users: {
        info: async () => {
          calls += 1;
          return {
            ok: true,
            user: {
              id: 'U123',
              name: 'alice',
              profile: { display_name: 'Alice', real_name: 'Alice Lee' },
              tz: 'Asia/Shanghai',
              tz_label: 'China Standard Time',
              tz_offset: 28800,
            },
          };
        },
      },
    });
    const profiles = new SlackProfileResolver();

    const profile = await profiles.user({ client, teamId: 'T123', userId: 'U123' });
    const cached = await profiles.user({ client, teamId: 'T123', userId: 'U123' });

    assert.equal(calls, 1);
    assert.equal(cached, profile);
    assert.deepEqual(profile?.timezone, {
      label: 'China Standard Time',
      name: 'Asia/Shanghai',
      offsetSeconds: 28800,
    });
  } finally {
    if (previousHome === undefined) delete process.env.ANIMA_HOME;
    else process.env.ANIMA_HOME = previousHome;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Slack workspace directory errors surface to callers', async () => {
  const client = fakeSlackApi({
    users: {
      list: async () => {
        throw new Error('not_in_channel');
      },
    },
  });

  await assert.rejects(() => new SlackWorkspaceDirectoryService({ client }).getUserByHandle('alice'), /not_in_channel/);
});

type FakeSlackClient = {
  conversations: {
    info: WebClient['conversations']['info'];
    list: WebClient['conversations']['list'];
    members?: WebClient['conversations']['members'];
    open: WebClient['conversations']['open'];
  };
  team: {
    info: WebClient['team']['info'];
  };
  users: {
    info: WebClient['users']['info'];
    list: WebClient['users']['list'];
  };
};

function fakeSlackApi(input: {
  conversations?: Partial<FakeSlackClient['conversations']>;
  users?: Partial<FakeSlackClient['users']>;
} = {}): WebClient {
  return {
    conversations: {
      info: async () => ({ ok: true }),
      list: async () => ({ channels: [], ok: true }),
      open: async () => ({ channel: { id: 'D123' }, ok: true }),
      ...input.conversations,
    },
    team: {
      info: async () => ({ ok: true, team: {} }),
    },
    users: {
      info: async () => ({ ok: true }),
      list: async () => ({ members: [], ok: true }),
      ...input.users,
    },
  } as unknown as WebClient;
}
