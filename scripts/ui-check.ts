/**
 * Opt-in browser acceptance check for the task-first UI.
 *
 * Uses the `chrome-devtools` CLI (from chrome-devtools-mcp) to drive a real
 * headless Chrome through the manager UI, while the manager runs in-process on
 * a faux model. Not part of `npm test`: it needs Chrome and, on first run, npm.
 *
 *   npm run ui:check
 *
 * Override the binary with CHROME_DEVTOOLS, or the pinned npx version with
 * CHROME_DEVTOOLS_MCP_VERSION.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { McpClient } from "@earendil-works/pi-mcp";
import { createManagerServer } from "../src/manager.ts";
import type { RunnerModel } from "../src/runner.ts";
import { TaskManager } from "../src/task-manager.ts";

const MODEL: RunnerModel = { provider: "faux", modelId: "faux-1" };
const VERSION = process.env.CHROME_DEVTOOLS_MCP_VERSION ?? "1.10.1";
const COMMAND = process.env.CHROME_DEVTOOLS
	? [process.env.CHROME_DEVTOOLS]
	: ["npx", "-y", "-p", `chrome-devtools-mcp@${VERSION}`, "chrome-devtools"];
/** `--watch` (or UI_WATCH=1) runs a visible Chrome, paces the steps, and stays open. */
const watch = process.argv.includes("--watch") || process.env.UI_WATCH === "1";
const log = (message: string) => process.stderr.write(`[ui] ${message}\n`);
const pace = (ms = 1500) => (watch ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const waitSignal = () => new Promise<void>((resolve) => {
	// An interval keeps the event loop alive while we wait for Ctrl-C.
	const keep = setInterval(() => {}, 1 << 30);
	const done = () => { clearInterval(keep); resolve(); };
	process.once("SIGINT", done);
	process.once("SIGTERM", done);
});

function run(args: string[], timeoutMs = 60_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(COMMAND[0]!, [...COMMAND.slice(1), ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`chrome-devtools ${args[0]} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(new Error(`chrome-devtools ${args[0]} exited ${code}\n${stderr.slice(-600)}`));
		});
	});
}

async function browser(args: string[]): Promise<string> {
	try {
		return await run(args);
	} catch (error) {
		// `stop` on a clean machine has no daemon to stop.
		if (args[0] === "stop") return "";
		throw error;
	}
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => { resolve = settle; });
	return { promise, resolve };
}

/** A model response that holds until the gate opens or the Harness cancels it. */
function blocked(gate: Promise<void>, message: string): FauxResponseFactory {
	return async (_context, options) => {
		const signal = options?.signal;
		await new Promise<void>((resolve) => {
			if (signal?.aborted) return resolve();
			signal?.addEventListener("abort", () => resolve(), { once: true });
			void gate.then(() => resolve());
		});
		return fauxAssistantMessage(message);
	};
}

const passed: string[] = [];
let cleanup: (() => Promise<void>) | undefined;
function check(condition: unknown, message: string): void {
	if (!condition) throw new Error(`UI check failed: ${message}`);
	passed.push(message);
}

async function main(): Promise<void> {
	const work = await mkdtemp(join(tmpdir(), "ask-ui-check-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const client = { callTool: async () => ({ content: [] }), close: async () => {} } as unknown as McpClient;
	const manager = TaskManager.start({
		root: work, defaultModel: MODEL, models: [MODEL],
		deps: { connectMcp: async () => client, loadModels: async () => models },
	});
	const server = await createManagerServer(manager);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as { port: number }).port;
	const base = `http://127.0.0.1:${port}`;
	cleanup = async () => {
		await browser(["stop"]).catch(() => {});
		await manager.close().catch(() => {});
		await rm(work, { recursive: true, force: true }).catch(() => {});
	};

	// Task three is paused mid-stream, and its resumed attempt issues a new request.
	const gate = { one: deferred(), two: deferred(), three: deferred(), paused: deferred() };
	faux.setResponses([
		blocked(gate.one.promise, "Answer one."),
		blocked(gate.two.promise, "Answer two."),
		blocked(gate.paused.promise, "interrupted"),
		blocked(gate.three.promise, "Answer three."),
	]);

	let evalCount = 0;
	async function evaluate(pageId: number, body: string): Promise<unknown> {
		const file = join(work, `eval-${evalCount++}.json`);
		await browser(["evaluate_script", `() => { ${body} }`, "--pageId", String(pageId), "--filePath", file, "--waitForStableDom=false", "--output-format=json"]);
		return JSON.parse(await readFile(file, "utf8"));
	}
	const statusOf = (pageId: number, objective: string) => evaluate(pageId, `
		const name = ${JSON.stringify(objective)};
		const card = [...document.querySelectorAll('#task-list .task-card')].find((node) => node.querySelector('.objective')?.textContent === name);
		return card ? card.querySelector('.badge')?.textContent ?? null : null;
	`);
	const createTask = (pageId: number, objective: string) => evaluate(pageId, `
		document.getElementById('objective').value = ${JSON.stringify(objective)};
		document.getElementById('create-task').requestSubmit();
		return true;
	`);
	const selectTask = (pageId: number, objective: string) => evaluate(pageId, `
		const name = ${JSON.stringify(objective)};
		[...document.querySelectorAll('#task-list .task-card')].find((node) => node.querySelector('.objective')?.textContent === name)?.click();
		return true;
	`);
	const click = (pageId: number, id: string) => evaluate(pageId, `document.getElementById(${JSON.stringify(id)}).click(); return true;`);
	const text = (pageId: number, id: string) => evaluate(pageId, `return document.getElementById(${JSON.stringify(id)}).textContent;`);
	async function waitFor(pageId: number, objective: string, expected: string, timeoutMs = 20_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		let seen: unknown;
		while (Date.now() < deadline) {
			seen = await statusOf(pageId, objective);
			if (seen === expected) return;
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
		throw new Error(`Timed out waiting for "${objective}" to be ${expected} (saw ${String(seen)})`);
	}

	try {
		log(watch ? "starting visible Chrome" : "starting headless Chrome");
		await browser(["stop"]);
		// A headed daemon must be started before any tool call auto-starts a headless one.
		if (watch) await browser(["start", "--headless=false"]);
		const opened = JSON.parse(await browser(["new_page", `${base}/`, "--output-format=json"])) as { pages: { id: number; url: string }[] };
		const pageId = opened.pages.find((page) => page.url.startsWith(base))?.id;
		check(pageId !== undefined, "Chrome opened the manager UI");
		if (pageId === undefined) throw new Error("no Chrome page for the manager UI");
		check(await text(pageId, "mode") === "MANAGER", "manager mode is detected from GET /api/tasks");
		await pace();

		// Create, queue, run, complete — entirely through the UI.
		log("create → queue → run → complete");
		await createTask(pageId, "UI task one");
		await waitFor(pageId, "UI task one", "Running");
		await pace();
		await createTask(pageId, "UI task two");
		check(await statusOf(pageId, "UI task two") === "Queued", "the second task queues while one runner is active");
		check(await statusOf(pageId, "UI task one") === "Running", "the first task shows Running from live runner ownership");
		await pace();
		gate.one.resolve();
		await waitFor(pageId, "UI task one", "Completed");
		await waitFor(pageId, "UI task two", "Running");
		await pace();
		gate.two.resolve();
		await waitFor(pageId, "UI task two", "Completed");
		check(await text(pageId, "task-result") === "Answer two.", "the selected task shows its result");
		check(String(await text(pageId, "task-workspace")).startsWith("Local workspace: "), "the local workspace path is visible");
		await pace();

		// Switching tasks must never show another task's transcript or result.
		log("switch tasks");
		await selectTask(pageId, "UI task one");
		await new Promise((resolve) => setTimeout(resolve, 1500));
		check(await text(pageId, "task-result") === "Answer one.", "switching tasks shows that task's own result");
		const timeline = String(await text(pageId, "content"));
		check(timeline.includes("Answer one.") && !timeline.includes("Answer two."), "the timeline never mixes two tasks' transcripts");
		const console = JSON.parse(await browser(["list_console_messages", String(pageId), "--types", "error", "--output-format=json"])) as { consoleMessages?: unknown[] };
		check((console.consoleMessages?.length ?? 0) === 0, "the page logs no console errors");
		await pace();

		// Pause closes the active run; resume reattaches the same request.
		log("pause and resume");
		await createTask(pageId, "UI task three");
		await waitFor(pageId, "UI task three", "Running");
		await pace();
		await click(pageId, "pause");
		await waitFor(pageId, "UI task three", "Paused");
		check(await evaluate(pageId, `return document.getElementById('pause').disabled;`) === true, "pause is disabled while paused");
		await pace();
		await click(pageId, "resume");
		await waitFor(pageId, "UI task three", "Running");
		check(await text(pageId, "task-result") !== "interrupted", "a paused stream never settles as a result");
		await pace();
		gate.three.resolve();
		await waitFor(pageId, "UI task three", "Completed");
		check(await text(pageId, "task-result") === "Answer three.", "a resumed task keeps the same request and completes");
		await pace();

		// A stopped manager must read as disconnected, not as live work.
		log("stop manager");
		await new Promise<void>((done) => server.close(() => done()));
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline && await text(pageId, "mode") !== "MANAGER OFFLINE") await new Promise((resolve) => setTimeout(resolve, 250));
		check(await text(pageId, "mode") === "MANAGER OFFLINE", "a stopped manager is visibly disconnected");
		if (watch) {
			log(`browser left open at ${base}/ — press Ctrl-C to close it`);
			await waitSignal();
		}
	} catch (error) {
		if (watch) {
			log(`check failed; browser left open for inspection at ${base}/ — press Ctrl-C to close it`);
			await waitSignal();
		}
		throw error;
	}
}

try {
	await main();
	console.log(`UI check passed (${passed.length} assertions):`);
	for (const item of passed) console.log(`  ok  ${item}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
await cleanup?.();
// The browser daemon can keep a pipe open; exit instead of waiting on it.
process.exit(process.exitCode ?? 0);
