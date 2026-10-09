import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MemoryDoc, memoryExtension, memoryKeeper, parseNotes, renderMemory, type Note } from "./memory.ts";

/** Poll until `check` holds, so a sleeping keeper has time to wake. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error("timed out waiting for the memory keeper");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const note = (over: Partial<Note> = {}): Note => ({ id: "aaaa1111", text: "a fact", tags: [], source: "", at: Date.UTC(2026, 0, 2), ...over });

test("renderMemory: oldest first, tagged, capped from the oldest end", () => {
	assert.equal(renderMemory([]), undefined);

	const rendered = renderMemory([
		note({ id: "old", text: "first", tags: ["batteries"] }),
		note({ id: "new", text: "second", source: "https://example.test/a" }),
	])!;
	assert.match(rendered, /- old 2026-01-02 \[batteries\]: first\n- new 2026-01-02 https:\/\/example\.test\/a: second/);
	assert.match(rendered, /`recall` searches these notes/);

	const many = Array.from({ length: 400 }, (_, i) => note({ id: `n${i}`, text: "x".repeat(100) }));
	const capped = renderMemory(many)!;
	assert.match(capped, /older notes? omitted; use recall/);
	assert.match(capped, /- n399 /, "the newest note survives the cap");
	assert.doesNotMatch(capped, /- n0 /, "the oldest note is dropped first");
});

/** One harness on a fresh registry with the memory extension installed. */
async function openMemory() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(memoryExtension());
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return { faux, harness, root };
}

