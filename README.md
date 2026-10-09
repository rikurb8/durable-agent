# Ask me anything

A worked example of a **durable, resumable, checkpointed agent** on
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).
Talk to it in a REPL (or submit one prompt) and it decides for itself: answer directly, search
the web through the Radius MCP server, and fetch the pages worth reading. Ask for an article and
it writes a sourced one under `articles/`; otherwise it just answers in the conversation. Run with
Node.js 24+.

```sh
npm install
npm start                         # interactive chat
npm start -- "Why is battery recycling so hard, and what changed recently?"
npm start -- "Research battery recycling and write an article"   # article only when asked
```

Set `RADIUS_API_KEY`.

## Repository layout

- `src/` — agent CLI, session handling, memory, and logging verbosity.
- `src/inspector.ts` and `src/inspector/` — read-only inspector server and browser assets.
- `scripts/` — live connectivity check and Dagger runner.
- `test/` — offline tests and the crash-recovery worker.
- `articles/` — generated articles.
- `.ask-agent/` and `dagger-output/` — local runtime state and exports (gitignored).

Use the npm commands above and below from the repository root. Source files run
directly on Node.js; there is no build step.

## The durability model

The point of this repo is the boundary between *committed* work and *replayed* work. Every
boundary below is a durable commit: after a crash, work above it is reused, not repeated.

| Work | Durable unit | After a crash |
|---|---|---|
| Submitting a question | submission with a `requestId` | the same ID reattaches and replays the committed answer |
| One tool call (`web_search`, `web_fetch`, `write`, `bash`) | its own `pi.tool` task | reruns only if declared `replay: "safe"`; otherwise the model sees `interrupted` |
| Model turns | `pi.generation` task | resumes from the last committed entry |

What that buys you, concretely: a `web_search` or `web_fetch` killed mid-flight is retried on
recovery instead of failing the turn, because it declares `replay: "safe"`. A tool with side
effects is not silently repeated; the model sees `interrupted` and decides what to do.
`test/session.test.ts` proves the first case with a real `SIGKILL` against the real SQLite state.

## Memory

The agent keeps durable notes in a session document (`ask.memory`), rendered into the system
prompt on every request, so a new turn — and a new process on the same `ASK_AGENT_STATE_DIR` —
starts with them:

- `remember(text, tags?, source?)` saves a note; identical notes are dropped.
- `recall(query)` searches the notes **and the verbatim transcript**, including the parts
  compaction has already summarized away, because pi-durable keeps every entry forever.
- `forget(id)` deletes a note that turned out wrong.

This is the cheap half of a memory tree: nothing is ever lost (the transcript is the log), and
`recall` is exact lookup instead of guided descent.

A background keeper (`ask.memory`, one per top-level conversation) maintains the notes without
the model asking. It distills transcript the agent has moved past into notes, and once the notes
pile up it consolidates them — retiring the originals rather than dropping them, so `recall` still
reaches a note that consolidation merged away. It sleeps when there is nothing to do, is marked
background so it never blocks a turn or an idle wait, and its watermark only advances on a
successful model call, so a failed batch is retried instead of lost. `ASK_AGENT_MEMORY_MODEL`
(`provider/model-id`) picks the model it uses; the default is `ASK_AGENT_MODEL`. See `src/memory.ts`.

## Read-only companion UI

```sh
npm run inspect                         # http://127.0.0.1:4317
npm run inspect -- --db /path/to/session.sqlite --port 4318
```

The local browser inspector reads `.ask-agent/session.sqlite` (or
`ASK_AGENT_STATE_DIR/session.sqlite`) without starting a Harness, resuming tasks,
or requiring model credentials. Start the CLI once to create a database first.
It works alongside the CLI and continues working after the CLI stops.

- **Timeline:** messages, expandable tool arguments/results, recorded system-prompt
  changes, and compaction/reset markers. Cards are colour-coded by kind (user, assistant,
  tool result, system), with a matching left stripe, header tint, and label. Search covers the stored transcript (including
  older entries); filters and “Load older entries” keep large transcripts browsable.
- **Inspect panel:** raw records, linked task owners/children, current checkpoints,
  terminal outcomes, and request/input/answer links.
- **Tasks:** live and completed task records, including background work.
- **Memory:** active/retired session notes, sources/tags, keeper state, and its
  processed-through entry. Older model-visible memory appears in recorded prompt changes.
- **State:** reconstructed documents, including usage, agent settings, inbox, and
  committed generation/tool partial output. Conversation spend (total cost and tokens,
  split by model and tool) is summarized above the document list.

The UI polls once per second and never writes agent state. It binds only to
`127.0.0.1`, rejects cross-origin requests, and renders stored content as text rather
than executable HTML. Use the exact printed URL; this is not a remotely hosted service.

