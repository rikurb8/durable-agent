# Task manager implementation plan

## Goal and scope

Turn the inspector into a local task manager that can create, run, monitor, pause, and resume independent agent jobs. Keep the existing inspector as the execution-detail view.

For v1, **complete means the current durable submission returned its terminal outcome**. It does not mean an independent evaluator has verified the user's objective. No autonomous follow-up loop.

Decisions:

- One user task owns one pi-durable database, root conversation, and workspace.
- Follow-ups reuse that task's conversation and workspace, with a new request ID.
- New tasks start fresh; no shared memory or implicit context inheritance.
- One manager process owns execution. The runner is a module in that process, not a second service or scheduler.
- Start with one active task globally and a persistent FIFO queue. Retain a per-task ownership invariant before adding concurrency.
- Closing the browser does not stop work. Stopping the manager suspends execution; restarting it recovers eligible work.
- Preserve the existing standalone CLI and read-only inspector. They must not write manager-owned databases directly.

**MVP gate:** Milestones 1–3 are the MVP: a durable runner, persistent admission queue, and recovery, drivable from the CLI and viewable through the existing read-only inspector. Milestones 4–5 (HTTP API and task-first UI) are follow-on work. Land and verify M1–M3 — especially the pause/close/reattach cycle and lock release — before starting M4.

## Architecture

```text
Browser task manager
    | local HTTP commands + polling
Manager server
    | catalog / durable command admission / queue / ownership
Task runner (one active execution in v1)
    | submit or reattach by request ID; wait for terminal result
pi-durable Harness
    | generations / tools / checkpoints / replay
Task database + task workspace
```

Suggested layout, under a configurable manager state root:

```text
.ask-agent/tasks/
  manager.sqlite
  owner.sqlite
  <task-id>/
    session.sqlite
    workspace/
      articles/
```

`manager.sqlite` stores user-facing metadata and durable execution intent. Each `session.sqlite` remains authoritative for its submissions, transcript, tool execution, and results. Do not copy the full durable task graph into the catalog.

`owner.sqlite` is a separate lock-only database: hold a `BEGIN IMMEDIATE` transaction for the manager lifetime, using a zero busy timeout. A second manager for the same root must fail before dispatching work. This uses Node's existing SQLite support; process death releases the database lock without PID-file cleanup. Validate this behavior in the first milestone. Restrict v1 to local filesystems.

All manager-owned execution goes through the manager API. This lock cannot protect against an unrelated program deliberately opening a task's session database.

## Identity and state

A **task ID** identifies the workspace/conversation. A **request ID** identifies one initial request or follow-up within that task. Keep these separate from internal pi-durable task IDs.

Minimal catalog:

- Tasks: ID, initial objective, creation time, selected model.
- Requests: task ID, request ID, exact prompt, queue order, desired state (`run` or `pause`), admission time, recovery-attempt count, last runner error, and a `pre_model` flag for failures before model execution.
- Completion summaries may be cached for task-list rendering, but reconcile them against the session database after interruption.

Task-list status describes the latest request:

| Status | Meaning |
| --- | --- |
| Queued | Durable request exists; execution has not acquired the slot. |
| Running | This manager currently owns a live runner for the request. |
| Paused | Pause intent persisted; the runner is closing or no live runner remains. |
| Recovering | Unsettled, no live runner, and eligible for automatic recovery. |
| Interrupted | Execution stopped without a durable terminal outcome and automatic recovery is exhausted or declined. |
| Completed | Submission returned `done`; show its answer. |
| Failed | Submission returned terminally unanswered, or a pre-model failure (credentials, MCP, config) prevented execution. Pre-model failures set `pre_model = 1` and never count as a recovery attempt. |

The derivation table under "Resolved implementation decisions" (decision 5) is authoritative for how these statuses are computed.

Manager availability is separate from task status. A stale browser must show disconnected/stale data, not imply a live runner from a stored `running` value.

A follow-up is allowed only after the previous request settles. Paused or interrupted work must be resumed first; v1 does not support abandoning it to submit unrelated work.

## Milestone 1 — Extract execution and prove ownership

Files: `src/ask-agent.ts` (modify), new `src/runner.ts`, `src/session.ts` (modify), focused runner tests.

- Extract harness/model/tool setup and submit/wait/close behavior from CLI presentation.
- Pass state directory, workspace, model, request, and cancellation explicitly.
- Keep process signals, readline, and stdout formatting in the CLI adapter.
- Reuse `selectSubmission()` and its exact request-ID/prompt checks.
- Use the task workspace for agent `cwd` and `NodeExecutionEnv`; never use `process.chdir()`.
- Preserve safe-tool replay and interrupted unsafe-tool behavior.
- Ensure a paused run closes its Harness and resources before releasing ownership.
- Prove the manager-root lock excludes a second process and is released after `SIGKILL`.

