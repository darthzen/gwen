# Gwen

A personal concierge agent on the [OpenRouter Agent SDK](https://openrouter.ai/docs), with pluggable chat adapters.

One front-model turn per message. Before the model is called, long-term memory
(Hindsight) is searched and the message is routed (Jev, through OpenRouter's
Decisions API), both concurrently and both bounded by a timeout. The model's
final text is posted by the host. Research that needs several sources runs as
a background job and its report arrives later as a message of its own.

## Layout

| Path | What it holds |
|---|---|
| `src/gwen.ts` | The turn loop |
| `src/frame.ts` | Every word the model is shown about a turn (pure functions) |
| `src/tools/` | Tools the model can call: web, memory, research |
| `src/research.ts` | Background research jobs |
| `src/memory.ts`, `src/jev.ts` | Hindsight and Jev clients |
| `src/http.ts` | The one JSON-over-HTTP helper every client uses |
| `src/adapters/` | Chat platforms. `types.ts` is the boundary; the core knows nothing platform-specific |
| `src/config.ts` | Every setting, its environment variable and default |
| `persona/README.txt` | Where the system prompt lives (outside this repo) and how to edit it |

## Run it locally

```sh
npm install
GWEN_PERSONA_FILE=~/Developer/lab-fleet/17-buzz/gwen/SOUL.md \
  OPENROUTER_API_KEY=... GWEN_ADAPTERS=cli npm run dev   # type a message, press return
npm test
```

`HINDSIGHT_API_KEY` enables memory; without it Gwen runs without. The Buzz
adapter needs `GWEN_ADAPTERS=buzz`, `BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY` and
`BUZZ_OWNER_PUBKEY`. No secret belongs in this repository.

## Adding a chat platform

Implement `ChatAdapter` from `src/adapters/types.ts` and add one entry to
`ADAPTERS` in `src/main.ts`.
