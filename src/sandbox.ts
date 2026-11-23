import { createHash } from 'node:crypto';
import { Client } from 'ssh2';
import type { SandboxConfig } from './config.js';

// Gwen's own Linux machine, reached over SSH. One connection per command: the
// commands are seconds apart at best, and a fresh connection has no state to
// go stale across a VM reboot.
//
// The command runs on the machine as
//
//   timeout -k 5 <seconds> bash -lc '<command>'
//
// so the time limit is enforced there, by a process that outlives a dropped
// connection, and the command gets the login shell's PATH.

const CONNECT_TIMEOUT_MS = 10_000;
/** How long past the remote time limit the connection is kept before it is dropped. */
const DEADLINE_SLACK_MS = 15_000;
/** `timeout` exits with this status when it had to stop the command. */
const TIMEOUT_EXIT = 124;
/** Characters of each stream handed back to the model: this much of the start and of the end. */
const HEAD_CHARS = 2_000;
const TAIL_CHARS = 6_000;

export interface RunOptions {
  command: string;
  timeoutSeconds: number;
  /** Written to the command's standard input, which is then closed. */
  stdin?: string;
}

export interface RunResult {
  /** Null when the command was ended by a signal or the connection dropped. */
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** True when either stream was longer than what is returned. */
  truncated: boolean;
  ms: number;
}

/** Quote a string as one word for a POSIX shell. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The fingerprint of a host key in the form `ssh-keygen -l` prints: SHA256:<base64, no padding>. */
export function fingerprint(hostKey: Buffer): string {
  return `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Collects a stream but keeps only its start and its end, so a command that
 * prints a gigabyte costs a fixed amount of memory and of the model's context.
 * The end matters most: that is where errors are.
 */
export class Clip {
  private head = '';
  private tail = '';
  private total = 0;

  constructor(
    private headChars = HEAD_CHARS,
    private tailChars = TAIL_CHARS,
  ) {}

  add(chunk: string): void {
    this.total += chunk.length;
    const room = this.headChars - this.head.length;
    if (room > 0) {
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk) this.tail = (this.tail + chunk).slice(-this.tailChars);
  }

  get truncated(): boolean {
    return this.total > this.head.length + this.tail.length;
  }

  text(): string {
    if (!this.truncated) return this.head + this.tail;
    const dropped = this.total - this.head.length - this.tail.length;
    return `${this.head}\n[... ${dropped} characters omitted ...]\n${this.tail}`;
  }
}

export class Sandbox {
  constructor(private cfg: SandboxConfig) {}

  /** Run one command to completion. Rejects only when the machine cannot be reached or logged into. */
  run({ command, timeoutSeconds, stdin = '' }: RunOptions): Promise<RunResult> {
    const started = Date.now();
    const stdout = new Clip();
    const stderr = new Clip();
    const conn = new Client();
    const remote = `timeout -k 5 ${Math.ceil(timeoutSeconds)} bash -lc ${shellQuote(command)}`;

    return new Promise<RunResult>((resolve, reject) => {
      let settled = false;
      const settle = (act: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        conn.end();
        act();
      };
      const result = (exitCode: number | null, signal: string | undefined, timedOut: boolean): RunResult => ({
        exitCode,
        ...(signal ? { signal } : {}),
        timedOut,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
        ms: Date.now() - started,
      });

      // The remote `timeout` is the real limit. This one covers a machine that
      // stopped answering after the command started.
      const deadline = setTimeout(
        () => settle(() => resolve(result(null, undefined, true))),
        CONNECT_TIMEOUT_MS + timeoutSeconds * 1000 + DEADLINE_SLACK_MS,
      );

      conn.on('error', (e) => settle(() => reject(new Error(`sandbox ${this.cfg.host}: ${e.message}`))));
      conn.on('close', () => settle(() => reject(new Error(`sandbox ${this.cfg.host}: connection closed early`))));
      conn.on('ready', () => {
        conn.exec(remote, (err, channel) => {
          if (err) return settle(() => reject(new Error(`sandbox ${this.cfg.host}: ${err.message}`)));
          channel.setEncoding('utf8');
          channel.stderr.setEncoding('utf8');
          channel.on('data', (chunk: string) => stdout.add(chunk));
          channel.stderr.on('data', (chunk: string) => stderr.add(chunk));
          channel.on('close', (code: number | null, signal?: string) =>
            settle(() => resolve(result(code ?? null, signal, code === TIMEOUT_EXIT))),
          );
          channel.end(stdin);
        });
      });

      conn.connect({
        host: this.cfg.host,
        port: this.cfg.port,
        username: this.cfg.user,
        privateKey: this.cfg.privateKey,
        readyTimeout: CONNECT_TIMEOUT_MS,
        keepaliveInterval: 15_000,
        // With a pinned fingerprint a machine answering with another key is
        // refused. Without one, any key is accepted.
        hostVerifier: (key: Buffer) => !this.cfg.hostKey || fingerprint(key) === this.cfg.hostKey,
      });
    });
  }
}
