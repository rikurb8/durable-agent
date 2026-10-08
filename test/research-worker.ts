// Child process used by research.test.ts: the parent kills it during the fetch phase of a research task.
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { McpClient } from "@earendil-works/pi-mcp";
import { askExtension } from "../ask-agent.ts";
import { selectSubmission } from "../session.ts";

const [mode, directory] = process.argv.slice(2);
const log = (name: string, line: string) => appendFile(join(directory, name), `${line}\n`);
const spent = {
	input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
	cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
};

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
models.getModelOfType = (() => ({ provider: "typesafe", id: "jev-latest" })) as typeof models.getModelOfType;
// Every classify call is logged, so the test can prove a resumed run never pays for one twice.
models.classify = (async (_model: unknown, context: ClassifierContext): Promise<ClassifierResult> => {
	const { url } = context.state as { url: string };
	await log("classify.txt", url);
	return {
		api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", timestamp: 0,
		stopReason: "stop", answers: { relevant: { type: "bool", probability: 0.95 } }, usage: spent,
	};
}) as typeof models.classify;

const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
	fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
faux.setResponses(mode === "crash" ? [
	call("research", { question: "batteries", queries: ["batteries recycling", "battery policy"] }, "research"),
] : [
	call("write", { path: "articles/researched/article.md", content: "# Batteries\nSource: https://example.test/a\n" }, "article"),
	fauxAssistantMessage("Research complete."),
]);

const client = {
	callTool: async (name: string, args: any) => {
		if (name === "tools_webSearch_run") {
			await log("search.txt", args.body.query);
			return { content: [{ type: "text" as const, text: JSON.stringify([
				{ url: "https://example.test/a", text: "relevant" },
				{ url: "https://example.test/shared", text: "shared" },
			]) }] };
		}
		const url = args.body.urls[0] as string;
		await log("fetch.txt", url);
		if (mode === "crash") {
			process.send?.({ type: "ready-to-kill" });
			await new Promise(() => {});
		}
		return { content: [{ type: "text" as const, text: JSON.stringify({ url, text: `Full text of ${url}` }) }] };
	},
};

const registry = createRegistry();
registry.install(CodingTools);
registry.install(askExtension(client as unknown as McpClient));
const harness = await Harness.open(await openNodeSqliteStorage(join(directory, ".ask-agent", "session.sqlite")), {
	models, registry, env: () => new NodeExecutionEnv({ cwd: directory }),
}, BACKGROUND_CONTEXT);
try {
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory } });
	const request = mode === "resume" ? { requestId: "research-1" } : { requestId: "research-1", task: "Research batteries" };
	const settled = await (await selectSubmission(harness, root, request)).wait(BACKGROUND_CONTEXT);
	process.send?.({ type: "done", status: settled.status, modelCalls: faux.state.callCount });
} finally {
	await harness.close(BACKGROUND_CONTEXT);
	process.disconnect?.();
}
