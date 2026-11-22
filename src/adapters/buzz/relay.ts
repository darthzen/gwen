import WebSocket from 'ws';
import { log, errText } from '../../log.js';
import type { Event, Signer } from './events.js';

// One authenticated websocket to the Buzz relay that keeps itself alive.
// Callers declare the subscriptions they want and publish events; this class
// handles the AUTH handshake, reconnecting with backoff, and re-opening every
// subscription from just before the last event seen, so a dropped connection
// loses nothing. (`ws` answers the relay's pings by itself.)

export type Filter = Record<string, unknown>;

const AUTH_DEADLINE_MS = 10_000;
const PUBLISH_DEADLINE_MS = 10_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 32_000;
/** On reconnect, ask again for this many seconds before the last event seen. */
const RESUME_OVERLAP_S = 5;

interface PendingPublish {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class Relay {
  private ws: WebSocket | null = null;
  private ready = false;
  private stopped = false;
  private failures = 0;
  private authEventId: string | null = null;
  private authDeadline: NodeJS.Timeout | undefined;
  private subscriptions = new Map<string, Filter>();
  private publishing = new Map<string, PendingPublish>();
  private readyWaiters: Array<() => void> = [];
  /** `created_at` of the newest event received; subscriptions resume from here. */
  private lastSeen: number;

  constructor(
    private url: string,
    private signer: Signer,
    private onEvent: (event: Event) => void,
  ) {
    this.lastSeen = Math.floor(Date.now() / 1000);
  }

  /** Connect and wait for the first successful AUTH. */
  async start(timeoutMs: number): Promise<void> {
    this.connect();
    await this.whenReady(timeoutMs);
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  /** Keep this subscription open, across reconnects, until unsubscribe. */
  subscribe(id: string, filter: Filter): void {
    this.subscriptions.set(id, filter);
    if (this.ready) this.request(id, filter);
  }

  unsubscribe(id: string): void {
    if (this.subscriptions.delete(id) && this.ready) this.transmit(['CLOSE', id]);
  }

  /** Send an event and wait for the relay to accept it. */
  async publish(event: Event): Promise<void> {
    await this.whenReady(PUBLISH_DEADLINE_MS);
    const accepted = new Promise<void>((resolve, reject) => this.publishing.set(event.id, { resolve, reject }));
    const deadline = setTimeout(
      () => this.settlePublish(event.id, new Error('the relay did not acknowledge the event')),
      PUBLISH_DEADLINE_MS,
    );
    this.transmit(['EVENT', event]);
    await accepted.finally(() => clearTimeout(deadline));
  }

  /** Send an event nobody needs confirmed (typing, presence). Dropped when offline. */
  broadcast(event: Event): void {
    if (this.ready) this.transmit(['EVENT', event]);
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.authDeadline = setTimeout(() => {
      log.warn('buzz relay: no AUTH within deadline, reconnecting');
      ws.terminate();
    }, AUTH_DEADLINE_MS);

    ws.on('message', (data) => {
      try {
        this.onFrame(JSON.parse(data.toString()) as unknown[]);
      } catch (e) {
        log.warn('buzz relay: unreadable frame', { error: errText(e) });
      }
    });
    ws.on('error', (e) => log.warn('buzz relay: socket error', { error: errText(e) }));
    ws.on('close', () => this.onClose());
  }

  private onFrame(frame: unknown[]): void {
    const [type, a, b, c] = frame;
    switch (type) {
      case 'AUTH': {
        const auth = this.signer.relayAuth(this.url, String(a));
        this.authEventId = auth.id;
        this.transmit(['AUTH', auth]);
        return;
      }
      case 'OK': {
        const error = b === true ? undefined : new Error(`the relay rejected the event: ${String(c)}`);
        if (a === this.authEventId) {
          this.authEventId = null;
          if (error) {
            log.error('buzz relay: AUTH rejected', { reason: String(c) });
            this.ws?.close();
          } else {
            this.becomeReady();
          }
        } else {
          this.settlePublish(String(a), error);
        }
        return;
      }
      case 'EVENT': {
        const event = b as Event;
        this.lastSeen = Math.max(this.lastSeen, event.created_at);
        this.onEvent(event);
        return;
      }
      case 'CLOSED':
        log.warn('buzz relay: subscription closed by relay', { subscription: a, reason: b });
        return;
      case 'NOTICE':
        log.warn('buzz relay: notice', { notice: a });
        return;
      default: // EOSE and anything new: nothing to do.
    }
  }

  private becomeReady(): void {
    clearTimeout(this.authDeadline);
    this.ready = true;
    this.failures = 0;
    for (const [id, filter] of this.subscriptions) this.request(id, filter);
    for (const wake of this.readyWaiters.splice(0)) wake();
    log.info('buzz relay: connected', { subscriptions: this.subscriptions.size });
  }

  private onClose(): void {
    clearTimeout(this.authDeadline);
    this.ready = false;
    this.ws = null;
    for (const id of [...this.publishing.keys()]) this.settlePublish(id, new Error('the relay connection closed'));
    if (this.stopped) return;

    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.failures);
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.failures += 1;
    log.warn('buzz relay: disconnected, reconnecting', { inMs: Math.round(delay) });
    setTimeout(() => this.connect(), delay);
  }

  private request(id: string, filter: Filter): void {
    this.transmit(['REQ', id, { ...filter, since: this.lastSeen - RESUME_OVERLAP_S }]);
  }

  private transmit(frame: unknown[]): void {
    this.ws?.send(JSON.stringify(frame));
  }

  private settlePublish(eventId: string, error?: Error): void {
    const pending = this.publishing.get(eventId);
    if (!pending) return;
    this.publishing.delete(eventId);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private whenReady(timeoutMs: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`buzz relay not connected after ${timeoutMs} ms`)), timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(deadline);
        resolve();
      });
    });
  }
}
