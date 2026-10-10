import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { McpClient } from "@earendil-works/pi-mcp";
import { ConflictError, deriveStatus, TaskStore, type RequestRecord } from "../src/task-store.ts";
import { TaskManager } from "../src/task-manager.ts";
import type { RunnerModel } from "../src/runner.ts";

const MODEL: RunnerModel = { provider: "faux", modelId: "faux-1" };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => { resolve = settle; });
	return { promise, resolve };
}

/** A provider request that holds until `gate` or the harness cancels it, so tests never leave a close hanging. */
function blocked(entered: () => void, gate: Promise<void>, message = "never"): FauxResponseFactory {
	return async (_context, options) => {
		entered();
		const signal = options?.signal;
		await new Promise<void>((resolve) => {
			if (signal?.aborted) return resolve();
			signal?.addEventListener("abort", () => resolve(), { once: true });
			void gate.then(() => resolve());
		});
		return fauxAssistantMessage(message);
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "ask-manager-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const client = {
		callTool: async () => ({ content: [{ type: "text", text: "fetched" }] }),
		close: async () => {},
	} as unknown as McpClient;
	const deps = { connectMcp: async () => client, loadModels: async () => models };
	const start = () => TaskManager.start({ root, defaultModel: MODEL, models: [MODEL], deps });
	return { root, faux, deps, client, models, start };
}

const request = (overrides: Partial<RequestRecord>): RequestRecord => ({
	taskId: "t", requestId: "r", prompt: "p", queueSeq: 1, desiredState: "run", attempts: 0, attemptSeq: 0,
	preModel: false, lastError: null, summaryStatus: null, summaryText: null, admittedAt: 0, ...overrides,
});

test("status derivation follows desired state, durable status, and runner liveness", () => {
	assert.equal(deriveStatus(request({}), false), "Queued");
	assert.equal(deriveStatus(request({}), true), "Queued");
	assert.equal(deriveStatus(request({ summaryStatus: "placed" }), true), "Running");
	assert.equal(deriveStatus(request({ summaryStatus: "placed" }), false), "Recovering");
	assert.equal(deriveStatus(request({ summaryStatus: "queued" }), false), "Queued");
	assert.equal(deriveStatus(request({ desiredState: "pause", summaryStatus: "placed" }), false), "Paused");
	assert.equal(deriveStatus(request({ summaryStatus: "done", summaryText: "x" }), false), "Completed");
	assert.equal(deriveStatus(request({ summaryStatus: "unanswered" }), false), "Failed");
	assert.equal(deriveStatus(request({ preModel: true }), false), "Failed");
	assert.equal(deriveStatus(request({ summaryStatus: "placed", attempts: 3 }), false), "Interrupted");
});

test("the catalog keeps task and request identity separate and idempotent", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ask-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = TaskStore.open(root);
	t.after(() => store.close());
	const base = { creationKey: "k1", taskId: "11111111-1111-1111-1111-111111111111", requestId: "req-1", objective: "Research", modelProvider: "faux", modelId: "faux-1", now: 1, workspacePath: "/w" };
	const first = store.createTask(base);
	assert.equal(first.created, true);
	const again = store.createTask({ ...base, taskId: "22222222-2222-2222-2222-222222222222", requestId: "req-2" });
	assert.equal(again.created, false);
	assert.equal(again.task.id, first.task.id);
	assert.throws(() => store.createTask({ ...base, objective: "Different" }), ConflictError);
	assert.throws(() => store.addRequest({ taskId: first.task.id, requestId: "follow-1", prompt: "Too soon", now: 2 }), ConflictError);
	store.settle(first.task.id, "req-1", "done", "Answer");

	const follow = store.addRequest({ taskId: first.task.id, requestId: "follow-1", prompt: "More", now: 2 });
	assert.equal(follow.created, true);
	assert.equal(follow.request.queueSeq, 2);
	assert.throws(() => store.addRequest({ taskId: first.task.id, requestId: "follow-2", prompt: "Too soon", now: 3 }), ConflictError);
	const late = store.addRequest({ taskId: first.task.id, requestId: "follow-1", prompt: "More", now: 4 });
	assert.equal(late.created, false);
	assert.throws(() => store.addRequest({ taskId: first.task.id, requestId: "follow-1", prompt: "Changed", now: 5 }), ConflictError);
	assert.equal(store.nextEligible(3)!.requestId, "follow-1");
	assert.equal(store.unsettledRunRequests().map((item) => item.requestId).join(","), "follow-1");
});

