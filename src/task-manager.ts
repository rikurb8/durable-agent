/**
 * One manager process owns execution for a state root.
 *
 * The manager holds the root lock, persists user intent in `manager.sqlite`,
 * and dispatches at most one runner at a time. Each task's `session.sqlite`
 * stays authoritative, so a crash, a close, or a pause is recovered by
 * reattaching the same request ID instead of submitting again.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { acquireOwnership, type Ownership } from "./ownership.ts";
import { errorMessage, PreModelError, Runner, type RunnerDeps, type RunnerModel } from "./runner.ts";
import { probeSession } from "./session-state.ts";
import {
	ConflictError, deriveStatus, MAX_RECOVERY_ATTEMPTS, NotFoundError, TASK_ID_PATTERN, TaskStore,
	type DesiredState, type RequestRecord, type TaskRecord, type TaskStatus,
} from "./task-store.ts";

export type TaskManagerOptions = {
	readonly root: string;
	readonly defaultModel: RunnerModel;
	/** Server-configured allowlist; a request model string is accepted only from this set. */
	readonly models: readonly RunnerModel[];
	readonly deps?: Partial<RunnerDeps>;
	readonly onEvent?: (taskId: string, event: AgentEvent) => void;
	readonly now?: () => number;
};

export type TaskSummary = {
	readonly id: string;
	readonly objective: string;
	readonly model: RunnerModel;
	readonly createdAt: number;
	readonly workspacePath: string;
	readonly latestRequestId: string | null;
	readonly status: TaskStatus;
	readonly desiredState: DesiredState | null;
	readonly runnerLive: boolean;
	readonly attempts: number;
	readonly preModel: boolean;
	readonly lastError: string | null;
	readonly result: string | null;
	readonly queueSeq: number | null;
};

type Active = { readonly taskId: string; readonly requestId: string; readonly controller: AbortController; done: Promise<void> };

export class TaskManager {
	#root: string;
	#store: TaskStore;
	#ownership: Ownership;
	#options: TaskManagerOptions;
	#active: Active | undefined;
	#closing = false;

	private constructor(root: string, store: TaskStore, ownership: Ownership, options: TaskManagerOptions) {
		this.#root = root;
		this.#store = store;
		this.#ownership = ownership;
		this.#options = options;
	}

	/** Acquire ownership, open the catalog, reconcile, then dispatch (decision 13). */
	static start(options: TaskManagerOptions): TaskManager {
		const ownership = acquireOwnership(options.root);
		let store: TaskStore;
		try {
			store = TaskStore.open(options.root);
		} catch (error) {
			ownership.release();
			throw error;
		}
		const manager = new TaskManager(options.root, store, ownership, options);
		manager.#reconcile();
		manager.#dispatch();
		return manager;
	}

	get root(): string {
		return this.#root;
	}

	get defaultModel(): RunnerModel {
		return this.#options.defaultModel;
	}

	get allowedModels(): readonly RunnerModel[] {
		return this.#options.models;
	}

	taskDir(taskId: string): string {
		return join(this.#root, taskId);
	}

	sessionPath(taskId: string): string {
		return join(this.taskDir(taskId), "session.sqlite");
	}

	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	#requireTask(taskId: string): { task: TaskRecord; requests: RequestRecord[] } {
		if (!TASK_ID_PATTERN.test(taskId)) throw new NotFoundError("Unknown task.");
		const found = this.#store.task(taskId);
		if (!found) throw new NotFoundError("Unknown task.");
		return found;
	}