Task status is **persisted state, not a heartbeat**: “running” can remain after a crash.
Completed tasks retain outcomes, not a full checkpoint history; memory shows its current
state, not a historical change log. This prototype understands pi-durable SQLite schema
version 1 and rejects other versions. Task/request lists are currently unpaged; very large
sessions may make polling slower. No editing, chat, runtime controls, or Dagger integration.

## Durable runs

Every run is identified by a request ID, so a retry never duplicates work:

```sh
npm start -- --request-id batteries-1 "Research battery recycling"   # submit once
npm start -- --resume batteries-1                                    # finish it after a crash
```

- `--request-id <id>` submits idempotently. The same ID with the same prompt reattaches to
the existing run and replays committed results; a different prompt is rejected.
- `--resume <id>` only waits for that run and never submits a prompt, so a typo cannot start
unrelated work. An unknown ID fails instead of creating a new request.
- With no prompt and no `--resume`, the CLI reads prompts from stdin: each line is one durable
turn in the same conversation, so context carries over. `exit`, `quit`, or Ctrl-D ends it;
Ctrl-C pauses the turn in flight and prints the request ID for `--resume`.
- `ASK_AGENT_STATE_DIR` moves `.ask-agent/session.sqlite` (the whole state: transcript,
tasks, and the resume point).
- `SIGINT`/`SIGTERM` pauses instead of aborting: pending work stays resumable and
`--resume <request-id>` picks it up.
- `--quiet`/`-q` prints only the answer; `--verbose`/`-v` adds tool arguments and results,
retries, spend, and task lifecycle; `-vv` adds turns, thinking, and checkpoints. The same
levels are available as `ASK_AGENT_VERBOSITY=quiet|normal|verbose|debug`, which Dagger
forwards into the container.

An interrupted **non**-replay-safe tool is not silently retried; a run already recorded as
terminally failed stays failed. Send a follow-up with a **new** request ID to continue with
the saved context. The chat model defaults to `radius/deepseek-v4.1-flash`; override it with
`ASK_AGENT_MODEL=provider/model-id` for a new session.

## What is portable, and what is pinned

| Swappable | Pinned |
|---|---|
| Storage: `MemoryStorage`, SQLite, JSONL, Cloudflare Durable Object, or a Dagger cache volume | The Radius MCP endpoint (`RADIUS_MCP_URL` in `src/ask-agent.ts`) |
| Model (`ASK_AGENT_MODEL`) and memory model (`ASK_AGENT_MEMORY_MODEL`) | The Radius tool names `tools_webSearch_run` / `tools_webFetch_run` |
| Working directory and execution environment (`HarnessOptions.env`) | The Node image digest in `scripts/dagger.ts` |

`src/ask-agent.ts` is the wiring; the web tools are a few lines each, and the durable machinery
(task scheduling, replay, checkpoints) lives in pi-durable rather than here.

## Reproducible runs with Dagger

`scripts/dagger.ts` runs the same agent in a pinned Node container, so the runtime and dependencies are
identical locally and in CI. Each session gets a locked Dagger cache volume holding both the
SQLite state and the articles, and artifacts are copied back to `dagger-output/<session>/articles`.

```sh
RADIUS_API_KEY=... npm run dagger -- batteries --request-id batteries-1 "Research battery recycling"
RADIUS_API_KEY=... npm run dagger -- batteries --resume batteries-1   # recover after a crash
npm run dagger -- batteries --export                                 # re-export articles only
npm run dagger:check                                                # npm test inside the image
```

- The session name selects the cache volume: reuse it to resume, use a new one for a fresh run.
- `RADIUS_API_KEY` is passed as a Dagger secret, and `ASK_AGENT_MODEL`/`ASK_AGENT_VERBOSITY` as
  ordinary environment.
- Articles are exported even when the agent exits non-zero, so partial work is not lost.
- A per-invocation nonce keeps Dagger's execution cache from replaying an agent run, while the
  dependency install still caches.
- `ponytail:` the cache volume is engine-local, recoverable state: pruning or replacing the
  engine loses it. Use external durable storage before promising recovery across engines.

## Checks

`npm test` runs offline with the real Harness and SQLite, a faux model, and a mocked Radius
MCP server:

- **Replay proof:** `SIGKILL` mid-`web_fetch`, reopen the real SQLite storage in a child
  process, and assert the committed search is not repeated, the interrupted fetch is rerun, and
  the article is written once.
- Memory: note rendering and its cap, `remember` deduplication, `recall` finding both a note and
  a transcript hit, the keeper distilling without the model asking, consolidation retiring the
  originals, and a note surviving a close/reopen of the SQLite state.
- Request-ID/resume semantics, and the same crash-recovery test for a plain tool call.
- The Dagger pipeline shape.

`npm run check` is a live Radius search and chat-model catalog smoke check; it does not verify
model credentials.
