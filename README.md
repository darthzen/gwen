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
| `src/tools/` | Tools the model can call: web, memory, history, library, research, sandbox, skills |
| `src/skills.ts`, `src/mcp.ts` | Skills: procedures and MCP servers she loads only when a job needs them |
| `src/sandbox.ts` | SSH to Gwen's own Linux machine |
| `src/research.ts` | Background research jobs |
| `src/transcript.ts` | The permanent chat record that `search_history` reads |
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

## Skills

A skill is a written procedure for one kind of job, kept out of the system
prompt. Set `GWEN_SKILLS_DIR` to a directory of markdown files, one skill per
file:

```markdown
---
name: github
description: Read and change issues and pull requests on GitHub.
mcp: github http://github-mcp-server.ai.svc.cluster.local:8080/mcp bearer=GITHUB_MCP_TOKEN
---
The procedure, in markdown.
```

Only each skill's name and description are added to her instructions, one line
per skill. She reads the body with `load_skill` in a turn that needs it, so a
long procedure costs tokens only when it is used. Files are read once at
start. A file that is not a valid skill is logged (`skill skipped`) and left
out; the rest still load.

A skill can name MCP servers with `mcp:` lines (repeatable): a name for the
server, its streamable-HTTP address, and optionally `bearer=<ENV VAR>` to send
that variable's value as a bearer token and `tools=a,b` to offer only those
tools. No MCP tool is defined to the model up front. When the skill loads, the
service connects to its servers and returns their tools' names, descriptions
and argument schemas as part of the `load_skill` result; she then calls one
with `skill_tool(server, tool, arguments)`, which checks the arguments against
the schema first. The tool list of a run is fixed when the run starts, which
is why MCP tools go through this one tool instead of being added one by one.
A tool result longer than 12,000 characters is cut in the middle.

Log lines `load_skill` and `skill_tool` record which skill and which tool were
used and how long a call took, never arguments or results.

## Chat history

Every message she receives and every reply she sends, on every platform, is
appended to `$GWEN_DATA_DIR/transcript/YYYY-MM.jsonl`: one JSON object per
line with the time (UTC), platform, conversation, speaker and text. It is
never trimmed, unlike the per-conversation state the model is shown, and it
stays on her volume: nothing from it goes to Hindsight or any other service.
It is plain text with no backup of its own.

The `search_history` tool reads it: words that must all appear in one
message, an optional date range and platform, results newest first with the
lines around each match. Conversations are searchable across platforms, not
merged: a Telegram turn still sees only Telegram's recent history until she
searches. `GWEN_TIMEZONE` (an IANA zone, default `UTC`) is the zone dates are
read and shown in.

On first start against a volume with no transcript, what the stored
conversation state still holds is imported once. Imported replies carry the
time of the message they answered.

```sh
grep -i 'word' data/transcript/*.jsonl | jq -r '[.t, .adapter, .speaker, .text] | @tsv'
```

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
