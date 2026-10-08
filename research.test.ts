import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { contentText, type ClassifierContext, type ClassifierResult } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { McpClient } from "@earendil-works/pi-mcp";
import { newsExtension } from "./news-agent.ts";

const spent = {
	input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
	cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
};

function fixture() {
	const mcpCalls: { name: string; args: unknown }[] = [];
	const classified: ClassifierContext[] = [];
	const client = {
		callTool: async (name: string, args: unknown, options?: { signal?: AbortSignal }) => {
			options?.signal?.throwIfAborted();
			mcpCalls.push({ name, args });
			const data = name === "tools_webSearch_run"
				? [{ url: "https://news.test/a", text: "relevant reporting" }, { url: "https://news.test/b", text: "advertisement" }]
				: { text: "Full source evidence", url: "https://news.test/a" };
			return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
		},
	};
	const models = {
		getModelOfType: () => ({ provider: "typesafe", id: "jev-latest" }),
		classify: async (_model: unknown, context: ClassifierContext): Promise<ClassifierResult> => {
			classified.push(context);
			return {
				api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", timestamp: 0,
				stopReason: "stop", answers: { relevant: { type: "bool", probability: context.state.text === "relevant reporting" ? 0.95 : 0.1 } },
				usage: spent,
			};
		},
	};
	const codemode = newsExtension(client as unknown as McpClient).tools!.find((tool) => tool.name === "codemode")!;
	const api = { callId: "test", models } as unknown as ToolExecutionApi;
	const run = (code: string, context = BACKGROUND_CONTEXT) => codemode.execute({ code }, api, context);
	return { run, client, models, mcpCalls, classified };
}

const sourceArgs = JSON.stringify({ topic: "news", url: "https://news.test/a", text: "relevant reporting" });

test("parallel search → deduplicate → classify → fetch only the shortlist; count classifier spend", async () => {
	const { run, mcpCalls, classified } = fixture();
	const result = await run(`
		const searches = await Promise.allSettled(["news", "news primary sources"].map(query => tools.web_search({query})));
		const sources = searches.filter(r => r.status === "fulfilled").flatMap(r => JSON.parse(r.value));
		const unique = [...new Map(sources.map(s => [s.url, s])).values()];
		const scored = await Promise.all(unique.map(async source => JSON.parse(await tools.classify_source({topic: "news", ...source}))));
		const urls = scored.filter(s => s.probability >= 0.7).map(s => s.url);
		return JSON.parse(await tools.web_fetch({urls}));
	`);
	assert.equal(result.isError, false);
	assert.deepEqual(JSON.parse(contentText(result.content!)), { text: "Full source evidence", url: "https://news.test/a" });
	assert.equal(classified.length, 2);
	assert.deepEqual(mcpCalls.at(-1), { name: "tools_webFetch_run", args: { body: { urls: ["https://news.test/a"] } } });
	assert.equal(result.usage?.totalTokens, 8);
	assert.equal(result.usage?.cost.total, 0.004);
	assert.ok(result.details && typeof result.details === "object" && "calls" in result.details);
	assert.ok(Array.isArray(result.details.calls));
	assert.equal(result.details.calls.length, 5);
});

test("nested arguments are validated before MCP or classifier requests", async () => {
	const { run, mcpCalls, classified } = fixture();
	const result = await run(`return await Promise.allSettled([
		tools.web_search({}), tools.web_fetch({}), tools.classify_source({topic: "news"})
	]);`);
	const statuses = JSON.parse(contentText(result.content!)).map((r: { status: string }) => r.status);
	assert.deepEqual(statuses, ["rejected", "rejected", "rejected"]);
	assert.equal(mcpCalls.length, 0);
	assert.equal(classified.length, 0);
});

test("classifier failure preserves partial output and reported spend, never invents scores", async () => {
	const { run, models } = fixture();
	models.classify = async () => ({
		api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", timestamp: 0,
		stopReason: "error", answers: {}, errorMessage: "missing credential", usage: spent,
	});
	const result = await run(`text("search done"); return await tools.classify_source(${sourceArgs});`);
	assert.equal(result.isError, true);
	assert.match(contentText(result.content!), /search done[\s\S]*missing credential/);
	assert.equal(result.usage?.cost.total, 0.002);
});

test("invalid classifier probabilities are errors", async () => {
	const { run, models } = fixture();
	const classify = models.classify;
	models.classify = async (...args) => ({ ...await classify(...args), answers: { relevant: { type: "bool", probability: 2 } } });
	const result = await run(`return await tools.classify_source(${sourceArgs});`);
	assert.equal(result.isError, true);
	assert.match(contentText(result.content!), /no valid relevance score/);
});

test("MCP errors reject nested calls", async () => {
	const { run, client } = fixture();
	client.callTool = async () => ({ isError: true, content: [{ type: "text", text: "search unavailable" }] });
	const result = await run(`return await tools.web_search({query: "news"});`);
	assert.equal(result.isError, true);
	assert.match(contentText(result.content!), /search unavailable/);
});

test("sandbox has no file tools or host APIs; state is execution-local", async () => {
	const { run } = fixture();
	const first = await run(`store("x", 1); return [typeof process, typeof fetch, ALL_TOOLS.map(t => t.name), load("x")];`);
	assert.deepEqual(JSON.parse(contentText(first.content!)), ["undefined", "undefined", ["web_search", "web_fetch", "classify_source"], 1]);
	const second = await run(`return load("x") ?? null;`);
	assert.equal(contentText(second.content!), "null");
});

test("script call budget stops excessive requests", async () => {
	const { run, mcpCalls } = fixture();
	const result = await run(`for (let i = 0; i < 33; i++) await tools.web_search({query: "news"});`);
	assert.equal(result.isError, true);
	assert.match(contentText(result.content!), /exceeded 32/);
	assert.equal(mcpCalls.length, 32);
});

test("cancellation reaches the nested MCP request", async () => {
	const { run, client } = fixture();
	const controller = new AbortController();
	let nestedSignal: AbortSignal | undefined;
	client.callTool = async (_name, _args, options) => {
		nestedSignal = options?.signal;
		setImmediate(() => controller.abort());
		return new Promise((_resolve, reject) => nestedSignal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
	};
	const result = await run(`await tools.web_search({query: "news"});`, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
	assert.equal(result.isError, true);
	assert.equal(nestedSignal?.aborted, true);
});
