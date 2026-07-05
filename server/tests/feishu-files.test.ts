import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFeishuAgentConfig } from './helpers/harness.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createFeishuMessageClient } from '../feishu/client.js';
import { runFileSend } from '../tools/file-send.js';
import { runFileFetch } from '../tools/files-cli.js';
import { runMessageRead } from '../tools/message-read.js';
import { withAnimaHome } from './anima-home.js';
import { allActivities, loadState } from './helpers/state.js';
import type { FeishuFileSendInput, FeishuFileUploadInput, FeishuMessageResourceDownloadInput, FeishuTextSendInput } from '../feishu/client.js';
import type { FeishuConfig } from '../../shared/agent-config.js';

test('Feishu file uploads use image and file SDK endpoints', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedImage: unknown;
  let capturedFile: unknown;

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          file: {
            async create(input) {
              capturedFile = input;
              return { data: { file_key: 'file_key_doc' } };
            },
          },
          image: {
            async create(input) {
              capturedImage = input;
              return { data: { image_key: 'image_key_photo' } };
            },
          },
          message: {
            async create() {
              throw new Error('unexpected create call');
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

  const image = await client.uploadFile({
    bytes: Buffer.from('fake-image'),
    filename: 'photo.png',
    mimetype: 'image/png',
  });
  const file = await client.uploadFile({
    bytes: Buffer.from('fake-pdf'),
    filename: 'report.pdf',
    mimetype: 'application/pdf',
  });

  assert.deepEqual(image, { fileKey: 'image_key_photo', kind: 'image' });
  assert.deepEqual(file, { fileKey: 'file_key_doc', kind: 'file' });
  assert.deepEqual(capturedImage, {
    data: {
      image: Buffer.from('fake-image'),
      image_type: 'message',
    },
  });
  assert.deepEqual(capturedFile, {
    data: {
      file: Buffer.from('fake-pdf'),
      file_name: 'report.pdf',
      file_type: 'pdf',
    },
  });
});

test('Feishu uploaded files can be sent to chats and topics', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  const creates: unknown[] = [];
  const replies: unknown[] = [];

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create(input) {
              creates.push(input);
              return { data: { chat_id: 'oc_test_chat', message_id: 'om_file' } };
            },
            async reply(input) {
              replies.push(input);
              return { data: { chat_id: 'oc_test_chat', message_id: 'om_image', thread_id: 'omt_topic' } };
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

  const fileResult = await client.sendUploadedFile({
    file: { fileKey: 'file_key_report', kind: 'file' },
    receiveId: 'oc_test_chat',
    receiveIdType: 'chat_id',
  });
  const imageResult = await client.sendUploadedFile({
    file: { fileKey: 'image_key_photo', kind: 'image' },
    receiveId: 'oc_test_chat',
    receiveIdType: 'chat_id',
    threadMessageId: 'om_topic_root',
  });

  assert.deepEqual(creates, [{
    data: {
      content: JSON.stringify({ file_key: 'file_key_report' }),
      msg_type: 'file',
      receive_id: 'oc_test_chat',
    },
    params: {
      receive_id_type: 'chat_id',
    },
  }]);
  assert.deepEqual(replies, [{
    data: {
      content: JSON.stringify({ image_key: 'image_key_photo' }),
      msg_type: 'image',
      reply_in_thread: true,
    },
    path: {
      message_id: 'om_topic_root',
    },
  }]);
  assert.deepEqual(fileResult, { chatId: 'oc_test_chat', messageId: 'om_file' });
  assert.deepEqual(imageResult, { chatId: 'oc_test_chat', messageId: 'om_image', threadId: 'omt_topic' });
});

test('file send can upload to a Feishu chat explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-file-send-test-'));
  const logLines: string[] = [];
  const order: string[] = [];
  const uploads: FeishuFileUploadInput[] = [];
  const fileSends: FeishuFileSendInput[] = [];
  const captions: FeishuTextSendInput[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      const localPath = join(stateDir, 'evidence.png');
      await writeFile(localPath, Buffer.from('fake-png-bytes'));

      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runFileSend(
        {
          agent: 'scout',
          caption: 'see attached',
          channel: 'oc_target_chat',
          paths: [localPath],
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
                return {};
              },
              async sendPost() {
                return {};
              },
              async sendUploadedFile(input) {
                order.push('send-file');
                fileSends.push(input);
                return { chatId: 'oc_target_chat', messageId: 'om_file' };
              },
              async sendText(input) {
                order.push('caption');
                captions.push(input);
                return { chatId: 'oc_target_chat', messageId: 'om_caption' };
              },
              async uploadFile(input) {
                order.push('upload');
                uploads.push(input);
                return { fileKey: 'image_key_evidence', kind: 'image' };
              },
            };
          },
        },
      );

      const completed = allActivities(await loadState()).at(-1);
      assert.equal(completed?.type, 'external.effect.completed');
      assert.equal(completed?.payload?.['effect'], 'feishu.file.send');
      assert.equal(completed?.payload?.['tool'], 'anima.file.send');
      assert.equal(completed?.payload?.['platform'], 'feishu');
      assert.equal(completed?.payload?.['receiveId'], 'oc_target_chat');
      assert.equal(completed?.payload?.['receiveIdType'], 'chat_id');
      assert.equal(completed?.payload?.['fileCount'], 1);
      assert.equal(completed?.payload?.['caption'], 'see attached');
      assert.equal(completed?.payload?.['captionMessageId'], 'om_caption');
      const completedUploads = completed?.payload?.['uploads'] as Array<Record<string, unknown>>;
      assert.equal(completedUploads.length, 1);
      assert.equal(completedUploads[0]?.['fileId'], 'image_key_evidence');
      assert.equal(completedUploads[0]?.['kind'], 'image');
      assert.equal(completedUploads[0]?.['messageId'], 'om_file');
      assert.equal(completedUploads[0]?.['mimetype'], 'image/png');
    });

    assert.deepEqual(order, ['upload', 'send-file', 'caption']);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]?.filename, 'evidence.png');
    assert.equal(uploads[0]?.mimetype, 'image/png');
    assert.equal(uploads[0]?.bytes.toString(), 'fake-png-bytes');
    assert.deepEqual(fileSends, [{
      file: { fileKey: 'image_key_evidence', kind: 'image' },
      receiveId: 'oc_target_chat',
      receiveIdType: 'chat_id',
    }]);
    assert.deepEqual(captions, [{
      receiveId: 'oc_target_chat',
      receiveIdType: 'chat_id',
      text: 'see attached',
    }]);
    assert.match(logLines.join('\n'), /uploaded successfully\. feishu chat_id=oc_target_chat, files=1\./);
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu message resources can be downloaded from the SDK stream', async () => {
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
          messageResource: {
            async get(input) {
              capturedGet = input;
              return {
                getReadableStream() {
                  return Readable.from([Buffer.from('downloaded-image')]);
                },
                headers: {
                  'Content-Disposition': 'attachment; filename="photo.png"',
                  'Content-Type': 'image/png',
                },
              };
            },
          },
        },
      };
    },
  });

  const downloaded = await client.downloadMessageResource({
    fileKey: 'image_key_photo',
    messageId: 'om_photo',
    resourceType: 'image',
  });

  assert.deepEqual(capturedGet, {
    params: {
      type: 'image',
    },
    path: {
      file_key: 'image_key_photo',
      message_id: 'om_photo',
    },
  });
  assert.equal(downloaded.bytes.toString(), 'downloaded-image');
  assert.equal(downloaded.contentType, 'image/png');
  assert.equal(downloaded.filename, 'photo.png');
});

