// Child process used by session.test.ts: the parent kills it during a real durable tool call.
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { McpClient } from "@earendil-works/pi-mcp";
import { askExtension } from "../src/ask-agent.ts";
import { selectSubmission } from "../src/session.ts";

const [mode, directory] = process.argv.slice(2);
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
faux.setResponses(mode === "crash" ? [
	call("web_search", { query: "batteries" }, "search"),
	call("web_fetch", { urls: ["https://example.test/batteries"] }, "fetch"),
] : [
	call("write", { path: "articles/recovered/article.md", content: "# Batteries\nSource: https://example.test/batteries\n" }, "article"),
	fauxAssistantMessage("Research complete."),
]);
const client = {
	callTool: async (name: string) => {
		await appendFile(join(directory, "calls.txt"), `${name}\n`);
		if (mode === "crash" && name === "tools_webFetch_run") {
			process.send?.({ type: "ready-to-kill" });
			await new Promise(() => {});
		}
		return { content: [{ type: "text", text: "Battery evidence: https://example.test/batteries" }] };
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
	const request = mode === "resume" ? { requestId: "research-1", mode: "resume" } : { requestId: "research-1", mode: "prompt", task: "Research batteries" };
	const submission = await selectSubmission(harness, root, request);
	const settled = await submission.wait(BACKGROUND_CONTEXT);
	const entries = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	process.send?.({ type: "done", status: settled.status, id: submission.id, modelCalls: faux.state.callCount,
		userEntries: entries.items.filter((entry) => entry.kind === "pi.user").length });
} finally {
	await harness.close(BACKGROUND_CONTEXT);
	process.disconnect?.();
}
