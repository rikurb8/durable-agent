import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, type ClassifierContext, type ClassifierResult } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { McpClient } from "@earendil-works/pi-mcp";
import { askExtension } from "./ask-agent.ts";

const spent = {
	input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
	cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
};

/** Fake Radius MCP + classifier. Two queries overlap on `shared`, and `/b` is an advertisement. */
function fixture() {
	const mcpCalls: { name: string; args: any }[] = [];
	const classified: ClassifierContext[] = [];
	const client = {
		callTool: async (name: string, args: any) => {
			mcpCalls.push({ name, args });
			if (name === "tools_webSearch_run") {
				const query = args.body.query as string;
				const results = query.includes("policy")
					? [{ url: "https://example.test/shared", text: "shared" }, { url: "https://example.test/b", text: "advert" }]
					: [{ url: "https://example.test/a", text: "relevant" }, { url: "https://example.test/shared", text: "shared" }];
				return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
			}
			const url = args.body.urls[0] as string;
			return { content: [{ type: "text" as const, text: JSON.stringify({ url, text: `Full text of ${url}` }) }] };
		},
	};
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	models.getModelOfType = (() => ({ provider: "typesafe", id: "jev-latest" })) as typeof models.getModelOfType;
	models.classify = (async (_model: unknown, context: ClassifierContext): Promise<ClassifierResult> => {
		classified.push(context);
		const { url } = context.state as { url: string };
		return {
			api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", timestamp: 0,
			stopReason: "stop",
			answers: { relevant: { type: "bool", probability: url.endsWith("/b") ? 0.1 : 0.95 } },
			usage: spent,
		};
	}) as typeof models.classify;
	return { client, faux, models, mcpCalls, classified };
}

const researchCall = (id: string) => fauxAssistantMessage(
	fauxToolCall("research", { question: "battery recycling", queries: ["batteries recycling", "battery policy"] }, { id }),
	{ stopReason: "toolUse" },
);

