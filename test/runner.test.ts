import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { McpClient } from "@earendil-works/pi-mcp";
import { acquireOwnership } from "../src/ownership.ts";
import { PreModelError, Runner, type RunnerModel } from "../src/runner.ts";
import { probeSession } from "../src/session-state.ts";

const MODEL: RunnerModel = { provider: "faux", modelId: "faux-1" };

/** Count durable user turns, the shape "no duplicate submission, no lost turn" takes. */
function userEntries(path: string): number {
	if (!existsSync(path)) return 0;
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return (db.prepare("SELECT COUNT(*) AS count FROM entries WHERE json_extract(record, '$.kind') = 'pi.user'").get() as { count: number }).count;
	} finally {
		db.close();
	}
}

async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "ask-runner-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const client = {
		callTool: async () => ({ content: [{ type: "text", text: "fetched" }] }),
		close: async () => {},
	} as unknown as McpClient;
	return {
		directory,
		faux,
		stateDir: join(directory, "task"),
		workspace: directory,
		deps: { connectMcp: async () => client, loadModels: async () => models },
	};
}

test("pre-model failures surface before any task database exists", async (t) => {
	const { stateDir, workspace } = await fixture(t);
	await assert.rejects(
		Runner.open({
			stateDir, workspace, model: MODEL,
			deps: { connectMcp: async () => { throw new Error("Set RADIUS_API_KEY."); }, loadModels: async () => { throw new Error("unreachable"); } },
		}),
		(error: unknown) => error instanceof PreModelError && /RADIUS_API_KEY/.test((error as Error).message),
	);
	assert.equal(existsSync(join(stateDir, "session.sqlite")), false, "no Harness may be opened for a pre-model failure");

	await assert.rejects(
		Runner.open({
			stateDir, workspace, model: { provider: "faux", modelId: "missing" },
			deps: { connectMcp: async () => ({ close: async () => {} } as unknown as McpClient), loadModels: async () => createModels() },
		}),
		PreModelError,
	);
	assert.equal(existsSync(join(stateDir, "session.sqlite")), false);
});

test("a run commits the workspace and returns the answer text", async (t) => {
	const { faux, stateDir, workspace, deps } = await fixture(t);
	faux.setResponses([fauxAssistantMessage("The answer.")]);
	const runner = await Runner.open({ stateDir, workspace, model: MODEL, deps });
	try {
		assert.deepEqual(await runner.run({ requestId: "r1", prompt: "Question" }, undefined), { status: "done", answerText: "The answer." });
	} finally {
		await runner.close();
	}
	assert.equal(probeSession(join(stateDir, "session.sqlite"), "r1").status, "done");
	assert.equal(userEntries(join(stateDir, "session.sqlite")), 1);
});

test("a paused run closes its Harness; reopening reattaches the same request without a duplicate turn", async (t) => {
	const { faux, stateDir, workspace, deps } = await fixture(t);
	faux.setResponses([fauxAssistantMessage("Resumed answer.")]);
	const sessionPath = join(stateDir, "session.sqlite");
	const controller = new AbortController();
	const first = await Runner.open({ stateDir, workspace, model: MODEL, deps });
	try {
		await assert.rejects(first.run({ requestId: "r1", prompt: "Question" }, controller.signal, () => controller.abort()));
	} finally {
		await first.close();
	}
	// The user entry is committed but the submission has not settled.
	assert.equal(probeSession(sessionPath, "r1").status, "placed");
	assert.equal(userEntries(sessionPath), 1);

	const second = await Runner.open({ stateDir, workspace, model: MODEL, deps });
	try {
		assert.deepEqual(await second.run({ requestId: "r1", prompt: "Question" }, undefined), { status: "done", answerText: "Resumed answer." });
	} finally {
		await second.close();
	}
	assert.equal(userEntries(sessionPath), 1, "reattach never submits the turn twice");
	assert.equal(probeSession(sessionPath, "r1").status, "done");
});

test("a run that asks for a different prompt under a used request ID fails loudly", async (t) => {
	const { faux, stateDir, workspace, deps } = await fixture(t);
	faux.setResponses([fauxAssistantMessage("First.")]);
	const runner = await Runner.open({ stateDir, workspace, model: MODEL, deps });
	try {
		await runner.run({ requestId: "r1", prompt: "First prompt" }, undefined);
		await assert.rejects(runner.run({ requestId: "r1", prompt: "Different prompt" }, undefined), /different prompt/);
	} finally {
		await runner.close();
	}
});

test("the manager-root lock excludes a second process and is released by SIGKILL", { timeout: 20000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "ask-owner-"));
	t.after(() => rm(directory, { recursive: true, force: true }));

	const held = acquireOwnership(directory);
	assert.throws(() => acquireOwnership(directory), /Another manager owns/);
	held.release();
	const again = acquireOwnership(directory);
	again.release();

	const child = fork(join(import.meta.dirname, "ownership-worker.ts"), [directory], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
	t.after(() => child.kill("SIGKILL"));
	await once(child, "message");
	assert.throws(() => acquireOwnership(directory), /Another manager owns/);
	child.kill("SIGKILL");
	await once(child, "close");
	const recovered = acquireOwnership(directory);
	recovered.release();
});

test("two state/workspace pairs cannot mix transcripts or relative-path output", { timeout: 20000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "ask-isolation-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const client = { callTool: async () => ({ content: [] }), close: async () => {} } as unknown as McpClient;
	const deps = { connectMcp: async () => client, loadModels: async () => models };
	const pairs = ["a", "b"].map((name) => {
		const base = join(directory, name);
		const workspace = join(base, "workspace");
		mkdirSync(workspace, { recursive: true });
		return { name, stateDir: join(base, "task"), workspace };
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "articles/note.md", content: "A only" }, { id: "wa" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("A done"),
		fauxAssistantMessage(fauxToolCall("write", { path: "articles/note.md", content: "B only" }, { id: "wb" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("B done"),
	]);
	for (const pair of pairs) {
		const runner = await Runner.open({ stateDir: pair.stateDir, workspace: pair.workspace, model: MODEL, deps });
		try {
			assert.equal((await runner.run({ requestId: "r1", prompt: "Write a note" }, undefined)).status, "done");
		} finally {
			await runner.close();
		}
	}
	assert.equal(await readFile(join(pairs[0]!.workspace, "articles", "note.md"), "utf8"), "A only");
	assert.equal(await readFile(join(pairs[1]!.workspace, "articles", "note.md"), "utf8"), "B only");
	assert.notEqual(pairs[0]!.stateDir, pairs[1]!.stateDir);
	assert.equal(userEntries(join(pairs[0]!.stateDir, "session.sqlite")), 1);
	assert.equal(userEntries(join(pairs[1]!.stateDir, "session.sqlite")), 1);
});
