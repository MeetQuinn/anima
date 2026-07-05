import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFeishuAgentConfig } from './helpers/harness.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuMessageClient, fetchFeishuAppScopes } from '../feishu/client.js';
import { AgentFeishuService } from '../agents/agent-feishu.service.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { feishuTranscriptOutput } from '../tools/feishu-transcript.js';
import { runMessageRead } from '../tools/message-read.js';
import { runMessageReact } from '../tools/reactions.js';
import { runMessageSend, runMessageUpdate } from '../tools/messages.js';
import { withAnimaHome } from './anima-home.js';
import { allActivities, loadState } from './helpers/state.js';
import { FEISHU_RECOMMENDED_SCOPE_NAMES } from '../../shared/agent-config.js';
import type { FeishuMessageListInput, FeishuPostSendInput, FeishuPostUpdateInput, FeishuReactionAddInput, FeishuReactionRemoveInput } from '../feishu/client.js';
import type { FeishuConfig } from '../../shared/agent-config.js';
import { testFeishuMessageClient, jsonResponse, escapeRegExp } from './helpers/feishu.js';

test('Feishu text sends can post ordinary chat messages', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedCreate: unknown;

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create(input) {
              capturedCreate = input;
              return { data: { chat_id: 'oc_test_chat', message_id: 'om_reply' } };
            },
            async reply() {
              throw new Error('unexpected reply call');
            },
          },
          messageReaction: {
            async create() {
              throw new Error('unexpected reaction create call');
            },
            async delete() {
              throw new Error('unexpected reaction delete call');
            },
          },
        },
      };
    },
  });

  const result = await client.sendText({ chatId: 'oc_test_chat', text: 'hello reply' });

  assert.deepEqual(capturedCreate, {
    data: {
      content: JSON.stringify({ text: 'hello reply' }),
      msg_type: 'text',
      receive_id: 'oc_test_chat',
    },
    params: {
      receive_id_type: 'chat_id',
    },
  });
  assert.deepEqual(result, {
    chatId: 'oc_test_chat',
    messageId: 'om_reply',
  });
});

test('Feishu text sends can target a user open_id', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedCreate: unknown;

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create(input) {
              capturedCreate = input;
              return { data: { chat_id: 'oc_owner_dm', message_id: 'om_owner_hello' } };
            },
            async reply() {
              throw new Error('unexpected reply call');
            },
          },
          messageReaction: {
            async create() {
              throw new Error('unexpected reaction create call');
            },
            async delete() {
              throw new Error('unexpected reaction delete call');
            },
          },
        },
      };
    },
  });

  const result = await client.sendText({
    receiveId: 'ou_owner',
    receiveIdType: 'open_id',
    text: 'hello owner',
  });

  assert.deepEqual(capturedCreate, {
    data: {
      content: JSON.stringify({ text: 'hello owner' }),
      msg_type: 'text',
      receive_id: 'ou_owner',
    },
    params: {
      receive_id_type: 'open_id',
    },
  });
  assert.deepEqual(result, {
    chatId: 'oc_owner_dm',
    messageId: 'om_owner_hello',
  });
});

test('Feishu text replies can post in a message topic', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedReply: unknown;

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() {
              throw new Error('unexpected create call');
            },
            async reply(input) {
              capturedReply = input;
              return { data: { chat_id: 'oc_test_chat', message_id: 'om_reply', thread_id: 'omt_topic' } };
            },
          },
          messageReaction: {
            async create() {
              throw new Error('unexpected reaction create call');
            },
            async delete() {
              throw new Error('unexpected reaction delete call');
            },
          },
        },
      };
    },
  });

  const result = await client.replyText({
    messageId: 'om_test_message',
    replyInThread: true,
    text: 'topic reply',
  });

  assert.deepEqual(capturedReply, {
    data: {
      content: JSON.stringify({ text: 'topic reply' }),
      msg_type: 'text',
      reply_in_thread: true,
    },
    path: {
      message_id: 'om_test_message',
    },
  });
  assert.deepEqual(result, {
    chatId: 'oc_test_chat',
    messageId: 'om_reply',
    threadId: 'omt_topic',
  });
});

