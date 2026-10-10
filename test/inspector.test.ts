import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createInspectorServer, openInspector } from "../src/inspector.ts";

const TestDoc = defineDoc({ kind: "test.state", version: 1, scope: "session", initial: () => ({ text: "", count: 0 }) });

async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "ask-inspector-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "session.sqlite");
	const faux = fauxProvider();
	const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(defineExtension({
		name: "test",
		tools: [defineTool({
			name: "echo", parameters: Type.Object({ text: Type.String() }), description: "Echo text.",
			execute: async ({ text }, api, context) => {
				await api.commit(async (tx) => { (await tx.doc(TestDoc)).text = text; }, context);
				return { content: [{ type: "text", text }] };
			},
		})],
	}));
	const harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
	t.after(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return { directory, path, faux, harness, root };
}

function dump(path: string) {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return JSON.stringify(["durable_metadata", "durable_schema", "conversations", "entries", "tasks", "submissions", "documents", "document_revisions"].map((table) => db.prepare(`SELECT * FROM ${table}`).all()));
	} finally { db.close(); }
}

test("inspector reads live WAL, links tools, reconstructs documents and remains observational", async (t) => {
	const { path, faux, harness, root } = await fixture(t);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("echo", { text: "<script>alert('untrusted')</script>" }, { id: "echo-1" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Saved."),
	]);
	await (await root.submit({ type: "input", content: "Echo this", requestId: "inspect-1" }, context)).wait(context);
	const before = dump(path);
	const calls = faux.state.callCount;
	const inspector = openInspector(path);
	t.after(() => inspector.close());
	const first = inspector.snapshot(new URLSearchParams());
	assert.equal(first.conversation, root.id);
	assert.equal(first.submissions[0].requestId, "inspect-1");
	const tool = first.tasks.find((task) => task.kind === "pi.tool");
	assert.ok(first.entries.some((entry) => entry.id === tool.input.assistant));
	assert.ok(first.entries.some((entry) => entry.id === tool.state.outcome.result.entryId && entry.byTaskId === tool.id));
	assert.deepEqual(first.documents.find((doc) => doc.record.kind === "test.state").value, await harness.snapshot(TestDoc, context));
	assert.ok(first.entries.some((entry) => entry.kind === "pi.system"));
	assert.equal(dump(path), before, "observing must not migrate, recover, or write any database records");
	assert.equal(faux.state.callCount, calls, "observing never calls a model");

	await root.commit(async (tx) => {
		const doc = await tx.doc(TestDoc);
		doc.text = "Updated";
		doc.count++;
	}, context);
	const latest = inspector.snapshot(new URLSearchParams());
	assert.ok(Number(latest.seq) > Number(first.seq));
	assert.deepEqual(latest.documents.find((doc) => doc.record.kind === "test.state").value, await harness.snapshot(TestDoc, context), "Chord delta reconstruction matches the live harness");
	await harness.close(context);
	assert.equal(inspector.snapshot(new URLSearchParams()).entries.length, first.entries.length, "inspection survives writer shutdown");
});

test("entry pagination, global search, filters, context markers and fork cutoffs", async (t) => {
	const { path, root } = await fixture(t);
	const entries = await root.commit(async (tx) => {
		const result = [];
		for (let index = 0; index < 95; index++) result.push(await tx.appendEntry(root.id, {
			kind: "pi.user", model: [{ role: "user", content: `message-${index} ${index === 0 ? "needle_%'" : ""}`, timestamp: 0 }],
		}));
		return result;
	}, context);
	const fork = await root.fork(entries[4].id, { ownership: { kind: "ownerless" } }, context);
	await root.reset("Fresh context", context);
	await root.commit((tx) => tx.appendEntry(root.id, {
		kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "bad", toolName: "test", content: [{ type: "text", text: "failed" }], isError: true, timestamp: 0 }],
	}), context);
	const inspector = openInspector(path); t.after(() => inspector.close());
	const latest = inspector.snapshot(new URLSearchParams({ conversation: String(root.id) }));
	assert.equal(latest.entries.length, 80);
	assert.ok(latest.head);
	const older = inspector.snapshot(new URLSearchParams({ conversation: String(root.id), before: String(latest.next) }));
	assert.equal(older.entries[0].id, entries[0].id);
	assert.ok(older.entries.at(-1).id < latest.entries[0].id);
	assert.equal(older.next, null);
	const search = inspector.snapshot(new URLSearchParams({ conversation: String(root.id), q: "needle_%'" }));
	assert.deepEqual(search.entries.map((entry) => entry.id), [entries[0].id]);
	assert.equal(inspector.snapshot(new URLSearchParams({ filter: "failures" })).entries.length, 1);
	assert.equal(inspector.snapshot(new URLSearchParams({ filter: "tools" })).entries.length, 1);
	assert.ok(inspector.snapshot(new URLSearchParams({ filter: "system" })).entries.some((entry) => entry.kind === "pi.reset"));
	assert.equal(inspector.snapshot(new URLSearchParams({ conversation: String(fork.id) })).entries.length, 5);
	for (const params of ["conversation=99999", "before=-1", "conversation=1%20OR%201", "filter=bad", `q=${"a".repeat(501)}`]) assert.throws(() => inspector.snapshot(new URLSearchParams(params)));
});

test("HTTP boundary is GET-only, loopback/same-origin and serves no arbitrary files", async (t) => {
	const { path } = await fixture(t);
	const server = await createInspectorServer(path);
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const port = (server.address() as { port: number }).port;
	const base = `http://127.0.0.1:${port}`;
	const before = dump(path);
	const page = await fetch(base);
	assert.equal(page.status, 200);
	assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
	assert.match(await page.text(), /Durable · Inspector/);
	assert.equal((await fetch(`${base}/app.js`)).status, 200);
	assert.equal((await fetch(`${base}/style.css`)).status, 200);
	assert.equal((await fetch(`${base}/api/state`)).status, 200);
	assert.equal((await fetch(`${base}/api/state?before=bad`)).status, 400);
	assert.equal((await fetch(`${base}/api/tasks`)).status, 404, "the read-only inspector is not a manager");
	assert.equal((await fetch(`${base}/api/state`, { method: "POST" })).status, 405);
	assert.equal((await fetch(`${base}/api/state`, { headers: { Origin: "https://evil.test" } })).status, 403);
	assert.equal((await fetch(`${base}/api/state`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
	const wrongHost = await new Promise((resolve, reject) => {
		const req = request(`${base}/api/state`, { headers: { Host: "evil.test" } }, (res) => { res.resume(); resolve(res.statusCode); });
		req.on("error", reject); req.end();
	});
	assert.equal(wrongHost, 403);
	assert.equal((await fetch(`${base}/package.json`)).status, 404);
	assert.equal((await fetch(`${base}/session.sqlite`)).status, 404);
	assert.equal(dump(path), before);
});

test("missing databases are never created and unsupported schemas are never migrated", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "ask-inspector-schema-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "missing.sqlite");
	assert.throws(() => openInspector(path));
	await assert.rejects(stat(path), { code: "ENOENT" });
	const db = new DatabaseSync(path);
	db.exec("CREATE TABLE durable_schema(singleton INTEGER, version INTEGER); INSERT INTO durable_schema VALUES(1, 999)");
	assert.throws(() => openInspector(path), /Unsupported pi-durable schema/);
	assert.equal(db.prepare("SELECT version FROM durable_schema").get()!.version, 999);
	db.close();
});
