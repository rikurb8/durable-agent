/**
 * Durable general assistant: a pi-durable Harness that chats, searches the web through
 * the Radius MCP server when a question needs sources, and edits this repo's files
 * when asked.
 *
 *   npm start                                 # interactive chat
 *   npm start -- "What changed recently?" # one-shot prompt
 *
 * State lives in `.ask-agent/session.sqlite` (or ASK_AGENT_STATE_DIR).
 * Use --request-id <id> for idempotent submission, --resume <id> for recovery.
 *
 * This file is the CLI adapter: signals, readline, and stdout formatting.
 * Execution lives in `src/runner.ts`.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { parseRequest, type ResearchRequest } from "./session.ts";
import { errorMessage, PreModelError, Runner, type RunnerModel, type RunnerOutcome } from "./runner.ts";
import { DEBUG, VERBOSITY, VERBOSE } from "./verbosity.ts";

/** Re-exported so `scripts/check.ts` and recovery tests keep one import site. */
export { askExtension, connectRadiusMcp, lastAssistantText, radiusToken } from "./runner.ts";

const MODEL = process.env.ASK_AGENT_MODEL ?? "radius/deepseek-v4.1-flash";

function parseModel(value: string): RunnerModel {
	const [provider, ...rest] = value.split("/");
	const modelId = rest.join("/");
	if (!provider || !modelId) throw new Error(`Model must look like <provider>/<model>, got "${value}".`);
	return { provider, modelId };
}

/** Compact one-line form of a tool's arguments or a usage ledger. */
function summarize(value: unknown, max = 300): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text === undefined) return String(value);
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatUsage(state: {
	models: Record<string, { totalTokens: number; cost: { total: number } }>;
	tools: Record<string, { totalTokens: number; cost: { total: number } }>;
}): string {
	const parts: string[] = [];
	for (const [bucket, entries] of [["models", state.models], ["tools", state.tools]] as const) {
		for (const [key, usage] of Object.entries(entries)) {
			parts.push(`${bucket}:${key} ${usage.totalTokens} tok $${usage.cost.total.toFixed(4)}`);
		}
	}
	return parts.join(", ");
}

async function run(request: ResearchRequest) {
	const level = VERBOSITY[request.verbosity];
	const say = (text: string) => process.stdout.write(`${text}\n`);
	const verbose = (text: string) => { if (level >= VERBOSE) process.stderr.write(`${text}\n`); };
	const debug = (text: string) => { if (level >= DEBUG) process.stderr.write(`${text}\n`); };
	const interactive = request.mode === "chat";
	if (!interactive && level >= VERBOSITY.normal) say(`[request ${request.requestId}]`);

	// Presentation of committed agent events; the runner only reports them.
	const logEvent = (event: AgentEvent) => {
		switch (event.type) {
			case "tool_execution_start":
				if (level >= VERBOSITY.normal) say(`[${event.toolName}]`);
				verbose(`[${event.toolName}] args ${summarize(event.args)}`);
				break;
			case "tool_execution_end":
				verbose(`[${event.toolName}] ${event.entry ? "returned" : "no result"}`);
				break;
			case "message_end":
				if (event.entry.kind !== "pi.assistant") debug(`[entry ${event.entry.kind}]`);
				break;
			case "task_failed":
				process.stderr.write(`[${event.kind} failed] ${event.message}\n`);
				break;
			case "auto_retry_start":
				verbose(`[retry ${event.attempt}] ${event.errorMessage}`);
				break;
			case "usage_changed":
				verbose(`[usage] ${formatUsage(event.usage)}`);
				break;
			case "submission":
				verbose(`[submission ${event.record.id} ${event.record.status}]`);
				break;
			case "compaction_start":
				verbose(`[compaction ${event.reason}${event.blocking ? " blocking" : ""}]`);
				break;
			case "turn_start":
			case "turn_end":
			case "run_start":
			case "run_end":
			case "auto_retry_end":
			case "deferred_poll":
			case "compaction_end":
			case "entry_appended":
			case "agent_changed":
			case "message_start":
			case "inbox_update":
			case "tool_execution_update":
				debug(`[${event.type}] ${summarize(event, 200)}`);
				break;
			case "message_update":
				for (const change of event.changes) {
					if (change.type === "thinking_delta") debug(`[thinking] ${change.delta}`);
				}
				break;
			case "snapshot":
				debug(`[snapshot] ${event.entries.length} entries, ${event.tools.length} tools, usage ${formatUsage(event.usage)}`);
				break;
		}
	};

	const stateDir = process.env.ASK_AGENT_STATE_DIR ?? join(import.meta.dirname, "..", ".ask-agent");
	const model = parseModel(MODEL);
	const controller = new AbortController();
	// Name the turn in flight, so the pause message is a request ID --resume accepts.
	let currentId = request.requestId;
	const pause = () => controller.abort(new Error(`Paused. Resume with --resume ${currentId}.`));
	process.once("SIGINT", pause);
	process.once("SIGTERM", pause);
	// terminal:false keeps the TTY in canonical mode, so Ctrl-C reaches the SIGINT handler above
	// instead of readline; prompts and answers are written directly.
	const input = interactive ? createInterface({ input: process.stdin, terminal: false }) : undefined;
	let runner: Runner | undefined;
	try {
		runner = await Runner.open({ stateDir, workspace: process.cwd(), model, onEvent: logEvent });
		const runTurn = async (turn: ResearchRequest) => {
			currentId = turn.requestId;
			let settled: RunnerOutcome;
			try {
				settled = await runner!.run({ requestId: turn.requestId, prompt: turn.task ?? "" }, controller.signal);
			} catch (error) {
				if (controller.signal.aborted) throw new Error(`Paused. Resume with --resume ${currentId}.`);
				throw error;
			}
			if (settled.status !== "done") {
				const message = `Request ${turn.requestId} is terminally unanswered: ${settled.reason}.`;
				if (!interactive) throw new Error(`${message} Submit a follow-up with a new --request-id to retry using the saved context.`);
				process.stderr.write(`[${message} The saved context still works; send another message to continue.]\n`);
			}
			if (settled.answerText !== "") say(settled.answerText);
		};
		if (interactive) {
			const prompt = process.stdin.isTTY ? "> " : "";
			let firstTurn = true;
			if (level >= VERBOSITY.normal) say("Chat mode: ask away; `exit` or Ctrl-D quits, Ctrl-C pauses the current turn.");
			if (prompt !== "") process.stdout.write(prompt);
			for await (const line of input!) {
				const task = line.trim();
				if (task === "") { if (prompt !== "") process.stdout.write(prompt); continue; }
				if (task === "exit" || task === "quit") break;
				// A supplied --request-id seeds the first turn, so a crash there is resumable.
				await runTurn({ requestId: firstTurn ? request.requestId : randomUUID(), mode: "prompt", task, verbosity: request.verbosity });
				firstTurn = false;
				if (prompt !== "") process.stdout.write(prompt);
			}
		} else {
			await runTurn(request);
		}
	} finally {
		input?.close();
		process.removeListener("SIGINT", pause);
		process.removeListener("SIGTERM", pause);
		await runner?.close();
	}
}

if (import.meta.main) {
	try {
		await run(parseRequest(process.argv.slice(2)));
	} catch (error) {
		console.error(error instanceof PreModelError ? `Pre-model failure: ${errorMessage(error)}` : errorMessage(error));
		process.exitCode = 1;
	}
}