test('Feishu message reads can list chat history', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedList: unknown;

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() {
              throw new Error('unexpected create call');
            },
            async list(input) {
              capturedList = input;
              return {
                data: {
                  has_more: true,
                  items: [{
                    body: { content: JSON.stringify({ text: 'hello @_user_1' }) },
                    chat_id: 'oc_test_chat',
                    create_time: '1780410000000',
                    mentions: [{ id: 'ou_bob', id_type: 'open_id', key: '@_user_1', name: 'Bob' }],
                    message_id: 'om_test_message',
                    msg_type: 'text',
                    sender: {
                      id: 'ou_alice',
                      id_type: 'open_id',
                      sender_name: 'Alice',
                      sender_type: 'user',
                    },
                  }],
                  page_token: 'cursor-next',
                },
              };
            },
            async reply() {
              throw new Error('unexpected reply call');
            },
          },
          messageReaction: {
            async create() {
              throw new Error('unexpected reaction create call');
            },
            async delete() {
              throw new Error('unexpected reaction delete call');
            },
          },
        },
      };
    },
  });

  const result = await client.listMessages({ chatId: 'oc_test_chat', cursor: 'cursor-1', limit: 2 });

  assert.deepEqual(capturedList, {
    params: {
      container_id: 'oc_test_chat',
      container_id_type: 'chat',
      page_size: 2,
      page_token: 'cursor-1',
      sort_type: 'ByCreateTimeDesc',
    },
  });
  assert.deepEqual(result, {
    hasMore: true,
    messages: [{
      bodyContent: JSON.stringify({ text: 'hello @_user_1' }),
      chatId: 'oc_test_chat',
      createTime: '1780410000000',
      mentions: [{ id: 'ou_bob', idType: 'open_id', key: '@_user_1', name: 'Bob' }],
      messageId: 'om_test_message',
      messageType: 'text',
      sender: {
        id: 'ou_alice',
        idType: 'open_id',
        senderName: 'Alice',
        senderType: 'user',
      },
    }],
    nextCursor: 'cursor-next',
  });
});

test('Feishu message reads can list topic history', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedList: unknown;

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() {
              throw new Error('unexpected create call');
            },
            async list(input) {
              capturedList = input;
              return {
                data: {
                  has_more: false,
                  items: [{
                    body: { content: JSON.stringify({ text: 'topic reply' }) },
                    chat_id: 'oc_test_chat',
                    create_time: '1780410000000',
                    message_id: 'om_topic_reply',
                    msg_type: 'text',
                    parent_id: 'om_topic_root',
                    root_id: 'om_topic_root',
                    thread_id: 'omt_topic',
                  }],
                },
              };
            },
            async reply() {
              throw new Error('unexpected reply call');
            },
          },
          messageReaction: {
            async create() {
              throw new Error('unexpected reaction create call');
            },
            async delete() {
              throw new Error('unexpected reaction delete call');
            },
          },
        },
      };
    },
  });

  const result = await client.listMessages({
    chatId: 'oc_test_chat',
    cursor: 'cursor-1',
    limit: 2,
    threadId: 'omt_topic',
  });

  assert.deepEqual(capturedList, {
    params: {
      container_id: 'omt_topic',
      container_id_type: 'thread',
      page_size: 2,
      page_token: 'cursor-1',
      sort_type: 'ByCreateTimeDesc',
    },
  });
  assert.deepEqual(result.messages, [{
    bodyContent: JSON.stringify({ text: 'topic reply' }),
    chatId: 'oc_test_chat',
    createTime: '1780410000000',
    messageId: 'om_topic_reply',
    messageType: 'text',
    parentId: 'om_topic_root',
    rootId: 'om_topic_root',
    threadId: 'omt_topic',
  }]);
});

test('Feishu messages can resolve a topic root message to a thread id', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedGet: unknown;

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() {
              throw new Error('unexpected create call');
            },
            async get(input) {
              capturedGet = input;
              return {
                data: {
                  items: [{
                    chat_id: 'oc_test_chat',
                    message_id: 'om_topic_root',
                    msg_type: 'text',
                    thread_id: 'omt_topic',
                  }],
                },
              };
            },
            async reply() {
              throw new Error('unexpected reply call');
            },
          },
          messageReaction: {
            async create() {
              throw new Error('unexpected reaction create call');
            },
            async delete() {
              throw new Error('unexpected reaction delete call');
            },
          },
        },
      };
    },
  });

  const message = await client.getMessage?.({ messageId: 'om_topic_root' });

  assert.deepEqual(capturedGet, {
    path: {
      message_id: 'om_topic_root',
    },
  });
  assert.equal(message?.messageId, 'om_topic_root');
  assert.equal(message?.threadId, 'omt_topic');
});

test('Feishu client can fetch chat display info', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  const calls: Array<{ body?: BodyInit | null; headers?: HeadersInit; method?: string; url: string }> = [];

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() { throw new Error('unexpected create call'); },
            async reply() { throw new Error('unexpected reply call'); },
          },
          messageReaction: {
            async create() { throw new Error('unexpected reaction create call'); },
            async delete() { throw new Error('unexpected reaction delete call'); },
          },
        },
      };
    },
    async fetch(input, init) {
      calls.push({ ...init, url: input.toString() });
      return jsonResponse({
        code: 0,
        data: {
          chat: {
            avatar: 'https://example.test/chat.png',
            chat_id: 'oc_test_chat',
            chat_type: 'group',
            name: '产品群',
          },
        },
      });
    },
    async fetchFeishuTenantAccessToken() {
      return { tenantAccessToken: 't-test' };
    },
  });

  assert.deepEqual(await client.getChat?.({ chatId: 'oc_test_chat' }), {
    avatarUrl: 'https://example.test/chat.png',
    chatId: 'oc_test_chat',
    chatName: '产品群',
    chatType: 'group',
  });
  assert.deepEqual(calls, [{
    headers: {
      Authorization: 'Bearer t-test',
      'Content-Type': 'application/json; charset=utf-8',
    },
    method: 'GET',
    url: 'https://open.feishu.cn/open-apis/im/v1/chats/oc_test_chat',
  }]);
});

