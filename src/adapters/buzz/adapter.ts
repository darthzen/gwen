import { verifyEvent } from 'nostr-tools/pure';
import { z } from 'zod';
import type { BuzzConfig } from '../../config.js';
import { requestJson } from '../../http.js';
import { log, errText } from '../../log.js';
import type { ChatAdapter, Incoming } from '../types.js';
import { KIND, Signer, tagValue, threadRootOf, type BuzzReplyRef, type ChannelType, type Event } from './events.js';
import { Relay, type Filter } from './relay.js';

// Gwen on Buzz. Buzz is a Nostr relay with channels: Gwen listens on a
// websocket to every channel she is a member of, answers only her owner, and
// posts replies as signed events. The wire format lives in events.ts, the
// connection in relay.ts; this file is the behaviour.

const CONNECT_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 15_000;
const PRESENCE_EVERY_MS = 60_000;
const TYPING_EVERY_MS = 3_000;
/** How many handled event ids to remember, to drop the repeats a reconnect replays. */
const SEEN_LIMIT = 2_000;

const MEMBERSHIP_SUBSCRIPTION = 'membership';
const channelSubscription = (channel: string) => `ch-${channel}`;
const conversationOf = (channel: string) => `buzz:${channel}`;

const Events = z.array(
  z.object({
    id: z.string(),
    pubkey: z.string(),
    kind: z.number(),
    created_at: z.number(),
    content: z.string(),
    sig: z.string(),
    tags: z.array(z.array(z.string())),
  }),
);

export class BuzzAdapter implements ChatAdapter {
  readonly name = 'buzz';
  private signer: Signer;
  private relay: Relay;
  private httpUrl: string;
  private channels = new Map<string, ChannelType>();
  private seen = new Set<string>();
  private presence: NodeJS.Timeout | undefined;
  private onMessage: (message: Incoming) => void = () => {};

  constructor(
    private cfg: BuzzConfig,
    private ownerName: string,
  ) {
    this.signer = new Signer(cfg.privateKey);
    this.relay = new Relay(cfg.relayUrl, this.signer, (event) => this.onEvent(event));
    this.httpUrl = cfg.relayUrl.replace(/^ws/, 'http').replace(/\/$/, '');
  }

  async start(onMessage: (message: Incoming) => void): Promise<void> {
    this.onMessage = onMessage;
    await this.relay.start(CONNECT_TIMEOUT_MS);
    await this.syncChannels();
    this.relay.subscribe(MEMBERSHIP_SUBSCRIPTION, {
      kinds: [KIND.memberAdded, KIND.memberRemoved],
      '#p': [this.signer.pubkey],
    });
    const announce = () => this.relay.broadcast(this.signer.presence('online'));
    announce();
    this.presence = setInterval(announce, PRESENCE_EVERY_MS);
  }

  async stop(): Promise<void> {
    clearInterval(this.presence);
    this.relay.broadcast(this.signer.presence('offline'));
    this.relay.stop();
  }

  async send(_conversationId: string, text: string, replyRef: unknown): Promise<void> {
    await this.relay.publish(this.signer.message(replyRef as BuzzReplyRef, this.cfg.ownerPubkey, text));
  }

  typing(_conversationId: string, replyRef: unknown): () => void {
    const show = () => this.relay.broadcast(this.signer.typing(replyRef as BuzzReplyRef));
    show();
    // Buzz has no "stopped typing" event; the indicator lapses when these stop.
    const repeat = setInterval(show, TYPING_EVERY_MS);
    return () => clearInterval(repeat);
  }

  private onEvent(event: Event): void {
    if (event.kind === KIND.memberAdded || event.kind === KIND.memberRemoved) {
      this.syncChannels().catch((e) => log.error('buzz: channel sync failed', { error: errText(e) }));
      return;
    }
    if (event.kind !== KIND.message || event.pubkey === this.signer.pubkey) return;
    if (!this.firstSighting(event.id)) return;

    const channel = tagValue(event, 'h');
    const channelType = channel ? this.channels.get(channel) : undefined;
    if (!channel || !channelType) return;
    // Gwen is a personal concierge: she answers her owner and nobody else.
    if (event.pubkey !== this.cfg.ownerPubkey || !verifyEvent(event)) {
      log.info('buzz: ignored a message that is not from the owner', { channel, event: event.id });
      return;
    }

    const replyRef: BuzzReplyRef = { channel, channelType, eventId: event.id, threadRoot: threadRootOf(event) };
    this.onMessage({
      conversationId: conversationOf(channel),
      replyRef,
      text: event.content,
      senderName: this.ownerName,
    });
  }

  private firstSighting(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }

  /** Bring subscriptions in line with the channels Gwen is a member of right now. */
  private async syncChannels(): Promise<void> {
    const current = await this.fetchChannels();
    for (const channel of this.channels.keys()) {
      if (!current.has(channel)) this.relay.unsubscribe(channelSubscription(channel));
    }
    for (const [channel, type] of current) {
      if (!this.channels.has(channel)) this.relay.subscribe(channelSubscription(channel), messageFilter(channel, type, this.signer.pubkey));
    }
    this.channels = current;
    log.info('buzz: channels synced', { channels: current.size });
  }

  private async fetchChannels(): Promise<Map<string, ChannelType>> {
    const memberships = await this.query([{ kinds: [KIND.membership], '#p': [this.signer.pubkey] }]);
    const ids = [...new Set(memberships.flatMap((m) => tagValue(m, 'd') ?? []))];
    if (!ids.length) return new Map();

    const channels = new Map<string, ChannelType>();
    for (const meta of await this.query([{ kinds: [KIND.channel], '#d': ids }])) {
      const id = tagValue(meta, 'd');
      if (!id || tagValue(meta, 'archived') === 'true') continue;
      channels.set(id, tagValue(meta, 't') === 'dm' ? 'dm' : 'stream');
    }
    return channels;
  }

  /** Read stored events through the relay's HTTP bridge. */
  private query(filters: Filter[]): Promise<Event[]> {
    const url = `${this.httpUrl}/query`;
    return requestJson({
      service: 'buzz',
      url,
      // requestJson sends JSON.stringify(body); the header must sign those same bytes.
      headers: { Authorization: this.signer.httpAuthHeader(url, JSON.stringify(filters)) },
      body: filters,
      timeoutMs: QUERY_TIMEOUT_MS,
      schema: Events,
    });
  }
}

function messageFilter(channel: string, type: ChannelType, me: string): Filter {
  const filter: Filter = { kinds: [KIND.message], '#h': [channel] };
  return type === 'dm' ? filter : { ...filter, '#p': [me] };
}
