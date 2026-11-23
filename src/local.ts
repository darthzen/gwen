import { HTTPClient } from '@openrouter/sdk';

// A self-hosted model server in place of OpenRouter. llama.cpp's llama-server
// speaks the same Responses API the Agent SDK calls, with one gap: its
// streamed events leave out fields the SDK's schema requires, so the SDK
// discards the terminal event and reports "Stream ended without completion
// event". This fills those fields in. Nothing else about the exchange changes.
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

/** An HTTP client for the SDK that completes a local server's event streams. */
export function localHttpClient(): HTTPClient {
  return new HTTPClient({
    fetcher: async (input, init) => {
      const res = await fetch(input, init);
      if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return res;
      return new Response(completeEvents(await res.text()), { status: res.status, headers: res.headers });
    },
  });
}
