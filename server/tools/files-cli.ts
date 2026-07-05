import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Command } from 'commander';
import { z } from 'zod';

import { createFeishuMessageClient as createDefaultFeishuMessageClient } from '../feishu/client.js';
import {
  defaultFeishuFileService,
  parseFeishuMessageResourceId,
} from '../feishu/feishu-file.service.js';
import { slackFileFromRaw } from '../slack/slack.helper.js';
import { defaultSlackFileService } from '../slack/slack-file.service.js';
import { normalizeChatTargetOptions } from './chat-target-options.js';
import { runFileSend, type FileSendInputData } from './file-send.js';
import { loadAgentFromOpts, slackWebClientForOpts } from './tool-context.js';

interface FileFetchInputData {
  agent?: string;
  file?: string;
  fileId?: string;
  output?: string;
}

const FileFetchSchema = z.object({
  file: z.string().min(1).optional(),
  fileId: z.string().min(1).optional(),
  output: z.string().min(1).optional(),
});

type FeishuMessageClientFactory = typeof createDefaultFeishuMessageClient;

interface FileFetchDeps {
  createFeishuMessageClient?: FeishuMessageClientFactory;
  feishuFileService?: typeof defaultFeishuFileService;
}

const FileSendSchema = z.object({
  caption: z.string().optional(),
  chatId: z.string().optional(),
  channel: z.string().optional(),
  paths: z.array(z.string().min(1)).min(1),
  threadTs: z.string().optional(),
});

type FileSendInput = z.infer<typeof FileSendSchema>;
// Compile-time check: schema output must satisfy the action's input shape.
const _fileSendTypeCheck: FileSendInput = {} as FileSendInputData;
void _fileSendTypeCheck;

export function registerFileCommands(program: Command): void {
  const file = program
    .command('file')
    .description('Send files to Slack or Feishu and download received Slack files.');

  // Input:   anima file fetch <fileId>
  // Output:  local path to the downloaded file.
  //          fileId comes from the `attached: id=<id>` line in message read output.
  // Failure: human-readable error to stderr; exit 1.
  file
    .command('fetch [fileId] [output]')
    .description('Download a Slack or Feishu file into the local cache and print its path.\nfileId comes from the `attached: id=<id>` line in message read output.')
    .option('--file-id <id>', 'file ID (alias for the positional fileId)')
    .option('--output <path>', 'copy the fetched file to this path and print that path')
    .action(async (fileId: string | undefined, output: string | undefined, _, command) => {
      const raw = command.optsWithGlobals();
      if (raw.output && output && raw.output !== output) {
        throw new Error('Pass output path either as the second argument or --output, not both');
      }
      const opts = FileFetchSchema.parse({
        ...raw,
        file: fileId,
        output: raw.output ?? output,
      });
      await runFileFetch(opts);
    });

  // Input:   anima file send --channel <id> [--thread-ts <ts>] [--caption <text> | stdin] <path>...
  // Input:   anima file send --chat-id <oc_...> [--thread-ts <om_or_omt>] [--caption <text> | stdin] <path>...
  // Output:  uploaded successfully. (channel=#<name> | dm=<handle>)[, thread_ts=<ts>], files=<N>.
  // Failure: human-readable error to stderr; exit 1.
  //          Fails closed before any platform call when --channel/path missing, path is not a file,
  //          or no active runtime item (so partial uploads can't escape the audit).
  file
    .command('send <paths...>')
    .description('Upload one or more local files to Slack or Feishu.\nFails before any upload if a path is missing or not a file.')
    .option('--channel <channel>', 'Slack channel/DM target, Feishu chat_id (oc_...), or Feishu open_id (ou_...)')
    .option('--chat-id <chatId>', 'Feishu chat_id (oc_...); alias for --channel')
    .option('--thread-ts <ts>', 'reply inside this thread; omit to post top-level')
    .option('--caption <text>', 'optional caption for the uploaded files; or pass via stdin heredoc')
    .action(async (paths: string[], _, command) => {
      const opts = FileSendSchema.parse({ ...command.optsWithGlobals(), paths });
      await runFileSend(normalizeChatTargetOptions(opts, 'file send'));
    });
}

export async function runFileFetch(opts: FileFetchInputData, deps: FileFetchDeps = {}): Promise<void> {
  const fileId = opts.file ?? opts.fileId;
  if (!fileId) throw new Error('file fetch requires <fileId> or --file-id <id>');
  const feishuResource = parseFeishuMessageResourceId(fileId);
  if (feishuResource) {
    await runFeishuFileFetch(opts, feishuResource, deps);
    return;
  }

  const { agent, client } = await slackWebClientForOpts(opts);
  const token = agent.slack?.botToken ?? '';
  if (!token) throw new Error('slack.botToken is required');
  const auth = await client.auth.test();
  const teamId = auth.team_id ?? agent.slack?.workspaceName ?? 'unknown-team';

  const cachedPath = await defaultSlackFileService.findCachedFile({ teamId, fileId });
  if (cachedPath) {
    await emitFetchPath(cachedPath, opts.output);
    return;
  }

  const info = (await client.files.info({ file: fileId })).file;
  const base = info ? slackFileFromRaw(info) : undefined;
  if (!base || !base.urlPrivate) {
    throw new Error(`Slack file ${fileId} is missing url_private (info: ${JSON.stringify(info ?? null)})`);
  }
  const file = await defaultSlackFileService.downloadToCache({ file: base, teamId, token });
  if (!('localPath' in file)) throw new Error(file.downloadError ?? `Slack file ${fileId} could not be cached`);
  await emitFetchPath(file.localPath, opts.output);
}

async function runFeishuFileFetch(
  opts: FileFetchInputData,
  resource: NonNullable<ReturnType<typeof parseFeishuMessageResourceId>>,
  deps: FileFetchDeps,
): Promise<void> {
  const service = deps.feishuFileService ?? defaultFeishuFileService;
  const cachedPath = await service.findCachedFile({ fileId: resource.fileId });
  if (cachedPath) {
    await emitFetchPath(cachedPath, opts.output);
    return;
  }

  const agent = await loadAgentFromOpts(opts);
  if (!agent.feishu.connected) {
    throw new Error(`Agent ${agent.id} has no Feishu connection configured`);
  }
  const client = (deps.createFeishuMessageClient ?? createDefaultFeishuMessageClient)(agent.feishu);
  const downloaded = await client.downloadMessageResource({
    fileKey: resource.fileKey,
    messageId: resource.messageId,
    resourceType: resource.resourceType,
  });
  const cached = await service.writeToCache({
    file: downloaded,
    ref: resource,
  });
  await emitFetchPath(cached, opts.output);
}

async function emitFetchPath(localPath: string, outputPath: string | undefined): Promise<void> {
  if (!outputPath) {
    console.log(localPath);
    return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await copyFile(localPath, outputPath);
  console.log(outputPath);
}
