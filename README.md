# Ask me anything

A worked example of a **durable, resumable, checkpointed research agent** on
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).
Ask any question; it searches the web through the Radius MCP server, classifies each
candidate source, fetches the shortlist, and writes a sourced answer under `articles/`.
Run with Node.js 24+.

```sh
npm install
npm start -- "Why is battery recycling so hard, and what changed recently?"
```

Authenticate Radius in Pi (`/login radius`) or set `RADIUS_API_KEY`.

## The durability model

The point of this repo is the boundary between *committed* work and *replayed* work. Every
boundary below is a durable commit: after a crash, work above it is reused, not repeated.

| Work | Durable unit | After a crash |
|---|---|---|
| Submitting a question | submission with a `requestId` | the same ID reattaches and replays the committed answer |
| One tool call (`web_search`, `web_fetch`, `write`, `research`) | its own `pi.tool` task | reruns only if declared `replay: "safe"`; otherwise the model sees `interrupted` |
| Research phases (search → classify → fetch) | `ask.research` checkpoints, one child task per query / URL | resumes at the last finished phase; a finished phase never reruns |
| Model turns | `pi.generation` task | resumes from the last committed entry |

What that buys you, concretely: **paid classification is never repeated.** A crash during
the fetch phase restarts fetching, not classifying. `research.test.ts` proves it with a real
`SIGKILL`: after recovery, each classifier call appears exactly once.

## Checkpointed research

`research` is one durable task (`ask.research`) whose phases each create child tasks and park
until they finish:

```text
ask.research
├── ask.search   × one per query        (Radius web search)
├── ask.classify × one per unique URL   (classifier; the paid step)
└── ask.fetch    × one per shortlisted URL
```

- Each phase commits `waiting` with its child task IDs, so the checkpoint *is* the commit.
- Each child commits its own outcome. `allSettled`: one dead source does not kill the run.
- URLs are deduplicated before classification, and only candidates above the relevance
  threshold (`0.7` by default) are fetched.
- Failures are returned as data and must be disclosed. The classifier judges **relevance**,
  not accuracy or credibility, and the writer still has to check factual claims.
- Classifier spend is reported on the tool result, so it lands in the conversation's usage.

The default classifier is `typesafe/jev-latest`. Set `TYPESAFE_API_KEY` or configure that
provider's credentials in Pi. For another classifier, set `ASK_AGENT_CLASSIFIER`, for example
`openrouter/typesafe/jev-1.13`.

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
- `ASK_AGENT_STATE_DIR` moves `.ask-agent/session.sqlite` (the whole state: transcript,
tasks, and the resume point).
- `SIGINT`/`SIGTERM` pauses instead of aborting: pending work stays resumable and
`--resume <request-id>` picks it up.

An interrupted **non**-replay-safe tool is not silently retried; a run already recorded as
terminally failed stays failed. Send a follow-up with a **new** request ID to continue with
the saved context. The chat model defaults to `radius/deepseek-v4.1-flash`; override it with
`ASK_AGENT_MODEL=provider/model-id` for a new session.

## What is portable, and what is pinned

| Swappable | Pinned |
|---|---|
| Storage: `MemoryStorage`, SQLite, JSONL, Cloudflare Durable Object, or a Dagger cache volume | The Radius MCP endpoint (`RADIUS_MCP_URL` in `ask-agent.ts`) |
| Model (`ASK_AGENT_MODEL`) and classifier (`ASK_AGENT_CLASSIFIER`) | The default classifier `typesafe/jev-latest` |
| Working directory and execution environment (`HarnessOptions.env`) | The Node image digest in `dagger.ts` |
| Research task tree: add or reorder phases in `research.ts` | Dagger's engine and its cache volumes |

`ask-agent.ts` is the wiring; `research.ts` is the durable state machine. Nothing in the
research task depends on the CLI, the storage backend, or the model provider, so the same
task runs in memory in tests and in SQLite or a Dagger volume in production.

## Reproducible runs with Dagger

`dagger.ts` runs the same agent in a pinned Node container, so the runtime and dependencies are
identical locally and in CI. Each session gets a locked Dagger cache volume holding both the
SQLite state and the articles, and artifacts are copied back to `dagger-output/<session>/articles`.

```sh
RADIUS_API_KEY=... npm run dagger -- batteries --request-id batteries-1 "Research battery recycling"
RADIUS_API_KEY=... npm run dagger -- batteries --resume batteries-1   # recover after a crash
npm run dagger -- batteries --export                                 # re-export articles only
npm run dagger:check                                                # npm test inside the image
```

- The session name selects the cache volume: reuse it to resume, use a new one for a fresh run.
- `RADIUS_API_KEY` (plus `TYPESAFE_API_KEY`/`OPENROUTER_API_KEY` when classifying) is passed as a
  Dagger secret, and `ASK_AGENT_MODEL`/`ASK_AGENT_CLASSIFIER` as ordinary environment.
- Articles are exported even when the agent exits non-zero, so partial work is not lost.
- A per-invocation nonce keeps Dagger's execution cache from replaying an agent run, while the
  dependency install still caches.
- `ponytail:` the cache volume is engine-local, recoverable state: pruning or replacing the
  engine loses it. Use external durable storage before promising recovery across engines.

## Checks

`npm test` runs offline with the real Harness and SQLite, a faux model, and a mocked Radius
MCP server:

- **Checkpoint proof:** `SIGKILL` mid-fetch, reopen the real SQLite storage in a child
  process, and assert the search and classifier calls did not repeat while the fetch did.
- Phase shape: one search child per query, one classify child per unique URL, one fetch child
  per shortlisted URL; the advertisement never reaches the model.
- Classifier failure is disclosed as a step failure and its spend still counts; a dead MCP
  server is reported, never turned into an empty answer.
- Request-ID/resume semantics, and the same crash-recovery test for a plain tool call.
- The Dagger pipeline shape.

`npm run check` is a live Radius search and chat-model catalog smoke check; it does not verify
classifier credentials or perform a paid classification.