test('Feishu OpenAPI requester reuses tenant tokens until expiry and retries rejected mints', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let nowMs = Date.parse('2026-06-03T00:00:00.000Z');
  const minted: string[] = [];
  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() { throw new Error('unexpected create call'); },
            async reply() { throw new Error('unexpected reply call'); },
          },
          messageReaction: {
            async create() { throw new Error('unexpected reaction create call'); },
            async delete() { throw new Error('unexpected reaction delete call'); },
          },
        },
      };
    },
    async fetch(input, init) {
      assert.equal(input.toString(), 'https://open.feishu.cn/open-apis/im/v1/chats/oc_test_chat');
      assert.ok(init);
      const headers = init.headers as Record<string, string>;
      return jsonResponse({
        code: 0,
        data: {
          chat: {
            chat_id: 'oc_test_chat',
            name: headers.Authorization,
          },
        },
      });
    },
    async fetchFeishuTenantAccessToken() {
      const token = `t-${minted.length + 1}`;
      minted.push(token);
      return {
        expiresAt: new Date(nowMs + 120_000).toISOString(),
        tenantAccessToken: token,
      };
    },
    nowMs: () => nowMs,
  });

  assert.equal((await client.getChat?.({ chatId: 'oc_test_chat' }))?.chatName, 'Bearer t-1');
  nowMs += 30_000;
  assert.equal((await client.getChat?.({ chatId: 'oc_test_chat' }))?.chatName, 'Bearer t-1');
  nowMs += 31_000;
  assert.equal((await client.getChat?.({ chatId: 'oc_test_chat' }))?.chatName, 'Bearer t-2');
  assert.deepEqual(minted, ['t-1', 't-2']);

  let attempts = 0;
  const retryClient = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() { throw new Error('unexpected create call'); },
            async reply() { throw new Error('unexpected reply call'); },
          },
          messageReaction: {
            async create() { throw new Error('unexpected reaction create call'); },
            async delete() { throw new Error('unexpected reaction delete call'); },
          },
        },
      };
    },
    async fetch() {
      return jsonResponse({
        code: 0,
        data: {
          chat: {
            chat_id: 'oc_test_chat',
            name: 'retry ok',
          },
        },
      });
    },
    async fetchFeishuTenantAccessToken() {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary mint failure');
      return { tenantAccessToken: 't-retry' };
    },
  });

  assert.ok(retryClient.getChat);
  await assert.rejects(retryClient.getChat({ chatId: 'oc_test_chat' }), /temporary mint failure/);
  assert.equal((await retryClient.getChat?.({ chatId: 'oc_test_chat' }))?.chatName, 'retry ok');
  assert.equal(attempts, 2);
});

test('Feishu client can fetch basic user names by open_id', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  const calls: Array<{ body?: BodyInit | null; headers?: HeadersInit; method?: string; url: string }> = [];

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() { throw new Error('unexpected create call'); },
            async reply() { throw new Error('unexpected reply call'); },
          },
          messageReaction: {
            async create() { throw new Error('unexpected reaction create call'); },
            async delete() { throw new Error('unexpected reaction delete call'); },
          },
        },
      };
    },
    async fetch(input, init) {
      calls.push({ ...init, url: input.toString() });
      return jsonResponse({
        code: 0,
        data: {
          users: [{
            i18n_name: { en_us: 'Alice', zh_cn: '艾丽丝' },
            name: 'Alice',
            user_id: 'ou_alice',
          }],
        },
      });
    },
    async fetchFeishuTenantAccessToken() {
      return { tenantAccessToken: 't-test' };
    },
  });

  assert.deepEqual(await client.getUserBasics?.({ openIds: ['ou_alice'] }), [{
    i18nName: { en_us: 'Alice', zh_cn: '艾丽丝' },
    name: 'Alice',
    openId: 'ou_alice',
  }]);
  assert.deepEqual(calls, [{
    body: JSON.stringify({ user_ids: ['ou_alice'] }),
    headers: {
      Authorization: 'Bearer t-test',
      'Content-Type': 'application/json; charset=utf-8',
    },
    method: 'POST',
    url: 'https://open.feishu.cn/open-apis/contact/v3/users/basic_batch?user_id_type=open_id',
  }]);
});

