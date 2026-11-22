import { createInterface } from 'node:readline';
import type { ChatAdapter, Incoming } from './types.js';

// Terminal adapter for local testing: one line in, replies on stdout.
export class CliAdapter implements ChatAdapter {
  readonly name = 'cli';
  private closed: Promise<void> = Promise.resolve();

  constructor(private senderName: string) {}

  async start(onMessage: (m: Incoming) => void): Promise<void> {
    const rl = createInterface({ input: process.stdin });
    this.closed = new Promise((resolve) => rl.once('close', resolve));
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      onMessage({ conversationId: 'cli:local', text, senderName: this.senderName, replyRef: null });
    });
  }

  /** Resolves when stdin ends. */
  ended(): Promise<void> {
    return this.closed;
  }

  async send(_conversationId: string, text: string): Promise<void> {
    process.stdout.write(`\n=== Gwen ===\n${text}\n============\n`);
  }

  typing(): () => void {
    return () => {};
  }

  async stop(): Promise<void> {}
}
