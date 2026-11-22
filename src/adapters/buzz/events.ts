import { createHash, randomUUID } from 'node:crypto';
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure';

// The Buzz wire format, as pure functions: which Nostr events Gwen signs and
// how an incoming event is read. No network here, so all of it is testable.
// Source: block/buzz (NOSTR.md, desktop/src/shared/constants/kinds.ts).

export type { Event };

export const KIND = {
  message: 9,
  relayAuth: 22242,
  httpAuth: 27235,
  presence: 20001,
  typing: 20002,
  channel: 39000,
  membership: 39002,
  memberAdded: 44100,
  memberRemoved: 44101,
} as const;

/** A DM gets every message; in any other channel Gwen only sees messages that mention her. */
export type ChannelType = 'dm' | 'stream';

/** What Gwen needs to answer a message in the right place. Stored with research jobs. */
export interface BuzzReplyRef {
  channel: string;
  channelType: ChannelType;
  /** The message being answered. */
  eventId: string;
  /** Root of the thread that message is in, or null for a top-level message. */
  threadRoot: string | null;
}

export function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/**
 * The thread an incoming message belongs to. Thread `e` tags carry a marker in
 * their fourth element: a `root` tag names the thread root; a lone `reply`
 * tag means a direct reply to the root; neither means a top-level message.
 */
export function threadRootOf(event: Event): string | null {
  const marked = (marker: string) => event.tags.find((tag) => tag[0] === 'e' && tag[3] === marker)?.[1];
  return marked('root') ?? marked('reply') ?? null;
}

/**
 * Thread tags for a reply. Inside a thread, stay in it. Outside one, answer
 * flat in a DM, and open a thread on the trigger in a shared channel so the
 * channel itself stays readable.
 */
export function replyTags(ref: BuzzReplyRef): string[][] {
  if (ref.threadRoot) {
    return [
      ['e', ref.threadRoot, '', 'root'],
      ['e', ref.eventId, '', 'reply'],
    ];
  }
  return ref.channelType === 'dm' ? [] : [['e', ref.eventId, '', 'reply']];
}

/** Signs every event Gwen sends. Holds the private key; nothing else does. */
export class Signer {
  readonly pubkey: string;
  private secret: Uint8Array;

  constructor(privateKeyHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(privateKeyHex)) throw new Error('the Buzz private key must be 64 hex characters');
    this.secret = Uint8Array.from(Buffer.from(privateKeyHex, 'hex'));
    this.pubkey = getPublicKey(this.secret);
  }

  private sign(kind: number, tags: string[][], content = '', now = Date.now()): Event {
    return finalizeEvent({ kind, tags, content, created_at: Math.floor(now / 1000) }, this.secret);
  }

  /** Answer to the relay's AUTH challenge on the websocket. */
  relayAuth(relayUrl: string, challenge: string): Event {
    return this.sign(KIND.relayAuth, [
      ['relay', relayUrl],
      ['challenge', challenge],
    ]);
  }

  /**
   * `Authorization` header for one request to the HTTP bridge (NIP-98). The
   * relay rejects a replayed event, so build a fresh header per request, over
   * the exact body string that is sent.
   */
  httpAuthHeader(url: string, body: string): string {
    const event = this.sign(KIND.httpAuth, [
      ['u', url],
      ['method', 'POST'],
      ['nonce', randomUUID()],
      ['payload', createHash('sha256').update(body).digest('hex')],
    ]);
    return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
  }

  message(ref: BuzzReplyRef, ownerPubkey: string, text: string, now = Date.now()): Event {
    const tags = [['h', ref.channel], ['p', ownerPubkey], ['ms', String(now)], ...replyTags(ref)];
    return this.sign(KIND.message, tags, text, now);
  }

  typing(ref: BuzzReplyRef): Event {
    return this.sign(KIND.typing, [['h', ref.channel], ...replyTags(ref)]);
  }

  presence(status: 'online' | 'offline'): Event {
    return this.sign(KIND.presence, [], status);
  }
}