test("one active runner: later tasks queue in admission order", { timeout: 20000 }, async (t) => {
	const { faux, start } = await fixture(t);
	const gateA = deferred<void>();
	const enteredA = deferred<void>();
	const gateB = deferred<void>();
	const enteredB = deferred<void>();
	faux.setResponses([
		blocked(() => enteredA.resolve(), gateA.promise, "A answer"),
		blocked(() => enteredB.resolve(), gateB.promise, "B answer"),
	]);
	const manager = start();
	t.after(() => manager.close());
	const a = manager.createTask({ creationKey: "ka", objective: "Task A" });
	await enteredA.promise;
	const b = manager.createTask({ creationKey: "kb", objective: "Task B" });
	assert.equal(manager.detail(a.id).summary.status, "Running");
	assert.equal(manager.detail(b.id).summary.status, "Queued");
	gateA.resolve();
	await waitFor(() => manager.detail(a.id).summary.status === "Completed");
	await enteredB.promise;
	assert.equal(manager.detail(b.id).summary.status, "Running");
	gateB.resolve();
	await waitFor(() => manager.detail(b.id).summary.status === "Completed");
	assert.equal(manager.detail(a.id).summary.result, "A answer");
	assert.equal(manager.detail(b.id).summary.result, "B answer");
});

test("repeated creation and follow-up commands never duplicate tasks or submissions", { timeout: 20000 }, async (t) => {
	const { faux, start } = await fixture(t);
	faux.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two.")]);
	const manager = start();
	t.after(() => manager.close());
	const first = manager.createTask({ creationKey: "same", objective: "Find X" });
	const again = manager.createTask({ creationKey: "same", objective: "Find X" });
	assert.equal(again.id, first.id);
	assert.equal(manager.list().length, 1);
	await waitFor(() => manager.detail(first.id).summary.status === "Completed");
	manager.addRequest(first.id, { requestId: "follow-1", prompt: "More detail" });
	manager.addRequest(first.id, { requestId: "follow-1", prompt: "More detail" });
	await waitFor(() => manager.detail(first.id).summary.status === "Completed");
	assert.equal(manager.detail(first.id).requests.length, 2);
	assert.equal(faux.state.callCount, 2, "an idempotent follow-up never submits a second turn");
});

test("pause persists across management restarts and never auto-resumes", { timeout: 20000 }, async (t) => {
	const { root, faux, deps, start } = await fixture(t);
	// Hold the pre-model connect so the pause lands before any request is placed.
	const gate = deferred<void>();
	const gated = { ...deps, connectMcp: async () => { await gate.promise; return deps.connectMcp(); } };
	faux.setResponses([fauxAssistantMessage("After resume.")]);
	const restart = () => TaskManager.start({ root, defaultModel: MODEL, models: [MODEL], deps: gated });
	const manager = restart();
	const a = manager.createTask({ creationKey: "ka", objective: "Long job" });
	manager.pause(a.id);
	gate.resolve();
	await waitFor(() => manager.detail(a.id).summary.status === "Paused" && !manager.detail(a.id).summary.runnerLive);
	await manager.close();

	const restarted = restart();
	t.after(() => restarted.close());
	assert.equal(restarted.detail(a.id).summary.status, "Paused", "pause survives a restart");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(restarted.detail(a.id).summary.status, "Paused", "a restart never auto-resumes paused work");
	restarted.resume(a.id);
	await waitFor(() => restarted.detail(a.id).summary.status === "Completed");
	assert.equal(restarted.detail(a.id).summary.result, "After resume.");
});

test("completed requests do not run again after a restart", { timeout: 20000 }, async (t) => {
	const { faux, start } = await fixture(t);
	faux.setResponses([fauxAssistantMessage("Done once.")]);
	const first = start();
	const a = first.createTask({ creationKey: "ka", objective: "Once" });
	await waitFor(() => first.detail(a.id).summary.status === "Completed");
	const calls = faux.state.callCount;
	await first.close();
	const second = start();
	t.after(() => second.close());
	assert.equal(second.detail(a.id).summary.status, "Completed");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(faux.state.callCount, calls, "a settled submission is never resubmitted");
});

test("pre-model failures stay visible, count no attempt, and never loop", { timeout: 20000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ask-manager-pre-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const deps = { connectMcp: async () => { throw new Error("Set RADIUS_API_KEY."); }, loadModels: async () => createModels() };
	const first = TaskManager.start({ root, defaultModel: MODEL, models: [MODEL], deps });
	const a = first.createTask({ creationKey: "ka", objective: "Needs credentials" });
	await waitFor(() => first.detail(a.id).summary.status === "Failed");
	const summary = first.detail(a.id).summary;
	assert.equal(summary.preModel, true);
	assert.equal(summary.attempts, 0);
	assert.match(summary.lastError ?? "", /RADIUS_API_KEY/);
	await first.close();
	const second = TaskManager.start({ root, defaultModel: MODEL, models: [MODEL], deps });
	t.after(() => second.close());
	assert.equal(second.detail(a.id).summary.status, "Failed");
	assert.equal(second.detail(a.id).summary.attempts, 0, "a pre-model failure never burns the recovery budget");
});