test('Feishu client can fetch tenant scope grant status', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  const calls: Array<{ body?: BodyInit | null; headers?: HeadersInit; method?: string; url: string }> = [];

  const scopes = await fetchFeishuAppScopes(config, {
    async fetch(input, init) {
      calls.push({ ...init, url: input.toString() });
      return jsonResponse({
        code: 0,
        data: {
          scopes: [{
            grant_status: 1,
            scope_name: 'contact:user.basic_profile:readonly',
          }, {
            grant_status: 2,
            scope_name: 'im:message:readonly',
          }],
        },
      });
    },
    async fetchFeishuTenantAccessToken() {
      return { tenantAccessToken: 't-test' };
    },
  });

  assert.deepEqual(scopes, [{
    granted: true,
    grantStatus: 1,
    scopeName: 'contact:user.basic_profile:readonly',
  }, {
    granted: false,
    grantStatus: 2,
    scopeName: 'im:message:readonly',
  }]);
  assert.deepEqual(calls, [{
    headers: {
      Authorization: 'Bearer t-test',
      'Content-Type': 'application/json; charset=utf-8',
    },
    method: 'GET',
    url: 'https://open.feishu.cn/open-apis/application/v6/scopes',
  }]);
});

test('Feishu service reports missing recommended scopes with authorization link', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-scope-status-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      const service = new AgentFeishuService('scout', {
        async getFeishuAppScopes() {
          return [{
            granted: true,
            grantStatus: 1,
            scopeName: 'im:message:readonly',
          }];
        },
      });

      const status = await service.getScopeStatus();

      assert.equal(status.connected, true);
      assert.equal(status.appId, 'cli_test');
      assert.equal(status.profileName.state, 'missing');
      assert.equal(status.profileName.granted, false);
      assert.equal(status.profileName.scope, 'contact:user.basic_profile:readonly');
      assert.match(
        status.profileName.authUrl ?? '',
        /^https:\/\/open\.feishu\.cn\/app\/cli_test\/auth\?/,
      );
      assert.match(status.profileName.authUrl ?? '', /contact%3Auser\.basic_profile%3Areadonly/);
      assert.equal(status.recommended.state, 'missing');
      assert.equal(status.recommended.granted, false);
      assert.deepEqual(status.recommended.missingScopes, FEISHU_RECOMMENDED_SCOPE_NAMES);
      assert.equal(FEISHU_RECOMMENDED_SCOPE_NAMES.length, 97);
      assert.ok(status.recommended.missingScopes.includes('im:message.group_msg'));
      assert.ok(status.recommended.missingScopes.includes('im:message.group_at_msg.include_bot:readonly'));
      assert.ok(status.recommended.missingScopes.includes('drive:drive'));
      assert.ok(status.recommended.missingScopes.includes('space:folder:create'));
      assert.ok(status.recommended.missingScopes.includes('docx:document'));
      assert.ok(status.recommended.missingScopes.includes('bitable:app'));
      assert.ok(status.recommended.missingScopes.includes('wiki:wiki'));
      assert.ok(!status.recommended.missingScopes.includes('bitable:bitable'));
      assert.ok(!status.recommended.missingScopes.includes('bitable:bitable:readonly'));
      assert.ok(!status.recommended.missingScopes.includes('docs:docs:operate_as_user'));
      assert.ok(!status.recommended.missingScopes.includes('docs:permission.member:read'));
      assert.ok(!status.recommended.missingScopes.includes('docs:permission.public:read'));
      assert.ok(!status.recommended.missingScopes.includes('im:message.bot_event:read'));
      assert.ok(!status.recommended.missingScopes.includes('docs:permission.member:apply'));
      assert.ok(!status.recommended.missingScopes.includes('docs:secure_label:readonly'));
      assert.ok(!status.recommended.missingScopes.includes('docs:secure_label:write_only'));
      assert.ok(!status.recommended.missingScopes.includes('drive:quota_detail:read_one'));
      assert.equal(new Set(FEISHU_RECOMMENDED_SCOPE_NAMES).size, FEISHU_RECOMMENDED_SCOPE_NAMES.length);
      assert.equal(status.recommended.scopes.length, FEISHU_RECOMMENDED_SCOPE_NAMES.length);
      assert.match(
        status.recommended.authUrl ?? '',
        /^https:\/\/open\.feishu\.cn\/app\/cli_test\/auth\?/,
      );
      assert.deepEqual(
        status.recommended.authUrls?.map((link) => link.label),
        [
          'Core chat and teammates',
          'Base and whiteboards',
          'Docs',
          'Sheets and Slides',
          'Drive spaces and Wiki',
        ],
      );
      assert.equal(status.recommended.authUrl, status.recommended.authUrls?.[0]?.authUrl);
      const allAuthScopes = [...new Set((status.recommended.authUrls ?? []).flatMap((link) => link.scopes))].sort();
      assert.deepEqual(allAuthScopes, [...FEISHU_RECOMMENDED_SCOPE_NAMES].sort());
      const allAuthUrls = (status.recommended.authUrls ?? []).map((link) => link.authUrl).join('\n');
      for (const scope of FEISHU_RECOMMENDED_SCOPE_NAMES) {
        assert.match(allAuthUrls, new RegExp(escapeRegExp(encodeURIComponent(scope))));
      }
      for (const scope of [
        'docs:permission.member:apply',
        'docs:secure_label:readonly',
        'docs:secure_label:write_only',
        'drive:quota_detail:read_one',
        'bitable:bitable',
        'bitable:bitable:readonly',
        'docs:docs:operate_as_user',
        'docs:permission.member:read',
        'docs:permission.public:read',
        'im:message.bot_event:read',
      ]) {
        assert.ok(!allAuthScopes.includes(scope));
      }
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu service keeps profile-name compatibility while recommended scopes are missing', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-scope-granted-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      const service = new AgentFeishuService('scout', {
        async getFeishuAppScopes() {
          return [{
            granted: true,
            grantStatus: 1,
            scopeName: 'contact:user.basic_profile:readonly',
          }];
        },
      });

      const status = await service.getScopeStatus();

      assert.equal(status.profileName.state, 'granted');
      assert.equal(status.profileName.granted, true);
      assert.equal(status.profileName.authUrl, undefined);
      assert.equal(status.recommended.state, 'missing');
      assert.equal(status.recommended.granted, false);
      assert.deepEqual(
        status.recommended.missingScopes,
        FEISHU_RECOMMENDED_SCOPE_NAMES.filter((scope) => scope !== 'contact:user.basic_profile:readonly'),
      );
      assert.match(status.recommended.authUrl ?? '', /im%3Achat\.members%3Awrite_only/);
      assert.deepEqual(
        [...new Set((status.recommended.authUrls ?? []).flatMap((link) => link.scopes))].sort(),
        [...status.recommended.missingScopes].sort(),
      );
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu service reports granted recommended scopes', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-recommended-scopes-granted-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      const service = new AgentFeishuService('scout', {
        async getFeishuAppScopes() {
          return FEISHU_RECOMMENDED_SCOPE_NAMES.map((scopeName) => ({
            granted: true,
            grantStatus: 1,
            scopeName,
          }));
        },
      });

      const status = await service.getScopeStatus();

      assert.equal(status.profileName.state, 'granted');
      assert.equal(status.recommended.state, 'granted');
      assert.equal(status.recommended.granted, true);
      assert.deepEqual(status.recommended.missingScopes, []);
      assert.equal(status.recommended.authUrl, undefined);
      assert.equal(status.recommended.authUrls, undefined);
      assert.deepEqual(status.recommended.scopes.map((scope) => scope.scope), FEISHU_RECOMMENDED_SCOPE_NAMES);
      assert.deepEqual(status.recommended.scopes.map((scope) => scope.granted), FEISHU_RECOMMENDED_SCOPE_NAMES.map(() => true));
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu message updates use the SDK update endpoint', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedUpdate: unknown;

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() {
              throw new Error('unexpected create call');
            },
            async reply() {
              throw new Error('unexpected reply call');
            },
            async update(input) {
              capturedUpdate = input;
              return {
                data: {
                  chat_id: 'oc_test_chat',
                  message_id: 'om_target_message',
                  thread_id: 'omt_topic',
                },
              };
            },
          },
          messageReaction: {
            async create() {
              throw new Error('unexpected reaction create call');
            },
            async delete() {
              throw new Error('unexpected reaction delete call');
            },
          },
        },
      };
    },
  });

  const result = await client.updatePost?.({
    content: {
      zh_cn: {
        content: [[{ tag: 'text', text: 'updated post' }]],
        title: '',
      },
    },
    messageId: 'om_target_message',
  });

  assert.deepEqual(capturedUpdate, {
    data: {
      content: JSON.stringify({
        zh_cn: {
          content: [[{ tag: 'text', text: 'updated post' }]],
          title: '',
        },
      }),
      msg_type: 'post',
    },
    path: {
      message_id: 'om_target_message',
    },
  });
  assert.deepEqual(result, {
    chatId: 'oc_test_chat',
    messageId: 'om_target_message',
    threadId: 'omt_topic',
  });
});

