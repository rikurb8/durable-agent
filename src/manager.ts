/**
 * Local manager API. One process owns the task root; HTTP handlers only
 * validate, persist a command, and return. No handler waits for model output.
 *
 *   npm run manage
 *
 * State root defaults to `.ask-agent/tasks` (or ASK_AGENT_MANAGER_ROOT).
 * Bind is loopback only and mutations pass the inspector's exact Host,
 * Origin, and Sec-Fetch-Site checks.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { applySecurityHeaders, isLocalSameOrigin } from "./http.ts";
import { openInspector } from "./inspector.ts";
import { isValidRequestId } from "./session.ts";
import { ConflictError, NotFoundError, TASK_ID_PATTERN } from "./task-store.ts";
import { TaskManager } from "./task-manager.ts";
import type { RunnerModel } from "./runner.ts";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_OBJECTIVE = 20_000;
const MAX_PROMPT = 20_000;
const MAX_KEY = 200;

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function parseModelValue(value: string): RunnerModel {
	const [provider, ...rest] = value.split("/");
	const modelId = rest.join("/");
	if (!provider || !modelId) throw new Error(`Model must look like <provider>/<model>, got "${value}".`);
	return { provider, modelId };
}

/** Server allowlist: the default always, plus any ASK_AGENT_MODELS entries. */
export function allowedModels(defaultModel: RunnerModel): RunnerModel[] {
	const configured = (process.env.ASK_AGENT_MODELS ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
	const models = [defaultModel, ...configured.map(parseModelValue)];
	return models.filter((model, index) => models.findIndex((item) => item.provider === model.provider && item.modelId === model.modelId) === index);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const type = String(request.headers["content-type"] ?? "").toLowerCase();
	if (!type.startsWith("application/json")) throw new HttpError(415, "Mutations require a JSON body.");
	const declared = Number(request.headers["content-length"] ?? 0);
	if (declared > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
		chunks.push(chunk as Buffer);
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	} catch {
		throw new HttpError(400, "Body must be valid JSON.");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Body must be a JSON object.");
	return value as Record<string, unknown>;
}

function requireOnly(body: Record<string, unknown>, allowed: readonly string[]): void {
	for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new HttpError(400, `Unknown field "${key}".`);
}

function requireString(value: unknown, name: string, max: number): string {
	if (typeof value !== "string") throw new HttpError(400, `"${name}" must be a string.`);
	const trimmed = value.trim();
	if (trimmed === "") throw new HttpError(400, `"${name}" must not be empty.`);
	if (value.length > max) throw new HttpError(413, `"${name}" is too long.`);
	return trimmed;
}

function requireTaskId(id: string): string {
	if (!TASK_ID_PATTERN.test(id)) throw new HttpError(404, "Unknown task.");
	return id;
}

function emptySnapshot(): unknown {
	return { seq: 0, conversations: [], entries: [], tasks: [], submissions: [], documents: [] };
}

export async function createManagerServer(manager: TaskManager): Promise<Server> {
	const assets = new Map(await Promise.all([
		["/", "index.html", "text/html"], ["/app.js", "app.js", "text/javascript"], ["/style.css", "style.css", "text/css"],
	].map(async ([route, file, type]) => [route, { body: await readFile(new URL(`./inspector/${file}`, import.meta.url)), type }] as const)));
	const models = manager.allowedModels;

	function taskState(taskId: string, params: URLSearchParams): unknown {
		const path = manager.sessionPath(taskId);
		if (!existsSync(path)) return emptySnapshot();
		const inspector = openInspector(path);
		try {
			return inspector.snapshot(params);
		} finally {
			inspector.close();
		}
	}

	async function route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
		const method = request.method ?? "GET";
		const segments = url.pathname.split("/").filter((part) => part !== "");
		// /api/tasks[...]
		if (segments[0] !== "api" || segments[1] !== "tasks") {
			if (method !== "GET") throw new HttpError(405, "Method not allowed.");
			const asset = assets.get(url.pathname);
			if (!asset) throw new HttpError(404, "Not found.");
			response.writeHead(200, { "Content-Type": `${asset.type}; charset=utf-8` });
			response.end(asset.body);
			return;
		}
		if (segments.length === 2) {
			if (method === "GET") {
				sendJson(response, 200, { status: "ok", root: manager.root, defaultModel: manager.defaultModel, models, tasks: manager.list() });
				return;
			}
			if (method === "POST") {
				const body = await readJsonBody(request);
				requireOnly(body, ["creationKey", "objective", "model"]);
				const creationKey = requireString(body.creationKey, "creationKey", MAX_KEY);
				const objective = requireString(body.objective, "objective", MAX_OBJECTIVE);
				let model: RunnerModel | undefined;
				if (body.model !== undefined) {
					if (typeof body.model !== "string") throw new HttpError(400, '"model" must be a string.');
					model = parseModelValue(body.model);
					if (!models.some((item) => item.provider === model!.provider && item.modelId === model!.modelId)) {
						throw new HttpError(400, `Model ${body.model} is not allowed.`);
					}
				}
				sendJson(response, 201, { task: manager.createTask({ creationKey, objective, ...(model ? { model } : {}) }) });
				return;
			}
			throw new HttpError(405, "Method not allowed.");
		}
		const taskId = requireTaskId(segments[2]!);
		if (segments.length === 3) {
			if (method !== "GET") throw new HttpError(405, "Method not allowed.");
			const detail = manager.detail(taskId);
			sendJson(response, 200, {
				task: detail.task,
				summary: detail.summary,
				requests: detail.requests,
				state: { available: existsSync(manager.sessionPath(taskId)) },
			});
			return;
		}
		if (segments.length !== 4) throw new HttpError(404, "Not found.");
		const action = segments[3]!;
		if (action === "state") {
			if (method !== "GET") throw new HttpError(405, "Method not allowed.");
			manager.detail(taskId); // 404 for an unknown task before touching a database
			sendJson(response, 200, taskState(taskId, url.searchParams));
			return;
		}
		if (method !== "POST") throw new HttpError(405, "Method not allowed.");
		manager.detail(taskId);
		if (action === "requests") {
			const body = await readJsonBody(request);
			requireOnly(body, ["requestId", "prompt"]);
			if (typeof body.requestId !== "string" || !isValidRequestId(body.requestId)) throw new HttpError(400, "Invalid requestId.");
			const prompt = requireString(body.prompt, "prompt", MAX_PROMPT);
			sendJson(response, 201, { task: manager.addRequest(taskId, { requestId: body.requestId, prompt }) });
			return;
		}
		if (action === "pause" || action === "resume") {
			const body = await readJsonBody(request);
			requireOnly(body, []);
			sendJson(response, 200, { task: action === "pause" ? manager.pause(taskId) : manager.resume(taskId) });
			return;
		}
		throw new HttpError(404, "Not found.");
	}

	const server = createServer((request, response) => {
		applySecurityHeaders(response);
		if (!isLocalSameOrigin(request, server)) {
			response.writeHead(403).end("Local same-origin access only");
			return;
		}
		const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
		route(request, response, url).catch((error: unknown) => {
			if (response.headersSent) {
				response.end();
				return;
			}
			const status = error instanceof HttpError ? error.status
				: error instanceof ConflictError ? 409
				: error instanceof NotFoundError ? 404
				: 400;
			response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
		});
	});
	return server;
}

if (import.meta.main) {
	let manager: TaskManager | undefined;
	try {
		const { values } = parseArgs({ options: { root: { type: "string" }, port: { type: "string", default: "4318" } } });
		const port = Number(values.port);
		if (!/^\d+$/.test(values.port!) || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
		const root = resolve(values.root ?? process.env.ASK_AGENT_MANAGER_ROOT ?? join(import.meta.dirname, "..", ".ask-agent", "tasks"));
		const defaultModel = parseModelValue(process.env.ASK_AGENT_MODEL ?? "radius/deepseek-v4.1-flash");
		manager = TaskManager.start({ root, defaultModel, models: allowedModels(defaultModel) });
		const server = await createManagerServer(manager);
		server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
		server.listen(port, "127.0.0.1", () => console.log(`Task manager: http://127.0.0.1:${port}\nState root: ${root}\nModel: ${defaultModel.provider}/${defaultModel.modelId}`));
		let closing = false;
		const shutdown = async () => {
			if (closing) return;
			closing = true;
			await new Promise<void>((done) => server.close(() => done()));
			await manager!.close();
			process.exit(0);
		};
		for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void shutdown(); });
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		await manager?.close();
		process.exitCode = 1;
	}
}
