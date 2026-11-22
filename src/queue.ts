// Runs work one item at a time per key, in arrival order. Gwen keys it by
// conversation: the SDK's state accessor does load-modify-save, so two turns
// of one conversation running at once would overwrite each other's history.
// Different conversations still run in parallel.

export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  constructor(private onError: (key: string, error: unknown) => void) {}

  /** Queue `work` behind everything already queued for `key`. */
  push(key: string, work: () => Promise<void>): void {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const tail = previous.then(work).catch((e) => this.onError(key, e));
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }

  get busy(): boolean {
    return this.tails.size > 0;
  }

  /** Resolves when everything queued so far has run. */
  async drain(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }
}