test("remember writes a session note and the memory section renders it", async () => {
	const { faux, harness, root } = await openMemory();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("remember", { text: "Battery recycling is hard because of mixed chemistry.", tags: ["batteries"], source: "https://example.test/a" }, { id: "c1" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Noted."),
	]);
	try {
		assert.equal((await (await root.submit({ type: "input", content: "Remember this", requestId: "r1" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");

		const memory = await harness.snapshot(MemoryDoc, BACKGROUND_CONTEXT);
		assert.equal(memory?.notes.length, 1);
		assert.match(memory!.notes[0]!.text, /mixed chemistry/);

		const agent = await root.agent(BACKGROUND_CONTEXT);
		const section = agent.sections.find((candidate) => candidate.key === "memory");
		assert.ok(section, "the memory section is installed");
		const rendered = await (section!.render as any)({ read: harness, conversationId: root.id, agent, shown: {} }, BACKGROUND_CONTEXT);
		assert.match(rendered, /mixed chemistry/);
		assert.match(rendered, /example\.test\/a/);

		const messages = (await root.context(BACKGROUND_CONTEXT)).messages;
		assert.match(JSON.stringify(messages), /mixed chemistry/, "the notes are in the request's system prompt");
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("remember deduplicates, and recall finds a note and the transcript", async () => {
	const { faux, harness, root } = await openMemory();
	const rememberCall = (id: string, text: string) => fauxAssistantMessage(
		fauxToolCall("remember", { text }, { id }),
		{ stopReason: "toolUse" },
	);
	try {
		await (await root.submit({ type: "input", content: "The magic number is 41.", requestId: "r1" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		faux.setResponses([rememberCall("c1", "The magic number is 42."), rememberCall("c2", "the   MAGIC number is 42."), fauxAssistantMessage("Saved.")]);
		await (await root.submit({ type: "input", content: "Remember the number.", requestId: "r2" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		assert.equal((await harness.snapshot(MemoryDoc, BACKGROUND_CONTEXT))?.notes.length, 1, "the second, identical note is dropped");

		faux.setResponses([fauxAssistantMessage(fauxToolCall("recall", { query: "magic number" }, { id: "c3" }), { stopReason: "toolUse" }), fauxAssistantMessage("Found it.")]);
		await (await root.submit({ type: "input", content: "What was the number?", requestId: "r3" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		const entries = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
		const result = entries.items.find((entry) => entry.kind === "pi.tool-result" && (entry as any).model?.[0]?.toolName === "recall");
		const text = JSON.stringify((result as any)?.model?.[0]?.content ?? "");
		assert.match(text, /note /, "recall returns the durable note");
		assert.match(text, /magic number is 42/);
		assert.match(text, /transcript /, "recall also searches the verbatim transcript");
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("parseNotes: JSON, a code fence, a bare line, and junk", () => {
	assert.deepEqual(parseNotes('[{"text":"a fact","tags":["x"]}]'), [{ text: "a fact", tags: ["x"] }]);
	assert.deepEqual(parseNotes('```json\n[{"text":"fenced"}]\n```'), [{ text: "fenced", tags: [] }]);
	assert.deepEqual(parseNotes("a bare line\n\nsecond line"), [{ text: "a bare line", tags: [] }, { text: "second line", tags: [] }]);
	assert.deepEqual(parseNotes('not json [{"text":42},{"tags":[]}]'), []);
	assert.equal(parseNotes("[{\"text\":\"" + "x".repeat(900) + "\"}]")[0]!.text.length, 600, "a note is capped");
});

test("the keeper distills transcript the agent has moved past, without the model asking", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(memoryExtension());
	const harness = await Harness.open(new MemoryStorage(), {
		models, registry,
		conversationCreated: memoryKeeper({ model: "faux/faux-1", intervalMs: 150 }),
	}, BACKGROUND_CONTEXT);
	// Responses in call order: turn one, turn two, then the keeper's distill. The keeper only
	// reaches the model once at least DISTILL_MIN_ENTRIES are committed, so it cannot jump the queue.
	faux.setResponses([
		fauxAssistantMessage("First answer."),
		fauxAssistantMessage("Second answer."),
		fauxAssistantMessage(JSON.stringify([{ text: "The project is UniiChat.", tags: ["project"] }])),
	]);
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	try {
		await (await root.submit({ type: "input", content: "The project is UniiChat.", requestId: "r1" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		await (await root.submit({ type: "input", content: "Remember the name.", requestId: "r2" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		await until(async () => ((await harness.snapshot(MemoryDoc, BACKGROUND_CONTEXT))?.notes.length ?? 0) > 0);
		const memory = await harness.snapshot(MemoryDoc, BACKGROUND_CONTEXT);
		assert.equal(memory?.notes[0]?.text, "The project is UniiChat.");
		assert.deepEqual(memory?.notes[0]?.tags, ["project"]);
		assert.notEqual(memory?.distilledThrough, "", "the keeper advanced its watermark");
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("the keeper consolidates a pile of notes and retires the originals instead of dropping them", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(memoryExtension());
	const harness = await Harness.open(new MemoryStorage(), {
		models, registry,
		conversationCreated: memoryKeeper({ model: "faux/faux-1", intervalMs: 100 }),
	}, BACKGROUND_CONTEXT);
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	try {
		harness.resume();
		await harness.commit(async (tx) => {
			const doc = await tx.doc(MemoryDoc);
			for (let i = 0; i < 60; i++) doc.notes.push({ id: `n${i}`, text: `fact number ${i}`, tags: [], source: "", at: Date.now() });
		}, BACKGROUND_CONTEXT);
		faux.appendResponses([fauxAssistantMessage(JSON.stringify([{ text: "sixty facts, numbered 0 to 59", tags: ["facts"] }]))]);
		await until(async () => (await harness.snapshot(MemoryDoc, BACKGROUND_CONTEXT))?.retired.length === 60);
		const memory = await harness.snapshot(MemoryDoc, BACKGROUND_CONTEXT);
		assert.equal(memory?.notes.length, 1);
		assert.match(memory!.notes[0]!.text, /numbered 0 to 59/);
		assert.equal(memory?.retired.length, 60, "the originals are kept, not dropped");

		// recall still reaches a retired note.
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("recall", { query: "fact number 7" }, { id: "c1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Found it."),
		]);
		await (await root.submit({ type: "input", content: "What is fact number 7?", requestId: "r1" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		const entries = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
		const result = entries.items.find((entry) => entry.kind === "pi.tool-result" && (entry as any).model?.[0]?.toolName === "recall");
		assert.match(JSON.stringify((result as any)?.model?.[0]?.content ?? ""), /fact number 7/);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("a note outlives the process", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "ask-memory-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "session.sqlite");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);

	const registry = createRegistry();
	registry.install(memoryExtension());
	const first = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, BACKGROUND_CONTEXT);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("remember", { text: "The project is called UniiChat." }, { id: "c1" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Saved."),
	]);
	const root = await first.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	await (await root.submit({ type: "input", content: "Remember the project name", requestId: "r1" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
	await first.close(BACKGROUND_CONTEXT);

	const reopened = await Harness.open(await openNodeSqliteStorage(path), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
	try {
		assert.equal((await reopened.snapshot(MemoryDoc, BACKGROUND_CONTEXT))?.notes[0]?.text, "The project is called UniiChat.");
	} finally {
		await reopened.close(BACKGROUND_CONTEXT);
	}
});
