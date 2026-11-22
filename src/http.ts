import type { z } from 'zod';

// The one place Gwen talks JSON over HTTP. Every outbound call (Hindsight,
// Jev, SearXNG, Firecrawl, a chat platform's HTTP bridge) goes through
// requestJson, so timeouts, error text and response validation are decided
// here and nowhere else.

export interface JsonRequest<T> {
  /** Short name of the far end, used in error text: "hindsight", "searxng". */
  service: string;
  url: string;
  /** Defaults to POST when a body is given, GET otherwise. */
  method?: 'GET' | 'POST';
  /** Sent as `Authorization: Bearer …`. */
  bearer?: string;
  headers?: Record<string, string>;
  /** Serialised as JSON. */
  body?: unknown;
  timeoutMs: number;
  /** The response body is parsed with this, so callers get typed data. */
  schema: z.ZodType<T>;
}

/** Longest slice of an error response body worth carrying in an error message. */
const ERROR_DETAIL_CHARS = 300;

export async function requestJson<T>(req: JsonRequest<T>): Promise<T> {
  const method = req.method ?? (req.body === undefined ? 'GET' : 'POST');
  const what = `${req.service} ${method} ${new URL(req.url).pathname}`;

  let res: Response;
  try {
    res = await fetch(req.url, {
      method,
      headers: {
        ...(req.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(req.bearer ? { Authorization: `Bearer ${req.bearer}` } : {}),
        ...req.headers,
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new Error(`${what}: no response within ${req.timeoutMs} ms`);
    }
    throw new Error(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, ERROR_DETAIL_CHARS);
    throw new Error(`${what}: HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const parsed = req.schema.safeParse(await res.json());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${what}: unexpected response shape at ${issue?.path.join('.') || '(root)'}: ${issue?.message}`);
  }
  return parsed.data;
}
