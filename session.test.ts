import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { parseRequest, selectSubmission } from "./session.ts";

test("request parsing preserves legacy prompts and validates idempotent/resume forms", () => {
	assert.equal(parseRequest(["research", "batteries"]).task, "research batteries");
	assert.deepEqual(parseRequest(["--request-id", "r1", "research"]), { requestId: "r1", mode: "prompt", task: "research", verbosity: "normal" });
	assert.deepEqual(parseRequest(["--resume", "r1"]), { requestId: "r1", mode: "resume", verbosity: "normal" });
	assert.deepEqual(parseRequest(["--request-id=r1", "--", "--literal prompt"]), { requestId: "r1", mode: "prompt", task: "--literal prompt", verbosity: "normal" });
	assert.equal(parseRequest(["-vv", "research"]).verbosity, "debug");
	assert.equal(parseRequest(["--verbose", "--quiet", "research"]).verbosity, "quiet");
	// No prompt and no --resume is the interactive chat; -q still selects its verbosity.
	assert.equal(parseRequest([]).mode, "chat");
	assert.equal(parseRequest(["-q"]).mode, "chat");
	assert.equal(parseRequest(["-q"]).verbosity, "quiet");
	for (const args of [["--resume", ""], ["--request-id", "../x", "task"], ["--resume", "r1", "task"], ["--resume", "r1", "--request-id", "r2"], ["--unknown"]]) {
		assert.throws(() => parseRequest(args));
	}
	assert.throws(() => parseRequest(["research"], true), /require --request-id/);
	assert.throws(() => parseRequest(["--request-id", "r1"], true), /usage:/);
});

test("resume never creates input; repeated IDs reuse a result and reject different prompts", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage("Answer one."), fauxAssistantMessage("Answer two.")]);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
	try {
		const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		await assert.rejects(selectSubmission(harness, root, { requestId: "unknown", mode: "resume" }), /Unknown request/);
		assert.equal((await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.length, 0);
		const request = { requestId: "r1", mode: "prompt", task: "First question", verbosity: "normal" } as const;
		const first = await selectSubmission(harness, root, request);
		const answer = await first.wait(BACKGROUND_CONTEXT);
		assert.equal(answer.status, "done");
		await (await selectSubmission(harness, root, { requestId: "r2", mode: "prompt", task: "Second question" })).wait(BACKGROUND_CONTEXT);
		const again = await selectSubmission(harness, root, request);
		assert.equal(again.id, first.id);
		assert.deepEqual(await again.wait(BACKGROUND_CONTEXT), answer);
		assert.equal((await selectSubmission(harness, root, { requestId: "r1", mode: "resume" })).id, first.id);
		await assert.rejects(selectSubmission(harness, root, { requestId: "r1", mode: "prompt", task: "Different question" }), /different prompt/);
		assert.equal(faux.state.callCount, 2);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("terminal failures stay terminal on resume; a new ID can continue with saved context", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid test request" }),
		fauxAssistantMessage("Recovered with a follow-up."),
	]);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } }, BACKGROUND_CONTEXT);
	try {
		const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const first = await selectSubmission(harness, root, { requestId: "failed", mode: "prompt", task: "Research" });
		assert.equal((await first.wait(BACKGROUND_CONTEXT)).status, "unanswered");
		assert.equal((await (await selectSubmission(harness, root, { requestId: "failed", mode: "resume" })).wait(BACKGROUND_CONTEXT)).status, "unanswered");
		assert.equal(faux.state.callCount, 1);
		assert.equal((await (await selectSubmission(harness, root, { requestId: "retry", mode: "prompt", task: "Continue the previous research" })).wait(BACKGROUND_CONTEXT)).status, "done");
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("SIGKILL + SQLite reopen reuses committed search, replays interrupted fetch, and writes article once", { timeout: 30000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "ask-recovery-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	async function worker(mode: string) {
		const child = fork(join(import.meta.dirname, "test", "recovery-worker.ts"), [mode, directory], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
		t.after(() => { child.kill("SIGKILL"); });
		let stderr = "";
		child.stderr!.on("data", (chunk) => { stderr += chunk; });
		child.stdout!.resume();
		const closed = once(child, "close");
		const message = await Promise.race([
			once(child, "message").then(([message]) => message),
			closed.then(([code, signal]) => { throw new Error(`Worker exited early: ${code}/${signal}\n${stderr}`); }),
		]);
		if (mode === "crash") {
			assert.equal(message.type, "ready-to-kill");
			child.kill("SIGKILL");
			assert.equal((await closed)[1], "SIGKILL");
		} else {
			assert.equal((await closed)[0], 0, stderr);
			assert.equal(message.status, "done");
			assert.equal(message.userEntries, 1);
		}
		return message;
	}
	await worker("crash");
	const resumed = await worker("resume");
	const repeated = await worker("repeat");
	assert.equal(repeated.id, resumed.id);
	assert.equal(repeated.modelCalls, 0);
	assert.deepEqual((await readFile(join(directory, "calls.txt"), "utf8")).trim().split("\n"), ["tools_webSearch_run", "tools_webFetch_run", "tools_webFetch_run"]);
	assert.match(await readFile(join(directory, "articles/recovered/article.md"), "utf8"), /https:\/\/example.test\/batteries/);
});
