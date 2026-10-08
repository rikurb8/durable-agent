/**
 * Self-check for the wiring news-agent.ts depends on: Radius credential, MCP connection,
 * the web search tool, and the model catalog. Run with `npm run check`.
 */
import { connectRadiusMcp } from "./news-agent.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { toLlmContent } from "@earendil-works/pi-mcp";

const client = await connectRadiusMcp();
try {
	const result = await client.callTool("tools_webSearch_run", {
		body: { query: "earendil works pi", max_results: 3 },
	});
	if (result.isError === true) throw new Error(`web search failed: ${JSON.stringify(toLlmContent(result))}`);
	const text = toLlmContent(result)
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
	if (!text.includes("http")) throw new Error(`web search returned no links: ${text.slice(0, 200)}`);
	console.log(`radius mcp: ok (${text.length} chars)`);

	const models = await ModelRuntime.create();
	const model = models.getModel("radius", "deepseek-v4.1-flash");
	if (model === undefined) throw new Error("radius/deepseek-v4.1-flash not in the model catalog");
	console.log(`model catalog: ok (${model.id})`);
} finally {
	await client.close();
}