	#requireLatest(taskId: string): RequestRecord {
		const { requests } = this.#requireTask(taskId);
		const latest = requests.at(-1);
		if (!latest) throw new NotFoundError("Task has no requests.");
		return latest;
	}

	#summary(taskId: string): TaskSummary {
		const { task, requests } = this.#requireTask(taskId);
		const latest = requests.at(-1);
		const live = this.#active !== undefined && this.#active.taskId === task.id && this.#active.requestId === latest?.requestId;
		return {
			id: task.id,
			objective: task.objective,
			model: { provider: task.modelProvider, modelId: task.modelId },
			createdAt: task.createdAt,
			workspacePath: task.workspacePath,
			latestRequestId: latest?.requestId ?? null,
			status: latest ? deriveStatus(latest, live) : "Queued",
			desiredState: latest?.desiredState ?? null,
			runnerLive: live,
			attempts: latest?.attempts ?? 0,
			preModel: latest?.preModel ?? false,
			lastError: latest?.lastError ?? null,
			result: latest?.summaryStatus === "done" ? latest.summaryText : null,
			queueSeq: latest?.queueSeq ?? null,
		};
	}

	list(): TaskSummary[] {
		return this.#store.listTasks().map(({ task, latest }) => {
			const live = this.#active !== undefined && this.#active.taskId === task.id && this.#active.requestId === latest?.requestId;
			return {
				id: task.id,
				objective: task.objective,
				model: { provider: task.modelProvider, modelId: task.modelId },
				createdAt: task.createdAt,
				workspacePath: task.workspacePath,
				latestRequestId: latest?.requestId ?? null,
				status: latest ? deriveStatus(latest, live) : "Queued",
				desiredState: latest?.desiredState ?? null,
				runnerLive: live,
				attempts: latest?.attempts ?? 0,
				preModel: latest?.preModel ?? false,
				lastError: latest?.lastError ?? null,
				result: latest?.summaryStatus === "done" ? latest.summaryText : null,
				queueSeq: latest?.queueSeq ?? null,
			};
		});
	}

	detail(taskId: string): { task: TaskRecord; requests: RequestRecord[]; summary: TaskSummary } {
		const { task, requests } = this.#requireTask(taskId);
		return { task, requests, summary: this.#summary(taskId) };
	}

	createTask(input: { creationKey: string; objective: string; model?: RunnerModel }): TaskSummary {
		const objective = input.objective.trim();
		if (objective === "") throw new ConflictError("An objective is required.");
		const model = this.#resolveModel(input.model);
		const taskId = randomUUID();
		const requestId = randomUUID();
		const workspacePath = join(this.#root, taskId, "workspace");
		// Create the workspace now; dispatch re-asserts it and reports a failure visibly.
		try {
			mkdirSync(workspacePath, { recursive: true });
		} catch {
			/* left for dispatch to report as a pre-model failure */
		}
		const { task, created } = this.#store.createTask({
			creationKey: input.creationKey, taskId, requestId, objective,
			modelProvider: model.provider, modelId: model.modelId, now: this.#now(), workspacePath,
		});
		if (created) this.#dispatch();
		return this.#summary(task.id);
	}

	addRequest(taskId: string, input: { requestId: string; prompt: string }): TaskSummary {
		this.#requireTask(taskId);
		const prompt = input.prompt.trim();
		if (prompt === "") throw new ConflictError("A prompt is required.");
		this.#store.addRequest({ taskId, requestId: input.requestId, prompt, now: this.#now() });
		this.#dispatch();
		return this.#summary(taskId);
	}

	/** Persist pause intent first, then cancel the wait; the runner closes its Harness. */
	pause(taskId: string): TaskSummary {
		const latest = this.#requireLatest(taskId);
		if (latest.desiredState !== "pause") this.#store.setDesiredState(taskId, latest.requestId, "pause");
		if (this.#active?.taskId === taskId && !this.#active.controller.signal.aborted) this.#active.controller.abort();
		return this.#summary(taskId);
	}

	/** Idempotent resume: reset the recovery budget and re-enqueue the same request ID. */
	resume(taskId: string): TaskSummary {
		const latest = this.#requireLatest(taskId);
		const terminal = latest.summaryStatus === "done" || latest.summaryStatus === "unanswered";
		const alreadyRunning = latest.desiredState === "run" && !latest.preModel && latest.attempts < MAX_RECOVERY_ATTEMPTS;
		if (!terminal && !alreadyRunning) {
			this.#store.resume(taskId, latest.requestId);
			this.#dispatch();
		}
		return this.#summary(taskId);
	}

	#resolveModel(model: RunnerModel | undefined): RunnerModel {
		if (model === undefined) return this.#options.defaultModel;
		const allowed = this.#options.models.some((item) => item.provider === model.provider && item.modelId === model.modelId);
		if (!allowed) throw new ConflictError(`Model ${model.provider}/${model.modelId} is not allowed.`);
		return model;
	}

	/** Resume only unsettled `run` requests; never retry a terminal outcome. */
	#reconcile(): void {
		for (const request of this.#store.unsettledRunRequests()) {
			const probe = probeSession(this.sessionPath(request.taskId), request.requestId);
			if (probe.status === "done") {
				this.#store.settle(request.taskId, request.requestId, "done", probe.answerText);
				continue;
			}
			if (probe.status === "unanswered") {
				this.#store.settle(request.taskId, request.requestId, "unanswered", null, probe.reason || "unanswered");
				continue;
			}
			if (probe.nextSeq > request.attemptSeq) this.#store.resetAttempts(request.taskId, request.requestId);
			if (probe.status !== "absent" && request.summaryStatus !== probe.status) {
				this.#store.setSummaryStatus(request.taskId, request.requestId, probe.status);
			}
		}
	}

	#dispatch(): void {
		if (this.#closing || this.#active) return;
		const request = this.#store.nextEligible(MAX_RECOVERY_ATTEMPTS);
		if (!request) return;
		const active: Active = { taskId: request.taskId, requestId: request.requestId, controller: new AbortController(), done: Promise.resolve() };
		this.#active = active;
		active.done = this.#execute(request, active.controller).catch(() => {}).finally(() => {
			this.#active = undefined;
			this.#dispatch();
		});
	}

	/** One execution: workspace, Harness, submit/reattach, terminal summary. */
	async #execute(request: RequestRecord, controller: AbortController): Promise<void> {
		const { task } = this.#store.task(request.taskId)!;
		const signal = controller.signal;
		let runner: Runner | undefined;
		let counted = false;
		try {
			try {
				mkdirSync(task.workspacePath, { recursive: true });
			} catch (error) {
				this.#store.setPreModelFailure(request.taskId, request.requestId, `Workspace setup failed: ${errorMessage(error)}`);
				return;
			}
			try {
				runner = await Runner.open({
					stateDir: this.taskDir(task.id),
					workspace: task.workspacePath,
					model: { provider: task.modelProvider, modelId: task.modelId },
					...(this.#options.deps ? { deps: this.#options.deps } : {}),
					...(this.#options.onEvent ? { onEvent: (event: AgentEvent) => this.#options.onEvent!(task.id, event) } : {}),
				});
			} catch (error) {
				if (error instanceof PreModelError) {
					this.#store.setPreModelFailure(request.taskId, request.requestId, error.message);
					return;
				}
				throw error;
			}
			if (signal.aborted) return;
			// Capture the entry sequence after the Harness exists: a later run that made
			// durable progress resets the attempt bound (decision 10).
			this.#store.beginAttempt(request.taskId, request.requestId, probeSession(this.sessionPath(task.id), request.requestId).nextSeq);
			counted = true;
			const outcome = await runner.run({ requestId: request.requestId, prompt: request.prompt }, signal, (status) => {
				if (status === "placed") this.#store.setSummaryStatus(request.taskId, request.requestId, "placed");
			});
			if (outcome.status === "done") this.#store.settle(request.taskId, request.requestId, "done", outcome.answerText);
			else this.#store.settle(request.taskId, request.requestId, "unanswered", null, outcome.reason);
		} catch (error) {
			// A pause or shutdown cancelled the wait; intent stays and recovery retries later.
			if (signal.aborted) return;
			// A failure before the Harness opened still burns an attempt, so a broken task
			// stops after the bound instead of looping on every dispatch.
			if (counted) this.#store.setLastError(request.taskId, request.requestId, errorMessage(error));
			else this.#store.recordFailure(request.taskId, request.requestId, errorMessage(error));
		} finally {
			if (runner) await runner.close().catch(() => {});
		}
	}

	/** Stop admission, cancel the active wait, close its Harness, then release ownership. */
	async close(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		if (this.#active) {
			this.#active.controller.abort();
			await this.#active.done;
		}
		this.#store.close();
		this.#ownership.release();
	}
}

export { ConflictError, NotFoundError };
