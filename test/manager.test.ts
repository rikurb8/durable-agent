import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { McpClient } from "@earendil-works/pi-mcp";
import { createManagerServer } from "../src/manager.ts";
import type { RunnerDeps, RunnerModel } from "../src/runner.ts";
import { TaskManager } from "../src/task-manager.ts";

const MODEL: RunnerModel = { provider: "faux", modelId: "faux-1" };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => { resolve = settle; });
	return { promise, resolve };
}

function blocked(entered: () => void, gate: Promise<void>, message: string): FauxResponseFactory {
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

async function fixture(t: TestContext, depsOverride?: RunnerDeps) {
	const root = await mkdtemp(join(tmpdir(), "ask-manager-http-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const client = { callTool: async () => ({ content: [] }), close: async () => {} } as unknown as McpClient;
	const deps = depsOverride ?? { connectMcp: async () => client, loadModels: async () => models };
	const manager = TaskManager.start({ root, defaultModel: MODEL, models: [MODEL], deps });
	const server = await createManagerServer(manager);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		await new Promise<void>((done) => server.close(() => done()));
		await manager.close();
	});
	const port = (server.address() as { port: number }).port;
	return { root, faux, manager, base: `http://127.0.0.1:${port}` };
}

const json = (base: string, path: string, body: unknown, init: RequestInit = {}) =>
	fetch(`${base}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
		body: JSON.stringify(body),
		...init,
	});

test("manager api admits persisted commands and rejects everything else", { timeout: 20000 }, async (t) => {
	const { base } = await fixture(t);
	const page = await fetch(`${base}/`);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /tasks-panel/);
	assert.equal((await fetch(`${base}/app.js`)).status, 200);
	assert.equal((await fetch(`${base}/style.css`)).status, 200);
	assert.equal((await fetch(`${base}/package.json`)).status, 404);
	const empty = await fetch(`${base}/api/tasks`);
	assert.equal(empty.status, 200);
	const catalog = await empty.json() as { status: string; tasks: unknown[]; models: unknown[] };
	assert.equal(catalog.status, "ok");
	assert.deepEqual(catalog.tasks, []);

	const created = await json(base, "/api/tasks", { creationKey: "k1", objective: "Research batteries" });
	assert.equal(created.status, 201);
	const { task } = await created.json() as { task: { id: string; status: string } };
	assert.match(task.id, /^[0-9a-f-]{36}$/);

	const again = await json(base, "/api/tasks", { creationKey: "k1", objective: "Research batteries" });
	assert.equal(again.status, 201);
	assert.equal(((await again.json()) as { task: { id: string } }).task.id, task.id);
	assert.equal(((await (await fetch(`${base}/api/tasks`)).json()) as { tasks: unknown[] }).tasks.length, 1);

	// Validation: conflicts, unknown fields, bad IDs, types, sizes, origin, host, method.
	assert.equal((await json(base, "/api/tasks", { creationKey: "k1", objective: "Different" })).status, 409);
	assert.equal((await json(base, "/api/tasks", { creationKey: "k2", objective: "X", extra: 1 })).status, 400);
	assert.equal((await json(base, "/api/tasks", { creationKey: "", objective: "X" })).status, 400);
	assert.equal((await json(base, "/api/tasks", { creationKey: "k3", objective: "" })).status, 400);
	assert.equal((await json(base, "/api/tasks", { creationKey: "k4", objective: "X", model: "not-a-model" })).status, 400);
	assert.equal((await json(base, "/api/tasks", { creationKey: "k5", objective: "X", model: "other/model" })).status, 400);
	assert.equal((await fetch(`${base}/api/tasks`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415);
	assert.equal((await fetch(`${base}/api/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" })).status, 400);
	assert.equal((await json(base, "/api/tasks", { creationKey: "big", objective: "a".repeat(70_000) })).status, 413);
	assert.equal((await json(base, "/api/tasks", {})).status, 400);
	assert.equal((await fetch(`${base}/api/tasks`, { headers: { Origin: "https://evil.test" } })).status, 403);
	assert.equal((await fetch(`${base}/api/tasks`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
	const wrongHost = await new Promise<number>((resolve, reject) => {
		const req = request(`${base}/api/tasks`, { headers: { Host: "evil.test" } }, (res) => { res.resume(); resolve(res.statusCode!); });
		req.on("error", reject); req.end();
	});
	assert.equal(wrongHost, 403);
	assert.equal((await fetch(`${base}/api/tasks`, { method: "DELETE" })).status, 405);
	assert.equal((await fetch(`${base}/api/tasks/not-a-uuid`)).status, 404);
	assert.equal((await fetch(`${base}/api/tasks/..%2f..%2fetc`)).status, 404);
	assert.equal((await fetch(`${base}/api/tasks/${"0".repeat(36)}`)).status, 404);
	assert.equal((await json(base, `/api/tasks/${task.id}/requests`, { requestId: "bad id!", prompt: "x" })).status, 400);
	assert.equal((await json(base, `/api/tasks/${task.id}/requests`, { requestId: "ok-1", prompt: "" })).status, 400);
	assert.equal((await fetch(`${base}/api/tasks/${task.id}/pause`, { method: "POST" })).status, 415);
	assert.equal((await json(base, "/api/tasks", { creationKey: "k6", objective: "Six" })).status, 201);

	// The state route answers the inspector shape for a task whose session database may not exist yet.
	const state = await (await fetch(`${base}/api/tasks/${task.id}/state`)).json() as { entries: unknown[] };
	assert.ok(Array.isArray(state.entries));
});

test("state is empty, never an error, until the task's session database exists", { timeout: 20000 }, async (t) => {
	const { base, manager } = await fixture(t, { connectMcp: async () => { throw new Error("Set RADIUS_API_KEY."); }, loadModels: async () => createModels() });
	const created = await json(base, "/api/tasks", { creationKey: "k1", objective: "Needs credentials" });
	const { task } = await created.json() as { task: { id: string } };
	await waitFor(() => manager.detail(task.id).summary.preModel);
	assert.deepEqual(await (await fetch(`${base}/api/tasks/${task.id}/state`)).json(), { seq: 0, conversations: [], entries: [], tasks: [], submissions: [], documents: [] });
});

test("pause and resume are idempotent and reflected in the catalog", { timeout: 20000 }, async (t) => {
	const { base, faux, manager } = await fixture(t);
	const gate = deferred<void>();
	const entered = deferred<void>();
	faux.setResponses([
		blocked(() => entered.resolve(), gate.promise, "first"),
		fauxAssistantMessage("Resumed answer."),
	]);
	const created = await json(base, "/api/tasks", { creationKey: "k1", objective: "Long job" });
	const { task } = await created.json() as { task: { id: string } };
	await entered.promise;

	const paused = await json(base, `/api/tasks/${task.id}/pause`, {});
	assert.equal(paused.status, 200);
	assert.equal(((await paused.json()) as { task: { status: string } }).task.status, "Paused");
	assert.equal((await json(base, `/api/tasks/${task.id}/pause`, {})).status, 200);
	await waitFor(() => !manager.detail(task.id).summary.runnerLive);

	const resumed = await json(base, `/api/tasks/${task.id}/resume`, {});
	assert.equal(resumed.status, 200);
	gate.resolve();
	await waitFor(() => manager.detail(task.id).summary.status === "Completed");
	const detail = await (await fetch(`${base}/api/tasks/${task.id}`)).json() as { summary: { status: string; result: string }; requests: unknown[] };
	assert.equal(detail.summary.result, "Resumed answer.");
	assert.equal(detail.requests.length, 1);
	// Idempotent resume on a settled request changes nothing.
	assert.equal((await json(base, `/api/tasks/${task.id}/resume`, {})).status, 200);
	assert.equal(manager.detail(task.id).requests.length, 1);
});
