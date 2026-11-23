import { z } from 'zod';
import type { TelegramConfig } from '../../config.js';
import { requestJson } from '../../http.js';
import { log, errText } from '../../log.js';
import type { ChatAdapter, Incoming } from '../types.js';
import { chunks, toTelegramHtml } from './format.js';

// Gwen on Telegram, as a bot. She long-polls the Bot API for messages, so
// nothing has to reach her from the internet, and answers one person in a
// private chat. Telegram can read everything sent through a bot: bot chats
// are not end-to-end encrypted.

const API = 'https://api.telegram.org';
/** How long Telegram holds a poll open when there is nothing to deliver. */
const POLL_SECONDS = 50;
const CALL_TIMEOUT_MS = 15_000;
/** A typing indicator lasts about five seconds, so it is renewed inside that. */
const TYPING_EVERY_MS = 4_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

const TEXT_ONLY = 'I can only read text here for now.';

const conversationOf = (chatId: number) => `telegram:${chatId}`;

const Message = z.object({
  message_id: z.number(),
  from: z.object({ id: z.number(), username: z.string().optional() }).optional(),
  chat: z.object({ id: z.number(), type: z.string() }),
  text: z.string().optional(),
});

const Updates = z.array(z.object({ update_id: z.number(), message: Message.optional() }));
const Me = z.object({ id: z.number(), username: z.string().optional() });

interface TelegramReplyRef {
  chatId: number;
}

export class TelegramAdapter implements ChatAdapter {
  readonly name = 'telegram';
  private onMessage: (message: Incoming) => void = () => {};
  private stopping = new AbortController();
  private polling: Promise<void> = Promise.resolve();
  /** The id of the next update to ask for. Telegram forgets everything before it. */
  private offset = 0;
  /** Senders already reported in the log as not the owner. */
  private refused = new Set<number>();

  constructor(
    private cfg: TelegramConfig,
    private ownerName: string,
  ) {}

  async start(onMessage: (message: Incoming) => void): Promise<void> {
    this.onMessage = onMessage;
    const me = await this.call('getMe', {}, Me);
    log.info('telegram: connected', { bot: me.username ?? me.id });
    this.polling = this.poll();
  }

  async send(_conversationId: string, text: string, replyRef: unknown): Promise<void> {
    const { chatId } = replyRef as TelegramReplyRef;
    for (const chunk of chunks(text)) {
      try {
        await this.call('sendMessage', { chat_id: chatId, text: toTelegramHtml(chunk), parse_mode: 'HTML' }, z.unknown());
      } catch (e) {
        // Telegram refuses a message whose markup it cannot parse. The words
        // matter more than the formatting, so send them plain.
        if (!/can't parse entities/i.test(errText(e))) throw e;
        await this.call('sendMessage', { chat_id: chatId, text: chunk }, z.unknown());
      }
    }
  }

  typing(_conversationId: string, replyRef: unknown): () => void {
    const { chatId } = replyRef as TelegramReplyRef;
    const show = () => void this.call('sendChatAction', { chat_id: chatId, action: 'typing' }, z.unknown()).catch(() => {});
    show();
    const timer = setInterval(show, TYPING_EVERY_MS);
    return () => clearInterval(timer);
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    await this.polling;
  }

  /** Ask for updates until stopped, backing off while Telegram is unreachable. */
  private async poll(): Promise<void> {
    let retryMs = RETRY_MIN_MS;
    while (!this.stopping.signal.aborted) {
      try {
        const updates = await this.call(
          'getUpdates',
          { offset: this.offset, timeout: POLL_SECONDS, allowed_updates: ['message'] },
          Updates,
          (POLL_SECONDS + 10) * 1000,
        );
        retryMs = RETRY_MIN_MS;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (update.message) this.receive(update.message);
        }
      } catch (e) {
        if (this.stopping.signal.aborted) return;
        log.error('telegram: poll failed', { error: errText(e), retryMs });
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    }
  }

  private receive(message: z.infer<typeof Message>): void {
    const from = message.from;
    if (!from || message.chat.type !== 'private' || !this.isOwner(from)) {
      if (from && !this.refused.has(from.id)) {
        this.refused.add(from.id);
        log.info('telegram: ignoring a sender who is not the owner', { userId: from.id, chatType: message.chat.type });
      }
      return;
    }
    const replyRef: TelegramReplyRef = { chatId: message.chat.id };
    const conversationId = conversationOf(message.chat.id);
    if (!message.text) {
      void this.send(conversationId, TEXT_ONLY, replyRef).catch((e) =>
        log.error('telegram: send failed', { error: errText(e) }),
      );
      return;
    }
    this.onMessage({ conversationId, replyRef, text: message.text, senderName: this.ownerName });
  }

  private isOwner(from: { id: number; username?: string | undefined }): boolean {
    return String(from.id) === this.cfg.owner || from.username?.toLowerCase() === this.cfg.owner;
  }

  /** One Bot API call. The token is part of the URL, so errors name the method only. */
  private async call<T>(method: string, body: unknown, result: z.ZodType<T>, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    const response = await requestJson({
      service: 'telegram',
      url: `${API}/bot${this.cfg.token}/${method}`,
      label: method,
      body,
      timeoutMs,
      schema: z.object({ result }),
    });
    return response.result as T;
  }
}