test('message read can fetch Feishu chat history explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-message-read-test-'));
  const reads: FeishuMessageListInput[] = [];
  const logLines: string[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runMessageRead(
        { agent: 'scout', channel: 'oc_target_chat', cursor: 'cursor-1', limit: 2 },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async getChat(input) {
                assert.deepEqual(input, { chatId: 'oc_target_chat' });
                return { chatId: 'oc_target_chat', chatName: '产品群', chatType: 'group' };
              },
              async listMessages(input) {
                reads.push(input);
                return {
                  hasMore: true,
                  messages: [{
                    bodyContent: JSON.stringify({ text: 'hello @_user_1' }),
                    chatId: 'oc_target_chat',
                    createTime: '1780410000000',
                    mentions: [{ id: 'ou_bob', idType: 'open_id', key: '@_user_1', name: 'Bob' }],
                    messageId: 'om_test_message',
                    messageType: 'text',
                    sender: {
                      id: 'ou_alice',
                      idType: 'open_id',
                      senderName: 'Alice',
                      senderType: 'user',
                    },
                  }],
                  nextCursor: 'cursor-next',
                };
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async replyPost() {
                return {};
              },
              async sendPost() {
                return {};
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendText() {
                throw new Error('unexpected send');
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );
      const completed = allActivities(await loadState())
        .filter((activity) => activity.type === 'tool.call.completed')
        .at(-1);
      assert.equal(completed?.payload?.['channelDisplayName'], '产品群');
      assert.equal(completed?.payload?.['channelName'], '产品群');
    });

    assert.deepEqual(reads, [{ chatId: 'oc_target_chat', cursor: 'cursor-1', limit: 2 }]);
    const output = logLines.join('\n');
    assert.match(
      output,
      /\[platform=feishu chat_id=oc_target_chat chat_name="产品群" message_id=om_test_message time=2026-06-02T14:20:00\.000Z user_id=ou_alice\] Alice: hello @Bob/,
    );
    assert.match(output, /\[page has_more=true next_cursor=cursor-next\]/);
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message read renders Feishu rich text post history', () => {
  const output = feishuTranscriptOutput(
    [{
      bodyContent: JSON.stringify({
        zh_cn: {
          content: [
            [
              { tag: 'text', text: 'read the ' },
              { href: 'https://example.com/doc', tag: 'a', text: 'doc' },
            ],
            [
              { tag: 'at', user_id: 'ou_bob', user_name: 'Bob' },
              { tag: 'text', text: ' owns this' },
            ],
          ],
          title: 'Rich note',
        },
      }),
      chatId: 'oc_target_chat',
      createTime: '1780410000000',
      messageId: 'om_post_message',
      messageType: 'post',
      sender: {
        id: 'ou_alice',
        idType: 'open_id',
        senderName: 'Alice',
        senderType: 'user',
      },
    }],
    { chatId: 'oc_target_chat', limit: 1 },
    { hasMore: false, nextCursor: '' },
  );

  assert.match(
    output,
    /\[platform=feishu chat_id=oc_target_chat message_id=om_post_message time=2026-06-02T14:20:00\.000Z user_id=ou_alice\] Alice: Rich note\nread the doc \(https:\/\/example\.com\/doc\)\n@Bob owns this/,
  );
});