test("an unsettled request admits no follow-up until it settles", { timeout: 20000 }, async (t) => {
	const { faux, start } = await fixture(t);
	faux.setResponses([fauxAssistantMessage("First.")]);
	const manager = start();
	t.after(() => manager.close());
	const a = manager.createTask({ creationKey: "ka", objective: "First" });
	assert.throws(() => manager.addRequest(a.id, { requestId: "f1", prompt: "Too soon" }), ConflictError);
	await waitFor(() => manager.detail(a.id).summary.status === "Completed");
	manager.addRequest(a.id, { requestId: "f1", prompt: "Now" });
	assert.equal(manager.detail(a.id).requests.length, 2);
});

test("bounded recovery stops after the attempt limit instead of looping", { timeout: 20000 }, async (t) => {
	const { root, deps } = await fixture(t);
	// Seed a task whose session database is unusable, so every dispatch fails after model resolution.
	const taskId = "33333333-3333-3333-3333-333333333333";
	const store = TaskStore.open(root);
	store.createTask({
		creationKey: "ka", taskId, requestId: "r1", objective: "Broken", modelProvider: "faux", modelId: "faux-1",
		now: 1, workspacePath: join(root, taskId, "workspace"),
	});
	store.close();
	mkdirSync(join(root, taskId), { recursive: true });
	const db = new DatabaseSync(join(root, taskId, "session.sqlite"));
	db.exec("CREATE TABLE durable_schema(singleton INTEGER, version INTEGER); INSERT INTO durable_schema VALUES(1, 999)");
	db.close();

	const manager = TaskManager.start({ root, defaultModel: MODEL, models: [MODEL], deps });
	t.after(() => manager.close());
	await waitFor(() => manager.detail(taskId).summary.status === "Interrupted");
	assert.equal(manager.detail(taskId).summary.attempts, 3);
	assert.ok(manager.detail(taskId).summary.lastError, "exhaustion keeps the last error visible");
});

/** Durable user-turn count for one task database. */
function userEntries(path: string): number {
	if (!existsSync(path)) return 0;
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return (db.prepare("SELECT COUNT(*) AS count FROM entries WHERE json_extract(record, '$.kind') = 'pi.user'").get() as { count: number }).count;
	} finally {
		db.close();
	}
}

test("two tasks keep separate databases, workspaces, and transcripts", { timeout: 20000 }, async (t) => {
	const { faux, start, root } = await fixture(t);
	faux.setResponses([fauxAssistantMessage("Answer A."), fauxAssistantMessage("Answer B.")]);
	const manager = start();
	t.after(() => manager.close());
	const a = manager.createTask({ creationKey: "ka", objective: "Task A" });
	const b = manager.createTask({ creationKey: "kb", objective: "Task B" });
	await waitFor(() => manager.detail(a.id).summary.status === "Completed" && manager.detail(b.id).summary.status === "Completed");
	const pathA = manager.sessionPath(a.id);
	const pathB = manager.sessionPath(b.id);
	assert.notEqual(pathA, pathB);
	assert.notEqual(manager.detail(a.id).task.workspacePath, manager.detail(b.id).task.workspacePath);
	assert.equal(userEntries(pathA), 1);
	assert.equal(userEntries(pathB), 1);
	assert.equal(manager.detail(a.id).summary.result, "Answer A.");
	assert.equal(manager.detail(b.id).summary.result, "Answer B.");
	assert.equal(join(root, a.id, "workspace"), manager.detail(a.id).task.workspacePath);
});

test("a terminally unanswered request stays failed and is never retried after a restart", { timeout: 20000 }, async (t) => {
	const { faux, start } = await fixture(t);
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid test request" })));
	const first = start();
	const a = first.createTask({ creationKey: "ka", objective: "Doomed" });
	await waitFor(() => first.detail(a.id).summary.status === "Failed");
	assert.ok(first.detail(a.id).summary.lastError, "the terminal reason is visible");
	const calls = faux.state.callCount;
	await first.close();
	const second = start();
	t.after(() => second.close());
	assert.equal(second.detail(a.id).summary.status, "Failed");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(faux.state.callCount, calls, "a terminal failure is never automatically retried");
});

test("a pre-model failure can be resumed once credentials work", { timeout: 20000 }, async (t) => {
	const { root, faux, deps, start } = await fixture(t);
	const failing = { connectMcp: async () => { throw new Error("Set RADIUS_API_KEY."); }, loadModels: deps.loadModels };
	const first = TaskManager.start({ root, defaultModel: MODEL, models: [MODEL], deps: failing });
	const a = first.createTask({ creationKey: "ka", objective: "Needs credentials" });
	await waitFor(() => first.detail(a.id).summary.status === "Failed");
	assert.equal(first.detail(a.id).summary.preModel, true);
	await first.close();

	faux.setResponses([fauxAssistantMessage("Recovered.")]);
	const second = start();
	t.after(() => second.close());
	second.resume(a.id);
	await waitFor(() => second.detail(a.id).summary.status === "Completed");
	assert.equal(second.detail(a.id).summary.result, "Recovered.");
	assert.ok(second.detail(a.id).summary.attempts < 3, "a manual resume restores the recovery budget");
});
