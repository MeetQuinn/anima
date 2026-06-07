export interface ChatTargetOptions {
  channel?: string;
  chatId?: string;
}

export function normalizeChatTargetOptions<T extends ChatTargetOptions>(
  opts: T,
  commandName: string,
): Omit<T, 'channel' | 'chatId'> & { channel?: string } {
  const channel = trimmed(opts.channel);
  const chatId = trimmed(opts.chatId);
  if (channel && chatId) {
    throw new Error(`${commandName} accepts either --channel or --chat-id, not both`);
  }
  if (chatId && !chatId.startsWith('oc_')) {
    throw new Error(`${commandName} --chat-id must be a Feishu chat_id (oc_...)`);
  }
  const { channel: _channel, chatId: _chatId, ...rest } = opts;
  return {
    ...rest,
    ...(chatId ? { channel: chatId } : channel ? { channel } : {}),
  };
}

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}