Acceptance:

- Existing CLI, REPL, Dagger, and crash-recovery tests still pass.
- Two independent state/workspace pairs cannot mix transcript or output files under normal relative-path use.
- Lock contention fails clearly without opening a writable task Harness.

## Milestone 2 — Persist task admission and dispatch

Files: new `src/task-store.ts`, `src/task-manager.ts`, store/manager tests, `.gitignore` if necessary.

- Create a versioned catalog with task and request records using `node:sqlite`.
- Generate opaque task IDs; derive all filesystem paths from validated IDs, not prompt text.
- Persist task creation and its initial request atomically before acknowledging the API call.
- Require a client-generated creation idempotency key. Repeating the same command returns the same task; conflicting payloads fail.
- Persist follow-up request IDs and exact prompts before execution.
- Create workspace directories idempotently during dispatch. A failed directory setup leaves a visible, recoverable request rather than silently dropping it.
- Dispatch the oldest eligible request, opening only its Harness.
- There is no atomic transaction spanning catalog and task DB. Close that gap through idempotency: replay the catalog intent with the same request ID and prompt until submission exists, then reattach.
- Prove the reattach path: a submission interrupted by `harness.close()` resumes when the Harness is reopened and waited, with the same request ID and no `submission.abort()`.
- If a submission already settled before a manager crash, reconcile its outcome instead of submitting it again.
- Persist completion summaries only after reading the durable outcome.

Acceptance:

- Repeated create/follow-up commands never duplicate tasks or submissions.
- Faults before submission, after submission, and after outcome persistence all converge on one committed answer.
- One active runner maximum; other tasks remain queued across restarts.
- A task with no session DB yet still appears in the manager and can be paused.
- Pause then reopen then wait completes the same request with its durable work intact (no duplicate submission, no lost turn).

## Milestone 3 — Recovery and lifecycle controls

Files: manager/runner modules and process-level tests.

- On startup, acquire ownership before inspecting and dispatching pending execution intent.
- Reconcile unsettled requests against their task DBs. Resume only those whose durable intent is `run`.
- Pause: persist pause intent first, then cancel the wait and close the Harness. Do not terminally abort the conversation. Pause on a request that has not been dispatched is a catalog state flip only; cancel-and-close applies once a Harness is open.
- Resume: change intent back to `run` and enqueue the same request; never generate a replacement request ID.
- Graceful manager shutdown: stop admission/dispatch, close active execution, then release ownership. Leave `run` intent intact for recovery on restart.
- Distinguish user pause from process shutdown so shutdown does not accidentally make every task manually paused.
- Recover interrupted, nonterminal work; never automatically retry a terminally failed submission.
- Bound automatic recovery attempts per request (initially three, persisted). Exhaustion leaves the task interrupted with an explicit error and a manual resume action.
- Failures before model execution, such as missing credentials, remain visible and do not cause a tight restart loop.
- A manager process killed by the OS needs to be restarted by the user or an external service supervisor. In-process supervision cannot restart its own host.

Acceptance:

- `SIGKILL` and restart reuse committed safe work; interrupted unsafe tools are not silently replayed.
- Pause survives a restart and never auto-resumes.
- Shutdown during request admission or completion loses no accepted command.
- Completed/failed requests do not run again after restart.
- An unrecoverable startup or model failure stops after bounded attempts.

## Milestone 4 — Local manager API

Files: new `src/manager.ts` entry point; reuse `src/inspector.ts` snapshot reader.

Routes:

- `GET /api/tasks` — summaries, runner liveness, and manager availability.
- `POST /api/tasks` — idempotently create and queue a task.
- `GET /api/tasks/:id` — objective, requests, latest result, status, and errors.
- `POST /api/tasks/:id/requests` — admit a follow-up.
- `POST /api/tasks/:id/pause` and `/resume` — idempotent lifecycle commands.
- `GET /api/tasks/:id/state` — existing inspector snapshot, scoped to that task DB. Answer empty until the task's `session.sqlite` exists; never call `openInspector` on a missing database.

Keep HTTP handlers thin: validate, persist a command, return promptly. No request handler waits for model completion.

Security requirements:

- Bind only to `127.0.0.1`; enforce the exact Host and same-origin checks.
- Mutation endpoints require JSON and same-origin browser requests: the inspector's exact Host check, `Origin` match, and `Sec-Fetch-Site` rejection. No capability token in v1; the manager is a trusted local tool.
- Bound body/prompt sizes; reject unknown fields, invalid IDs, and invalid lifecycle transitions.
- Do not accept arbitrary filesystem paths, environment variables, shell commands for runner launch, or provider secrets through this API.
- Credentials remain server-side; existing task viewing works without model credentials.
- Render all stored text as text. Do not serve workspace HTML or arbitrary filesystem paths.
- Reuse short read-only inspector transactions; close per-task reader connections rather than retaining an unbounded pool.

Acceptance:

- Foreign-origin, malformed, oversized, traversal, and conflicting requests fail without side effects.
- API acknowledges only persisted commands.
- Existing read-only inspector remains GET-only and needs no credentials.

## Milestone 5 — Task-first UI

Files: `src/inspector/index.html`, `app.js`, `style.css`; manager asset wiring.

- Add task list, create form, status, latest error, and result view.
- Add pause/resume and follow-up controls with visible pending/error states.
- Preserve the same command ID across network retries; do not create another task when an acknowledgement is lost.
- Task detail embeds the existing timeline, raw records, state/spend, and internal task tree.
- Relabel the internal Tasks tab as Execution to distinguish it from user-facing tasks.
- Show workspace-relative artifact paths and the local workspace location; defer browser download/preview endpoints.
- Retain one-second polling initially. Stop stale responses from replacing the selected task, and reset pagination/selection on task changes.
- Preserve keyboard access, labels, focus, and understandable disabled-control explanations.
- Keep standalone `npm run inspect -- --db ...` in read-only mode; controls appear only in manager mode.

Acceptance:

- Create → queue → run → complete can be followed entirely in the browser.
- Closing/reopening the tab reattaches to the same task.
- Follow-ups preserve context; a new task does not inherit another task's context.
- Switching tasks never displays another task's transcript, state, or result.
- A stopped manager is visibly disconnected; stored running state is not presented as fresh liveness.

## Milestone 6 — End-to-end checks and documentation

- Add offline end-to-end tests using the faux model and real SQLite databases.
- Cover multi-task isolation, queue order, idempotent admission, pause/resume, terminal failure, bounded recovery, and restart reconciliation.
- Keep existing inspector observational/security tests and CLI/Dagger coverage.
- Add `npm run manage`; document the state root, ownership rules, model credentials, startup/shutdown, and recovery behavior.
- Document that v1 never deletes task directories: `<root>/<task-id>/workspace/` grows without bound and needs manual cleanup.
- Leave `.ask-agent/session.sqlite` and Dagger sessions untouched. No automatic migration/import into managed tasks.
- Manually check browser navigation, keyboard interaction, long results, empty tasks, and disconnected states.

Definition of done: a task created from the UI survives a manager crash and restart without duplicating committed work, finishes with a visible result, and remains inspectable without a live runner or credentials.

## Resolved implementation decisions

Captured from the plan review. Implement these as written unless a milestone forces a change.

### Runner and ownership (M1)

1. **Runner boundary.** `src/runner.ts` owns MCP connect, `Harness.open`, submit/wait, and close in one `try/finally`, plus the `AbortController`. It returns a typed result (`{ status, answerText, usage }` or a pre-model failure) and never writes to stdout. `src/ask-agent.ts` keeps signals, readline, and formatting. Connect MCP and resolve the model before `Harness.open`, so a pre-model failure returns before any Harness exists (decision 3 depends on this order).
2. **Pause/shutdown cancellation.** Abort the wait signal and `harness.close()`. Never call `submission.abort()`, which would terminally withdraw the request.
3. **Pre-model failures.** `connectRadiusMcp`, model resolution, and missing credentials return a distinct pre-model failure. The manager maps it to `Failed` with `pre_model = 1` and never counts it as a recovery attempt.
4. **Ownership lock.** `owner.sqlite` uses the default journal mode (no WAL) and `new DatabaseSync(path, { timeout: 0 })`. Acquire `BEGIN IMMEDIATE` before opening `manager.sqlite` or any task database. On `SQLITE_BUSY`, exit non-zero naming the state root. Test two-process contention and `SIGKILL` release.

### Catalog and dispatch (M2)

5. **Status derivation.** Compute task status at read time from `desired_state`, the latest durable submission status, and runner liveness. Never store `Running`.