test('message read emits Feishu file resource ids for fetch', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-message-read-files-test-'));
  const logLines: string[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runMessageRead(
        { agent: 'scout', channel: 'oc_target_chat', limit: 2 },
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
                return {
                  hasMore: false,
                  messages: [{
                    bodyContent: JSON.stringify({ file_key: 'file_key_report', file_name: 'report.pdf', file_size: '42' }),
                    chatId: 'oc_target_chat',
                    createTime: '1780410000000',
                    messageId: 'om_file_message',
                    messageType: 'file',
                    sender: {
                      id: 'ou_alice',
                      senderName: 'Alice',
                      senderType: 'user',
                    },
                  }, {
                    bodyContent: JSON.stringify({ image_key: 'image_key_photo' }),
                    chatId: 'oc_target_chat',
                    createTime: '1780410001000',
                    messageId: 'om_image_message',
                    messageType: 'image',
                    sender: {
                      id: 'ou_bob',
                      senderName: 'Bob',
                      senderType: 'user',
                    },
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
    });

    const output = logLines.join('\n');
    assert.match(output, /attached: id=feishu:message:om_file_message:file:file_key_report name=report\.pdf size_bytes=42/);
    assert.match(output, /use `anima file fetch feishu:message:om_file_message:file:file_key_report` to download/);
    assert.match(output, /attached: id=feishu:message:om_image_message:image:image_key_photo/);
    assert.match(output, /use `anima file fetch feishu:message:om_image_message:image:image_key_photo` to download/);
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('file fetch can download a Feishu message resource id', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-file-fetch-test-'));
  const logLines: string[] = [];
  const downloads: FeishuMessageResourceDownloadInput[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuAgentConfig(stateDir);
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runFileFetch(
        {
          agent: 'scout',
          file: 'feishu:message:om_file_message:file:file_key_report',
        },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource(input) {
                downloads.push(input);
                return {
                  bytes: Buffer.from('downloaded-report'),
                  contentType: 'application/pdf',
                  filename: 'report.pdf',
                };
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

      const firstPath = logLines.at(-1);
      assert.ok(firstPath);
      assert.equal(await readFile(firstPath, 'utf8'), 'downloaded-report');

      await runFileFetch(
        {
          agent: 'scout',
          file: 'feishu:message:om_file_message:file:file_key_report',
        },
        {
          createFeishuMessageClient() {
            throw new Error('cached Feishu fetch should not call the API again');
          },
        },
      );
      assert.equal(logLines.at(-1), firstPath);
    });

    assert.deepEqual(downloads, [{
      fileKey: 'file_key_report',
      messageId: 'om_file_message',
      resourceType: 'file',
    }]);
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});
