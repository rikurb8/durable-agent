/**
 * Versioned catalog of user tasks and their durable execution intent.
 *
 * `manager.sqlite` holds user-facing metadata and intent only. Each task's
 * `session.sqlite` stays authoritative for submissions, transcripts, tool
 * execution, and results; the catalog never copies that graph.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const MANAGER_SCHEMA_VERSION = 1;
/** Automatic recovery dispatches per request before it needs a manual resume. */
export const MAX_RECOVERY_ATTEMPTS = 3;
/** Task IDs are UUIDs; validated before any path join. */
export const TASK_ID_PATTERN = /^[0-9a-f-]{36}$/;

export type DesiredState = "run" | "pause";
export type SummaryStatus = "queued" | "placed" | "done" | "unanswered";
export type TaskStatus = "Queued" | "Running" | "Paused" | "Recovering" | "Interrupted" | "Completed" | "Failed";

export type TaskRecord = {
	readonly id: string;
	readonly objective: string;
	readonly modelProvider: string;
	readonly modelId: string;
	readonly createdAt: number;
	readonly workspacePath: string;
};

export type RequestRecord = {
	readonly taskId: string;
	readonly requestId: string;
	readonly prompt: string;
	readonly queueSeq: number;
	readonly desiredState: DesiredState;
	readonly attempts: number;
	readonly attemptSeq: number;
	readonly preModel: boolean;
	readonly lastError: string | null;
	readonly summaryStatus: SummaryStatus | null;
	readonly summaryText: string | null;
	readonly admittedAt: number;
};

type TaskRow = {
	id: string; objective: string; model_provider: string; model_id: string; created_at: number; workspace_path: string; creation_key: string;
};
type RequestRow = {
	task_id: string; request_id: string; prompt: string; queue_seq: number; desired_state: DesiredState; attempts: number;
	attempt_seq: number; pre_model: number; last_error: string | null; summary_status: SummaryStatus | null; summary_text: string | null; admitted_at: number;
};

const toTask = (row: TaskRow): TaskRecord => ({
	id: row.id, objective: row.objective, modelProvider: row.model_provider, modelId: row.model_id,
	createdAt: row.created_at, workspacePath: row.workspace_path,
});
const toRequest = (row: RequestRow): RequestRecord => ({
	taskId: row.task_id, requestId: row.request_id, prompt: row.prompt, queueSeq: row.queue_seq, desiredState: row.desired_state,
	attempts: row.attempts, attemptSeq: row.attempt_seq, preModel: row.pre_model === 1, lastError: row.last_error,
	summaryStatus: row.summary_status, summaryText: row.summary_text, admittedAt: row.admitted_at,
});

/** Whether a request may be superseded by a follow-up: a terminal durable outcome or a pre-model failure. */
export function isSettled(request: RequestRecord): boolean {
	return request.summaryStatus === "done" || request.summaryStatus === "unanswered" || request.preModel;
}

/**
 * Task status is derived at read time, never stored (decision 5).
 * `live` means this manager currently owns a live runner for the request.
 */
export function deriveStatus(request: RequestRecord, live: boolean): TaskStatus {
	if (request.summaryStatus === "done") return "Completed";
	if (request.summaryStatus === "unanswered") return "Failed";
	if (request.desiredState === "pause") return "Paused";
	if (live) return request.summaryStatus === "placed" ? "Running" : "Queued";
	if (request.preModel) return "Failed";
	if (request.attempts >= MAX_RECOVERY_ATTEMPTS) return "Interrupted";
	return request.summaryStatus === "placed" ? "Recovering" : "Queued";
}

export class TaskStore {
	#db: DatabaseSync;

	private constructor(db: DatabaseSync) {
		this.#db = db;
	}

	static open(root: string): TaskStore {
		mkdirSync(root, { recursive: true });
		const db = new DatabaseSync(join(root, "manager.sqlite"));
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL");
		db.exec(`CREATE TABLE IF NOT EXISTS manager_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL)`);
		const version = db.prepare("SELECT version FROM manager_schema WHERE singleton = 1").get() as { version: number } | undefined;
		if (version !== undefined && version.version !== MANAGER_SCHEMA_VERSION) {
			db.close();
			throw new Error(`Unsupported manager schema ${version.version}; expected ${MANAGER_SCHEMA_VERSION}.`);
		}
		db.exec(`
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				objective TEXT NOT NULL,
				model_provider TEXT NOT NULL,
				model_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				workspace_path TEXT NOT NULL,
				creation_key TEXT NOT NULL UNIQUE
			) STRICT;
			CREATE TABLE IF NOT EXISTS requests (
				task_id TEXT NOT NULL REFERENCES tasks(id),
				request_id TEXT NOT NULL,
				prompt TEXT NOT NULL,
				queue_seq INTEGER NOT NULL UNIQUE,
				desired_state TEXT NOT NULL CHECK (desired_state IN ('run', 'pause')),
				attempts INTEGER NOT NULL DEFAULT 0,
				attempt_seq INTEGER NOT NULL DEFAULT 0,
				pre_model INTEGER NOT NULL DEFAULT 0 CHECK (pre_model IN (0, 1)),
				last_error TEXT,
				summary_status TEXT CHECK (summary_status IN ('queued', 'placed', 'done', 'unanswered')),
				summary_text TEXT,
				admitted_at INTEGER NOT NULL,
				PRIMARY KEY (task_id, request_id)
			) STRICT;
		`);
		if (version === undefined) db.prepare("INSERT INTO manager_schema (singleton, version) VALUES (1, ?)").run(MANAGER_SCHEMA_VERSION);
		return new TaskStore(db);
	}

