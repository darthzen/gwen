// The boundary that keeps Gwen portable. The core knows nothing about Buzz,
// Nostr, or any other chat platform: it receives Incoming messages and calls
// send(). A new platform is a new file in this directory.

/** Where a reply goes. JSON-serialisable, so a background job can keep it on disk. */
export interface ReplyTarget {
  /** Name of the adapter that owns the conversation. */
  adapter: string;
  /** Stable id for the conversation, prefixed with the adapter name. */
  conversationId: string;
  /**
   * Opaque routing data the adapter needs to answer in the right place
   * (thread, channel). Only the adapter that produced it reads it.
   */
  replyRef: unknown;
}

export interface Incoming {
  conversationId: string;
  replyRef: unknown;
  text: string;
  senderName: string;
}

export interface ChatAdapter {
  readonly name: string;
  start(onMessage: (m: Incoming) => void): Promise<void>;
  send(conversationId: string, text: string, replyRef: unknown): Promise<void>;
  /** Show a typing indicator until the returned function is called. */
  typing(conversationId: string, replyRef: unknown): () => void;
  stop(): Promise<void>;
  /** Only for adapters whose input can run out: resolves when it has. */
  ended?(): Promise<void>;
}
