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

- `src/` — agent CLI (`ask-agent.ts`), execution boundary (`runner.ts`), task catalog (`task-store.ts`), dispatcher (`task-manager.ts`), manager API (`manager.ts`), session handling, and logging verbosity.
- `src/inspector.ts` and `src/inspector/` — read-only inspector / manager browser assets.
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

The custom memory tools and background keeper have been removed; conversation transcripts
and normal context compaction remain. Existing databases are not rewritten: old notes and
keeper records remain inspectable under State/Tasks, but the keeper no longer runs.
Resuming a turn interrupted inside a removed memory tool is not supported; use a new
request ID for a follow-up instead.

## Local task manager

The task manager turns the same durable Harness into a small local job runner: create a task,
queue follow-ups, pause and resume, and watch the run in the browser. It keeps the standalone
CLI and the read-only inspector unchanged.

```sh
RADIUS_API_KEY=... npm run manage              # http://127.0.0.1:4318
RADIUS_API_KEY=... npm run manage -- --root /path/to/tasks --port 4319
```

State root (default `.ask-agent/tasks`, or `ASK_AGENT_MANAGER_ROOT`):

```text
<root>/
  manager.sqlite        task + request catalog (metadata and execution intent)
  owner.sqlite          process ownership lock, held for the manager's lifetime
  <task-id>/
    session.sqlite      that task's pi-durable database, authoritative for its run
    workspace/          the agent's working directory for the task
```

- **One task owns one database, conversation, and workspace.** A follow-up reuses them with a
  new request ID. A new task starts fresh; there is no shared memory or context inheritance.
- **One active runner at a time.** Other requests wait in a persistent FIFO queue and start in
  admission order. Task status is derived at read time from persisted intent plus runner
  liveness, never stored as a heartbeat.
- **Closing the browser does not stop work.** Stopping the manager pauses execution; restarting
  it recovers unsettled `run` intent. Paused work never auto-resumes.
- **Only one manager may own a root.** A second process fails immediately, before opening the
  catalog or any task database. Process death releases the lock, so no PID file can go stale.
- Credentials stay server-side. The manager accepts a model only from its allowlist
  (`ASK_AGENT_MODEL`, plus `ASK_AGENT_MODELS=provider/model,...`), and never relays secrets.
- Mutations bind to `127.0.0.1` and pass the inspector's exact Host, Origin, and Sec-Fetch-Site
  checks. No capability token: a local process that could read one can already open the
  databases directly.

Recovery: interrupted, nonterminal requests retry automatically at most three times; a run that
made durable progress (its session sequence advanced) resets that bound. Exhaustion leaves the
task **Interrupted** with its last error and a manual **Resume**. Pre-model failures (missing
credentials, MCP connect, model resolution) are **Failed**, count no attempt, and never loop.
Terminal `done`/`unanswered` requests are never resubmitted.

Limits of v1: the manager never deletes task directories, so
`<root>/<task-id>/workspace/` grows without bound and needs manual cleanup. Managed tasks do not
import `.ask-agent/session.sqlite` or Dagger sessions, and there is no task deletion, artifact
download, parallel execution, or spending cap. Workspace separation is organizational, not a
security sandbox: shell and file tools can reach outside their working directory.

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
- **State:** reconstructed documents, including usage, agent settings, inbox, and
  committed generation/tool partial output. Conversation spend (total cost and tokens,
  split by model and tool) is summarized above the document list.

The UI polls once per second and never writes agent state. It binds only to
`127.0.0.1`, rejects cross-origin requests, and renders stored content as text rather
than executable HTML. Use the exact printed URL; this is not a remotely hosted service.

When served by the task manager instead of `npm run inspect`, the same assets add a task
list, a create form, pause/resume, follow-ups, the latest result and error, and the task's
local workspace path. Task detail embeds the timeline, raw records, state/spend, and the
internal task tree (the internal tab is labelled **Execution** to distinguish it from
user-facing tasks). A stopped manager shows **MANAGER OFFLINE** and marks stored summaries
stale rather than presenting them as fresh liveness. The standalone inspector stays
read-only: no controls appear without the manager.

Task status is **persisted state, not a heartbeat**: “running” can remain after a crash.
Completed tasks retain outcomes, not a full checkpoint history. This prototype understands pi-durable SQLite schema
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
| Model (`ASK_AGENT_MODEL`) | The Radius tool names `tools_webSearch_run` / `tools_webFetch_run` |
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
- Request-ID/resume semantics, and the same crash-recovery test for a plain tool call.
- Runner/ownership boundaries: pre-model failures create no database, a paused run reattaches
  without a duplicate turn, and the root lock excludes a second process and survives `SIGKILL`.
- Manager catalog and dispatch: idempotent creation/follow-ups, queue order, one active runner,
  task isolation, pause/resume across restarts, bounded recovery, and terminal failures.
- Manager API boundaries: loopback/same-origin/Host checks, JSON and size validation, unknown
  fields, invalid IDs, and empty state for a task without a session database.
- The Dagger pipeline shape.

`npm run check` is a live Radius search and chat-model catalog smoke check; it does not verify
model credentials.
