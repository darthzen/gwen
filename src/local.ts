import { HTTPClient } from '@openrouter/sdk';

// A self-hosted model server in place of OpenRouter. llama.cpp's llama-server
// speaks the same Responses API the Agent SDK calls, with one gap: its
// streamed events leave out fields the SDK's schema requires, so the SDK
// discards the terminal event and reports "Stream ended without completion
// event". This fills those fields in.
//
// It also repairs what Gwen sends. A reply cut off at the output limit can
// leave a tool call whose arguments are half a JSON document. The SDK answers
// that call with an error and keeps both in the history, and llama-server
// then rejects every later request that replays them with a 500. The call's
// arguments are replaced with an empty object on the way out, so the model
// sees its failed call and the error, and can try again.
//
// The reply is read whole before it is handed on. Gwen posts a finished reply
// and never streams to the user, so nothing is lost by that.

/** Response fields the SDK requires and llama-server omits, with neutral values. */
const RESPONSE_DEFAULTS = {
  completed_at: null,
  error: null,
  frequency_penalty: 0,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  presence_penalty: 0,
  temperature: 1,
  tool_choice: 'auto',
  tools: [],
  top_p: 1,
};

const TERMINAL_EVENT = /^response\.(completed|incomplete|failed)$/;

/**
 * Complete the events of one server-sent-event body. Lines that are not JSON
 * `data:` lines pass through as they are.
 */
export function completeEvents(body: string): string {
  let sequence = 0;
  return body
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data: {')) return line;
      let event: Record<string, any>;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        return line;
      }
      event.sequence_number ??= sequence++;
      if (event.response && TERMINAL_EVENT.test(event.type)) {
        const response = { ...RESPONSE_DEFAULTS, ...event.response };
        response.completed_at ??= response.created_at ?? null;
        if (response.usage) {
          response.usage.input_tokens_details ??= { cached_tokens: 0 };
          response.usage.output_tokens_details ??= { reasoning_tokens: 0 };
        }
        event.response = response;
      }
      return `data: ${JSON.stringify(event)}`;
    })
    .join('\n');
}

const CUT_OFF_HINT =
  ' The arguments were probably cut off at the output limit. Send less in one call: write a long file as several smaller appends.';

function parses(json: unknown): boolean {
  if (typeof json !== 'string') return true;
  try {
    JSON.parse(json);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make every tool call in a request body one the server can replay. Returns
 * the body unchanged when there is nothing to repair or it is not a request
 * with an `input` list.
 */
export function repairToolCalls(body: string): string {
  let request: { input?: unknown };
  try {
    request = JSON.parse(body);
  } catch {
    return body;
  }
  if (!Array.isArray(request?.input)) return body;
  const items = request.input as Array<Record<string, unknown>>;
  const broken = new Set<unknown>();
  for (const item of items) {
    if (item?.type === 'function_call' && !parses(item.arguments)) {
      item.arguments = '{}';
      broken.add(item.call_id);
    }
  }
  if (broken.size === 0) return body;
  for (const item of items) {
    if (item?.type === 'function_call_output' && broken.has(item.call_id) && typeof item.output === 'string') {
      item.output += CUT_OFF_HINT;
    }
  }
  return JSON.stringify(request);
}

async function repaired(input: RequestInfo | URL, init?: RequestInit): Promise<[RequestInfo | URL, RequestInit?]> {
  if (!(input instanceof Request) || input.method !== 'POST') return [input, init];
  const body = await input.clone().text();
  const fixed = repairToolCalls(body);
  if (fixed === body) return [input, init];
  const headers = new Headers(input.headers);
  headers.delete('content-length');
  return [new Request(input.url, { method: 'POST', headers, body: fixed, signal: input.signal }), init];
}

/** An HTTP client for the SDK that completes a local server's event streams. */
export function localHttpClient(): HTTPClient {
  return new HTTPClient({
    fetcher: async (rawInput, rawInit) => {
      const [input, init] = await repaired(rawInput, rawInit);
      const res = init == null ? await fetch(input) : await fetch(input, init);
      if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return res;
      return new Response(completeEvents(await res.text()), { status: res.status, headers: res.headers });
    },
  });
}