/** Drive one run through the real Harness and return what the model saw and what the agent spent. */
async function runResearch(f: ReturnType<typeof fixture>, responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
	const registry = createRegistry();
	registry.install(askExtension(f.client as unknown as McpClient));
	const harness = await Harness.open(new MemoryStorage(), { models: f.models, registry }, BACKGROUND_CONTEXT);
	f.faux.setResponses(responses);
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	try {
		const settled = await (await root.submit({ type: "input", content: "Research batteries", requestId: "r1" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		assert.equal(settled.status, "done");
		const entries = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
		const toolResult = entries.items.find((entry) => entry.kind === "pi.tool-result" && (entry as any).model?.[0]?.toolName === "research")!;
		const tasks = await root.commit(async (tx) => (await tx.scanTasks({ conversationId: root.id }, 100)).items.map((task) => task.kind), BACKGROUND_CONTEXT);
		return { text: contentText((toolResult as any).model[0].content), usage: (await harness.usage(BACKGROUND_CONTEXT)).tools, tasks };
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

test("research runs search → classify → fetch as durable child tasks, deduplicating URLs", async () => {
	const f = fixture();
	const { text, usage, tasks } = await runResearch(f, [researchCall("research"), fauxAssistantMessage("Done.")]);

	// One search child per query, one classify child per unique URL, one fetch child per shortlisted URL.
	assert.equal(tasks.filter((kind) => kind === "ask.search").length, 2);
	assert.equal(tasks.filter((kind) => kind === "ask.classify").length, 3);
	assert.equal(tasks.filter((kind) => kind === "ask.fetch").length, 2);
	assert.equal(tasks.filter((kind) => kind === "ask.research").length, 1);

	const searches = f.mcpCalls.filter((call) => call.name === "tools_webSearch_run").map((call) => call.args.body.query);
	assert.deepEqual(searches.sort(), ["batteries recycling", "battery policy"]);
	const fetched = f.mcpCalls.filter((call) => call.name === "tools_webFetch_run").map((call) => call.args.body.urls[0]);
	assert.deepEqual(fetched.sort(), ["https://example.test/a", "https://example.test/shared"], "only the shortlist is fetched");
	assert.deepEqual(f.classified.map((context) => (context.state as { url: string }).url).sort(),
		["https://example.test/a", "https://example.test/b", "https://example.test/shared"], "each candidate is classified once");

	assert.match(text, /https:\/\/example\.test\/a \[relevance 0\.95\]/);
	assert.match(text, /https:\/\/example\.test\/shared \[relevance 0\.95\]/);
	assert.match(text, /Full text of https:\/\/example\.test\/a/);
	assert.doesNotMatch(text, /example\.test\/b/, "the advertisement never reaches the model");
	// Classifier spend is reported on the tool result, so it lands in the conversation's usage.
	assert.equal(usage.research?.cost.total, 0.006);
});

test("a failing classifier is disclosed as a step failure, never replaced with a score", async () => {
	const f = fixture();
	f.models.classify = (async (_model: unknown, context: ClassifierContext): Promise<ClassifierResult> => {
		f.classified.push(context);
		return {
			api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", timestamp: 0,
			stopReason: "error", answers: {}, errorMessage: "missing credential", usage: spent,
		};
	}) as typeof f.models.classify;
	const { text, usage } = await runResearch(f, [researchCall("research"), fauxAssistantMessage("Done.")]);

	assert.match(text, /FAILED classify failed: Classifier typesafe\/jev-latest failed: missing credential/);
	assert.match(text, /Fetched 0 sources; 3 steps failed\./);
	assert.equal(f.mcpCalls.filter((call) => call.name === "tools_webFetch_run").length, 0, "nothing is fetched without a score");
	assert.equal(usage.research?.cost.total, 0.006, "failed classifier attempts still count");
});

test("a research task that cannot start is an error result, not a silent empty answer", async () => {
	const f = fixture();
	f.client.callTool = async () => { throw new Error("MCP unreachable"); };
	const { text } = await runResearch(f, [researchCall("research"), fauxAssistantMessage("Done.")]);
	assert.match(text, /FAILED search faulted: MCP unreachable/);
	assert.match(text, /Fetched 0 sources; 2 steps failed\./);
});

test("an empty search result is a disclosed failure, not a silent empty answer", async () => {
	const f = fixture();
	f.client.callTool = async () => ({ content: [{ type: "text" as const, text: "[]" }] });
	const { text } = await runResearch(f, [researchCall("research"), fauxAssistantMessage("Done.")]);

	assert.match(text, /research failed: Research found no usable sources/);
	assert.equal(f.classified.length, 0, "nothing is classified without candidates");
});

test("SIGKILL mid-fetch resumes at the fetch phase: paid classification is not repeated", { timeout: 30000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "ask-research-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	async function worker(mode: string) {
		const child = fork(join(import.meta.dirname, "test", "research-worker.ts"), [mode, directory], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
		t.after(() => { child.kill("SIGKILL"); });
		let stderr = "";
		child.stderr!.on("data", (chunk) => { stderr += chunk; });
		child.stdout!.resume();
		const closed = once(child, "close");
		const message = await Promise.race([
			once(child, "message").then(([message]) => message as { type: string; status?: string }),
			closed.then(([code, signal]) => { throw new Error(`Worker exited early: ${code}/${signal}\n${stderr}`); }),
		]);
		if (mode === "crash") {
			assert.equal(message.type, "ready-to-kill");
			child.kill("SIGKILL");
			assert.equal((await closed)[1], "SIGKILL");
		} else {
			assert.equal((await closed)[0], 0, stderr);
			assert.equal(message.status, "done");
		}
		return message;
	}
	await worker("crash");
	await worker("resume");

	const lines = async (name: string) => (await readFile(join(directory, name), "utf8")).trim().split("\n");
	assert.deepEqual((await lines("search.txt")).sort(), ["batteries recycling", "battery policy"], "each search ran once, before the crash");
	assert.deepEqual((await lines("classify.txt")).sort(), ["https://example.test/a", "https://example.test/shared"], "the paid classification did not repeat");
	const fetches = await lines("fetch.txt");
	assert.ok(fetches.every((url) => url === "https://example.test/a" || url === "https://example.test/shared"), "only the shortlist is fetched");
	assert.ok(fetches.length > 2, "the interrupted fetch phase replayed");
	assert.match(await readFile(join(directory, "articles/researched/article.md"), "utf8"), /https:\/\/example\.test\/a/);
});