| Durable submission | desired `run`, runner live | desired `run`, no runner | desired `pause` |
| --- | --- | --- | --- |
| absent or `queued` | Queued | Queued | Paused |
| `placed` | Running | Recovering, or Interrupted once recovery attempts are exhausted | Paused |
| `done` | Completed | Completed | Completed |
| `unanswered` | Failed | Failed | Failed |

6. **Queue order.** Persist a monotonic `queue_seq`. Dispatch scans ascending and skips requests whose desired state is `pause` or that already settled; never reorder. Resume flips `desired_state` back to `run` and keeps the original `queue_seq`.
7. **Session is authoritative.** On dispatch and startup, read the session database first: absent submission → submit; `queued`/`placed` → reattach and wait; `done`/`unanswered` → persist the summary and stop. Never submit when a record exists.
8. **Catalog schema.** `tasks(id, objective, model_provider, model_id, created_at, workspace_path)` and `requests(task_id, request_id, prompt, queue_seq, desired_state, attempts, attempt_seq, pre_model, last_error, summary_status, summary_text, admitted_at)`, primary key `(task_id, request_id)`, plus a unique creation-idempotency key and a `manager_schema` version row.
9. **Model selection.** Server-side default from `ASK_AGENT_MODEL`; accept a request model string only when it is on a server-configured allowlist. Pass `{ provider, modelId }` explicitly to the runner. Never relay provider secrets.

### Recovery and lifecycle (M3)

10. **Recovery attempts.** Increment when dispatch opens a Harness for an unsettled `run` request, recording `attempt_seq` (the session's current entry sequence). On reconcile, reset `attempts` to 0 if the session's entry sequence advanced past `attempt_seq` — a run that made durable progress is not a crash loop. Pre-model failures do not increment. Reset on follow-up admission or manual resume. Exhaustion leaves the request `Interrupted` with `last_error` and requires manual resume.
11. **Resume semantics.** Manual resume resets the attempt counter and sets `desired_state = run`. Automatic recovery only considers unsettled `run` requests under the bound, and never retries `done` or `unanswered` requests.
12. **Graceful shutdown.** Stop admission, cancel the active wait, close the Harness, release ownership, exit 0, and never write `desired_state`. A left `placed` request is recovered on the next start.
13. **Startup order.** Acquire ownership, then open/migrate the catalog, then reconcile unsettled requests against their sessions, then dispatch. A failed lock acquisition opens no task database.

### API (M4)

14. **Separate server.** `src/manager.ts` is its own server. Reuse `openInspector(path)` for `GET /api/tasks/:id/state` with one short-lived reader connection per request. Leave `src/inspector.ts` a GET-only, credential-free inspector.
15. **Mutation origin checks.** Mutations require JSON and pass the inspector's exact Host, `Origin`, and `Sec-Fetch-Site` checks. No capability token in v1: a local process that could read a token can already open the task database directly.
16. **Request validation.** JSON content type, 64 KB body cap, unknown fields rejected, task IDs matching the UUID shape, request IDs matching the existing `parseRequest` regex, explicit lifecycle transitions, non-empty prompts. Reuse the inspector's Host/origin/`Sec-Fetch-Site` checks and CSP.

### UI (M5)

17. **Manager mode detection.** Manager mode is `GET /api/tasks` succeeding; the read-only inspector answers `404` for that route. No token, no second asset set, no build step.
18. **Polling and reconciliation.** Poll `/api/tasks` at one second from the catalog only. Reconcile a cached summary against the session database when the detail view opens or after an interruption, not every tick.

### Cross-cutting

19. **Identifiers and paths.** Task IDs are `crypto.randomUUID()` and must match `^[0-9a-f-]{36}$` before any path join; paths are always `<root>/<task-id>/`. Never derive a path from prompt text.
20. **Workspace lifecycle.** Create `<task-id>/workspace/` at task creation and re-assert `mkdir -p` before opening the Harness. A failed setup leaves a visible `Failed` request with `pre_model = 1`.

## Explicitly deferred

- Objective evaluators, autonomous continuation loops, and proof that an answer satisfies the objective.
- Shared memory, automatic context inheritance, dependencies between user tasks, and distributed workers.
- Parallel task execution, remote hosting, multi-user authentication, and deployment/service installation.
- Git worktrees, container execution, and Dagger integration for managed tasks.
- Task deletion, artifact upload/download/preview, and legacy-session import. (v1 task directories therefore grow without bound.)
- Hard spending caps and tool approval workflows. The UI must clearly state that tasks use credentials and may incur cost while the manager is running.

Workspace separation is organizational, not a security sandbox: existing shell/file tools can access paths outside their working directory. Keep v1 local and trusted; do not describe it as safe execution of untrusted jobs.