	close(): void {
		this.#db.close();
	}

	#transaction<T>(change: () => T): T {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const result = change();
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	#task(id: string): TaskRecord | undefined {
		const row = this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
		return row && toTask(row);
	}

	#requests(taskId: string): RequestRecord[] {
		return (this.#db.prepare("SELECT * FROM requests WHERE task_id = ? ORDER BY queue_seq ASC").all(taskId) as RequestRow[]).map(toRequest);
	}

	#latestRequest(taskId: string): RequestRecord | undefined {
		const row = this.#db.prepare("SELECT * FROM requests WHERE task_id = ? ORDER BY queue_seq DESC LIMIT 1").get(taskId) as RequestRow | undefined;
		return row && toRequest(row);
	}

	#nextSeq(): number {
		const row = this.#db.prepare("SELECT COALESCE(MAX(queue_seq), 0) + 1 AS next FROM requests").get() as { next: number };
		return row.next;
	}

	#findRequest(taskId: string, requestId: string): RequestRecord | undefined {
		const row = this.#db.prepare("SELECT * FROM requests WHERE task_id = ? AND request_id = ?").get(taskId, requestId) as RequestRow | undefined;
		return row && toRequest(row);
	}

	/** Task plus its first (initial) request, or undefined. */
	task(id: string): { task: TaskRecord; requests: RequestRecord[] } | undefined {
		const task = this.#task(id);
		return task && { task, requests: this.#requests(id) };
	}

	latestRequest(taskId: string): RequestRecord | undefined {
		return this.#latestRequest(taskId);
	}

	listTasks(): { task: TaskRecord; latest: RequestRecord | undefined }[] {
		return (this.#db.prepare("SELECT * FROM tasks ORDER BY created_at ASC, id ASC").all() as TaskRow[]).map((row) => {
			const task = toTask(row);
			return { task, latest: this.#latestRequest(task.id) };
		});
	}

	/**
	 * Persist a task and its initial request atomically. A repeated creation key
	 * returns the original task; a key reused with a different payload fails.
	 */
	createTask(input: {
		creationKey: string; taskId: string; requestId: string; objective: string; modelProvider: string; modelId: string;
		now: number; workspacePath: string;
	}): { task: TaskRecord; request: RequestRecord; created: boolean } {
		const existing = this.#db.prepare("SELECT * FROM tasks WHERE creation_key = ?").get(input.creationKey) as TaskRow | undefined;
		if (existing) {
			const task = toTask(existing);
			if (task.objective !== input.objective || task.modelProvider !== input.modelProvider || task.modelId !== input.modelId) {
				throw new ConflictError("Creation key already belongs to a different task payload.");
			}
			return { task, request: this.#requests(task.id)[0]!, created: false };
		}
		return this.#transaction(() => {
			this.#db.prepare("INSERT INTO tasks (id, objective, model_provider, model_id, created_at, workspace_path, creation_key) VALUES (?, ?, ?, ?, ?, ?, ?)")
				.run(input.taskId, input.objective, input.modelProvider, input.modelId, input.now, input.workspacePath, input.creationKey);
			this.#db.prepare("INSERT INTO requests (task_id, request_id, prompt, queue_seq, desired_state, admitted_at) VALUES (?, ?, ?, ?, 'run', ?)")
				.run(input.taskId, input.requestId, input.objective, this.#nextSeq(), input.now);
			return { task: this.#task(input.taskId)!, request: this.#findRequest(input.taskId, input.requestId)!, created: true };
		});
	}

	/** Admit a follow-up. A repeated request ID returns the original; a changed prompt fails. */
	addRequest(input: { taskId: string; requestId: string; prompt: string; now: number }): { request: RequestRecord; created: boolean } {
		const latest = this.#latestRequest(input.taskId);
		if (latest === undefined) throw new NotFoundError(`Unknown task ${input.taskId}.`);
		const existing = this.#findRequest(input.taskId, input.requestId);
		if (existing) {
			if (existing.prompt !== input.prompt) throw new ConflictError("Request ID already belongs to a different prompt.");
			return { request: existing, created: false };
		}
		if (!isSettled(latest)) throw new ConflictError("The previous request has not settled; resume or wait for it first.");
		return this.#transaction(() => {
			this.#db.prepare("INSERT INTO requests (task_id, request_id, prompt, queue_seq, desired_state, admitted_at) VALUES (?, ?, ?, ?, 'run', ?)")
				.run(input.taskId, input.requestId, input.prompt, this.#nextSeq(), input.now);
			return { request: this.#findRequest(input.taskId, input.requestId)!, created: true };
		});
	}

	exists(taskId: string): boolean {
		return this.#db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId) !== undefined;
	}

	/** Oldest eligible request: run intent, no pre-model failure, under the recovery bound, unsettled. */
	nextEligible(maxAttempts: number): RequestRecord | undefined {
		const row = this.#db.prepare(`
			SELECT * FROM requests
			WHERE desired_state = 'run' AND pre_model = 0 AND attempts < ?
				AND (summary_status IS NULL OR summary_status IN ('queued', 'placed'))
			ORDER BY queue_seq ASC LIMIT 1
		`).get(maxAttempts) as RequestRow | undefined;
		return row && toRequest(row);
	}

	/** Unsettled run intent, for startup reconciliation against each session database. */
	unsettledRunRequests(): RequestRecord[] {
		return (this.#db.prepare(`
			SELECT * FROM requests
			WHERE desired_state = 'run' AND pre_model = 0
				AND (summary_status IS NULL OR summary_status IN ('queued', 'placed'))
			ORDER BY queue_seq ASC
		`).all() as RequestRow[]).map(toRequest);
	}

	#update(sql: string, ...args: SQLInputValue[]): void {
		this.#db.prepare(sql).run(...args);
	}

	setDesiredState(taskId: string, requestId: string, desiredState: DesiredState): void {
		this.#update("UPDATE requests SET desired_state = ? WHERE task_id = ? AND request_id = ?", desiredState, taskId, requestId);
	}

	/** Record that dispatch opened a Harness; `attemptSeq` is the session entry sequence at open. */
	beginAttempt(taskId: string, requestId: string, attemptSeq: number): void {
		this.#update("UPDATE requests SET attempts = attempts + 1, attempt_seq = ? WHERE task_id = ? AND request_id = ?", attemptSeq, taskId, requestId);
	}

	/** Count a dispatch that failed before a Harness opened, so a broken task cannot loop forever. */
	recordFailure(taskId: string, requestId: string, error: string): void {
		this.#update("UPDATE requests SET attempts = attempts + 1, last_error = ? WHERE task_id = ? AND request_id = ?", error, taskId, requestId);
	}

	resetAttempts(taskId: string, requestId: string): void {
		this.#update("UPDATE requests SET attempts = 0 WHERE task_id = ? AND request_id = ?", taskId, requestId);
	}

	/** Manual resume: run intent, fresh recovery budget, clear pre-model failure. */
	resume(taskId: string, requestId: string): void {
		this.#update(
			"UPDATE requests SET desired_state = 'run', attempts = 0, attempt_seq = 0, pre_model = 0, last_error = NULL WHERE task_id = ? AND request_id = ?",
			taskId, requestId,
		);
	}

	setSummaryStatus(taskId: string, requestId: string, status: SummaryStatus): void {
		this.#update("UPDATE requests SET summary_status = ? WHERE task_id = ? AND request_id = ?", status, taskId, requestId);
	}

	settle(taskId: string, requestId: string, status: "done" | "unanswered", summaryText: string | null, error: string | null = null): void {
		this.#update(
			"UPDATE requests SET summary_status = ?, summary_text = ?, last_error = ? WHERE task_id = ? AND request_id = ?",
			status, summaryText, error, taskId, requestId,
		);
	}

	setPreModelFailure(taskId: string, requestId: string, error: string): void {
		this.#update("UPDATE requests SET pre_model = 1, last_error = ?, summary_status = NULL, summary_text = NULL WHERE task_id = ? AND request_id = ?", error, taskId, requestId);
	}

	setLastError(taskId: string, requestId: string, error: string | null): void {
		this.#update("UPDATE requests SET last_error = ? WHERE task_id = ? AND request_id = ?", error, taskId, requestId);
	}
}

/** A client-visible conflict: idempotency key reused with a different payload, or an invalid lifecycle move. */
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
