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
| `src/tools/` | Tools the model can call: web, memory, library, research, sandbox |
| `src/sandbox.ts` | SSH to Gwen's own Linux machine |
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

`HINDSIGHT_API_KEY` enables memory; without it Gwen runs without.
`GWEN_SANDBOX_HOST` and `GWEN_SANDBOX_KEY_FILE` give her the `sandbox_run`
tool, a shell on her own machine over SSH; without a host she has no such tool. The Buzz
adapter needs `GWEN_ADAPTERS=buzz`, `BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY` and
`BUZZ_OWNER_PUBKEY`. The Telegram adapter needs `GWEN_ADAPTERS=telegram`,
`TELEGRAM_BOT_TOKEN` (from @BotFather) and `TELEGRAM_OWNER`, the one person
she answers: a username, or better a numeric user id, since a username can be
released and claimed by someone else. She answers that person in a private
chat only. Adapters can run together (`GWEN_ADAPTERS=buzz,telegram`); each
conversation keeps its own history, and her memory is shared across all of
them. No secret belongs in this repository.

## Where the models run

Every model goes to OpenRouter unless told otherwise. The front model, the
research worker, or both can instead run on a self-hosted llama.cpp
`llama-server`:

```sh
GWEN_FRONT_BASE_URL=http://llama-server.ai.svc.cluster.local:8080/v1
GWEN_FRONT_MODEL=qwen3.8-27b-uncensored   # the server's model name
GWEN_FRONT_TEMPERATURE=0.8                # optional; unset leaves the server's default
```

`GWEN_RESEARCH_BASE_URL`, `GWEN_RESEARCH_MODEL` and `GWEN_RESEARCH_TEMPERATURE`
do the same for the research worker. To go back to OpenRouter, remove the
`*_BASE_URL` and `*_TEMPERATURE` settings and name an OpenRouter model or
preset again. `OPENROUTER_API_KEY` stays required either way: Jev routing
always goes through OpenRouter.

`src/local.ts` is the whole of the difference: llama-server's Responses API
omits fields the Agent SDK requires, and that file fills them in.

## Adding a chat platform

Implement `ChatAdapter` from `src/adapters/types.ts` and add one entry to
`ADAPTERS` in `src/main.ts`.