test('message read can fetch Feishu topic history explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-topic-read-test-'));
  const reads: FeishuMessageListInput[] = [];
  const logLines: string[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runMessageRead(
        { agent: 'scout', channel: 'oc_target_chat', limit: 2, threadTs: 'om_topic_root' },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async getMessage(input) {
                assert.deepEqual(input, { messageId: 'om_topic_root' });
                return {
                  chatId: 'oc_target_chat',
                  messageId: 'om_topic_root',
                  threadId: 'omt_topic',
                };
              },
              async listMessages(input) {
                reads.push(input);
                return {
                  hasMore: false,
                  messages: [{
                    bodyContent: JSON.stringify({ text: 'topic reply' }),
                    chatId: 'oc_target_chat',
                    createTime: '1780410000000',
                    messageId: 'om_topic_reply',
                    messageType: 'text',
                    parentId: 'om_topic_root',
                    rootId: 'om_topic_root',
                    sender: {
                      id: 'ou_alice',
                      idType: 'open_id',
                      senderName: 'Alice',
                      senderType: 'user',
                    },
                    threadId: 'omt_topic',
                  }],
                };
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async replyPost() {
                return {};
              },
              async sendPost() {
                return {};
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendText() {
                throw new Error('unexpected send');
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );

      const completed = allActivities(await loadState())
        .filter((activity) => activity.type === 'tool.call.completed')
        .at(-1);
      assert.equal(completed?.payload?.['tool'], 'anima.message.read');
      assert.equal(completed?.payload?.['platform'], 'feishu');
      assert.equal(completed?.payload?.['channel'], 'oc_target_chat');
      assert.equal(completed?.payload?.['channelKind'], 'topic');
      assert.equal(completed?.payload?.['threadId'], 'omt_topic');
      assert.equal(completed?.payload?.['threadTs'], 'om_topic_root');
      assert.equal(completed?.payload?.['targetTs'], 'om_topic_root');
    });

    assert.deepEqual(reads, [{ chatId: 'oc_target_chat', limit: 2, threadId: 'omt_topic' }]);
    const output = logLines.join('\n');
    assert.match(
      output,
      /\[platform=feishu chat_id=oc_target_chat thread_id=omt_topic message_id=om_topic_reply time=2026-06-02T14:20:00\.000Z user_id=ou_alice\] Alice: topic reply/,
    );
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send can target a Feishu chat explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-explicit-chat-test-'));
  const sent: FeishuPostSendInput[] = [];
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      await runMessageSend(
        { agent: 'scout', channel: 'oc_target_chat', text: 'hello <mention open_id="ou_alice">Alice</mention>' },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async listMessages() {
                throw new Error('unexpected message read');
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async replyPost() {
                throw new Error('unexpected topic reply post');
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendPost(input) {
                sent.push(input);
                return { chatId: 'oc_target_chat', messageId: 'om_sent' };
              },
              async sendText() {
                throw new Error('unexpected plain text send');
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.receiveId, 'oc_target_chat');
    assert.equal(sent[0]?.receiveIdType, 'chat_id');
    assert.deepEqual(sent[0]?.content.zh_cn.content, [[
      { tag: 'text', text: 'hello ' },
      { tag: 'at', user_id: 'ou_alice' },
    ]]);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send to explicit Feishu chat does not inherit active DM labels', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-explicit-chat-label-test-'));
  const previousItemId = process.env.ANIMA_INBOX_ITEM_ID;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      const now = '2026-06-02T14:20:00.000Z';
      await new WakeQueueService('scout').enqueue({
        chatId: 'oc_dm_chat',
        chatType: 'p2p',
        handling: { createdAt: now, queuedAt: now, status: 'queued', updatedAt: now },
        id: 'feishu:tenant_test:oc_dm_chat:om_dm_message',
        kind: 'feishu',
        messageId: 'om_dm_message',
        receivedAt: now,
        tenantKey: 'tenant_test',
        text: 'create a group',
      });
      process.env.ANIMA_INBOX_ITEM_ID = 'feishu:tenant_test:oc_dm_chat:om_dm_message';

      await runMessageSend(
        { agent: 'scout', channel: 'oc_new_group', text: 'hello group' },
        {
          createFeishuMessageClient() {
            return testFeishuMessageClient({
              async sendPost(input) {
                assert.equal(input.receiveId, 'oc_new_group');
                assert.equal(input.receiveIdType, 'chat_id');
                return { chatId: 'oc_new_group', messageId: 'om_sent' };
              },
            });
          },
        },
      );

      const completed = allActivities(await loadState()).at(-1);
      assert.equal(completed?.type, 'external.effect.completed');
      assert.equal(completed?.payload?.['effect'], 'feishu.message.send');
      assert.equal(completed?.payload?.['receiveId'], 'oc_new_group');
      assert.equal(completed?.payload?.['receiveIdType'], 'chat_id');
      assert.equal(completed?.payload?.['channelDisplayName'], 'Feishu chat');
      assert.equal(completed?.payload?.['channelKind'], undefined);
    });
  } finally {
    if (previousItemId === undefined) delete process.env.ANIMA_INBOX_ITEM_ID;
    else process.env.ANIMA_INBOX_ITEM_ID = previousItemId;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message update can edit a Feishu message explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-message-update-test-'));
  const updates: FeishuPostUpdateInput[] = [];
  const logLines: string[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runMessageUpdate(
        {
          agent: 'scout',
          channel: 'oc_target_chat',
          messageTs: 'om_target_message',
          text: 'Updated **Feishu** message.',
        },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async listMessages() {
                throw new Error('unexpected message read');
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async replyPost() {
                throw new Error('unexpected topic reply post');
              },
              async sendPost() {
                throw new Error('unexpected ordinary send post');
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendText() {
                throw new Error('unexpected ordinary send');
              },
              async updatePost(input) {
                updates.push(input);
                return { chatId: 'oc_target_chat', messageId: 'om_target_message' };
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );

      const completed = allActivities(await loadState())
        .filter((activity) => activity.type === 'external.effect.completed')
        .at(-1);
      assert.equal(completed?.payload?.['effect'], 'feishu.message.update');
      assert.equal(completed?.payload?.['tool'], 'anima.message.update');
      assert.equal(completed?.payload?.['platform'], 'feishu');
      assert.equal(completed?.payload?.['channel'], 'oc_target_chat');
      assert.equal(completed?.payload?.['messageId'], 'om_target_message');
      assert.equal(completed?.payload?.['targetTs'], 'om_target_message');
      assert.equal(completed?.payload?.['status'], 'updated');
      assert.equal(completed?.payload?.['text'], 'Updated **Feishu** message.');
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.messageId, 'om_target_message');
    assert.deepEqual(updates[0]?.content.zh_cn.content, [[
      { tag: 'text', text: 'Updated ' },
      { tag: 'text', text: 'Feishu', style: ['bold'] },
      { tag: 'text', text: ' message.' },
    ]]);
    assert.equal(
      logLines.at(-1),
      'updated successfully. feishu chat_id=oc_target_chat, message_id=om_target_message.',
    );
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send can target a Feishu owner open_id and record greeting delivery', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-owner-send-test-'));
  const sent: Array<{ receiveId: string; receiveIdType: string }> = [];
  const previousItemId = process.env.ANIMA_INBOX_ITEM_ID;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir, {
        ownerGreetingPromptedAt: '2026-01-01T00:00:00.000Z',
        ownerOpenId: 'ou_owner',
      });
      const now = '2026-01-01T00:00:00.000Z';
      await new WakeQueueService('scout').enqueue({
        handling: { createdAt: now, queuedAt: now, status: 'queued', updatedAt: now },
        id: 'feishu-onboarding:scout:ou_owner',
        kind: 'feishu_onboarding',
        owner: { openId: 'ou_owner' },
        receivedAt: now,
        target: {
          platform: 'feishu',
          receiveId: 'ou_owner',
          receiveIdType: 'open_id',
        },
        text: 'Feishu owner greeting prompt',
      });
      process.env.ANIMA_INBOX_ITEM_ID = 'feishu-onboarding:scout:ou_owner';

      await runMessageSend(
        { agent: 'scout', channel: 'ou_owner', text: 'hello owner' },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async listMessages() {
                throw new Error('unexpected message read');
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async replyPost() {
                throw new Error('unexpected topic reply post');
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendPost(input) {
                sent.push(input);
                return { chatId: 'oc_owner_dm', messageId: 'om_owner_hello' };
              },
              async sendText() {
                throw new Error('unexpected plain text send');
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );

      const stored = await defaultAgentRegistryService.serviceFor('scout').getConfig();
      assert.equal(stored.feishu.ownerGreetingChatId, 'oc_owner_dm');
      assert.equal(stored.feishu.ownerGreetingMessageId, 'om_owner_hello');
      assert.match(stored.feishu.ownerGreetingDeliveredAt ?? '', /^\d{4}-/);
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.receiveId, 'ou_owner');
    assert.equal(sent[0]?.receiveIdType, 'open_id');
  } finally {
    if (previousItemId === undefined) {
      delete process.env.ANIMA_INBOX_ITEM_ID;
    } else {
      process.env.ANIMA_INBOX_ITEM_ID = previousItemId;
    }
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send can target a Feishu topic explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-explicit-topic-test-'));
  const replies: Array<{ messageId: string; replyInThread: boolean }> = [];
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      await runMessageSend(
        { agent: 'scout', channel: 'oc_target_chat', text: 'topic message', threadTs: 'om_topic_root' },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async listMessages() {
                throw new Error('unexpected message read');
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected plain text topic reply');
              },
              async replyPost(input) {
                replies.push(input);
                return { chatId: 'oc_target_chat', messageId: 'om_sent', threadId: 'omt_topic' };
              },
              async sendPost() {
                throw new Error('unexpected ordinary send post');
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendText() {
                throw new Error('unexpected ordinary send');
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );
    });

    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.messageId, 'om_topic_root');
    assert.equal(replies[0]?.replyInThread, true);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message react can add a Feishu reaction by message id', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-reaction-add-test-'));
  const adds: FeishuReactionAddInput[] = [];
  const logLines: string[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runMessageReact(
        {
          agent: 'scout',
          channel: 'oc_target_chat',
          messageId: 'om_target_message',
          name: 'Thumbsup',
        },
        {
          createFeishuMessageClient() {
            return {
              async addReaction(input) {
                adds.push(input);
                return { reactionId: 'reaction_1' };
              },
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async listMessages() {
                throw new Error('unexpected message read');
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async replyPost() {
                return {};
              },
              async sendPost() {
                return {};
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendText() {
                throw new Error('unexpected send');
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );

      const activities = allActivities(await loadState());
      const completed = activities
        .filter((activity) => activity.type === 'external.effect.completed')
        .at(-1);
      assert.equal(completed?.payload?.['effect'], 'feishu.reaction');
      assert.equal(completed?.payload?.['tool'], 'anima.message.react');
      assert.equal(completed?.payload?.['platform'], 'feishu');
      assert.equal(completed?.payload?.['channel'], 'oc_target_chat');
      assert.equal(completed?.payload?.['messageId'], 'om_target_message');
      assert.equal(completed?.payload?.['targetTs'], 'om_target_message');
      assert.equal(completed?.payload?.['action'], 'added');
      assert.equal(completed?.payload?.['name'], 'Thumbsup');
      assert.equal(completed?.payload?.['reactionId'], 'reaction_1');
    });

    assert.deepEqual(adds, [{ emojiType: 'Thumbsup', messageId: 'om_target_message' }]);
    assert.equal(
      logLines.at(-1),
      'reaction added successfully. feishu chat_id=oc_target_chat, message_id=om_target_message, reaction=Thumbsup, reaction_id=reaction_1.',
    );
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message react can remove a Feishu reaction with a reaction id', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-reaction-remove-test-'));
  const removes: FeishuReactionRemoveInput[] = [];
  const logLines: string[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runMessageReact(
        {
          agent: 'scout',
          channel: 'oc_target_chat',
          messageId: 'om_target_message',
          name: 'Thumbsup',
          reactionId: 'reaction_1',
          remove: true,
        },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async listMessages() {
                throw new Error('unexpected message read');
              },
              async removeReaction(input) {
                removes.push(input);
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async replyPost() {
                return {};
              },
              async sendPost() {
                return {};
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendText() {
                throw new Error('unexpected send');
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );
    });

    assert.deepEqual(removes, [{ messageId: 'om_target_message', reactionId: 'reaction_1' }]);
    assert.equal(
      logLines.at(-1),
      'reaction removed successfully. feishu chat_id=oc_target_chat, message_id=om_target_message, reaction=Thumbsup, reaction_id=reaction_1.',
    );
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message react remove requires reaction id for Feishu messages', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-reaction-validation-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      await assert.rejects(
        () => runMessageReact({
          agent: 'scout',
          channel: 'oc_target_chat',
          messageId: 'om_target_message',
          remove: true,
        }),
        /requires --reaction-id/,
      );
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});
