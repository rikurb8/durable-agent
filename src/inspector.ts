import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parseArgs } from "node:util";
import { apply } from "@earendil-works/chord/delta";

const PAGE_SIZE = 80;

function positiveInteger(value: string | null, name: string): number | undefined {
	if (value === null) return undefined;
	const number = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid ${name}`);
	return number;
}

/** Never use the durable storage opener here: it performs migrations and owns writes. */
export function openInspector(path: string) {
	const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
	try {
		db.exec("PRAGMA query_only = ON");
		const schema = db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get();
		if (schema?.version !== 1) throw new Error(`Unsupported pi-durable schema: ${schema?.version ?? "missing"} (expected 1)`);
	} catch (error) {
		db.close();
		throw error;
	}
	const records = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args).map((row) => JSON.parse(String(row.record)));

	function documents(conversation: number) {
		return records("SELECT record FROM documents WHERE retired_at IS NULL AND (scope_kind = 'session' OR (scope_kind = 'conversation' AND owner_id = ?)) ORDER BY id", conversation).map((record) => {
			const base = db.prepare("SELECT seq, version, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1").get(record.id);
			if (!base) throw new Error(`Document ${record.id} has no base revision`);
			let value = JSON.parse(String(base.content));
			for (const delta of db.prepare("SELECT kind, version, content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq").all(record.id, base.seq)) {
				if (delta.kind !== "delta" || delta.version !== base.version) throw new Error(`Invalid revision for document ${record.id}`);
				value = apply(value, JSON.parse(String(delta.content)));
			}
			return { record, version: base.version, value };
		});
	}

	function snapshot(params: URLSearchParams) {
		const requested = positiveInteger(params.get("conversation"), "conversation");
		const before = positiveInteger(params.get("before"), "entry cursor");
		const query = params.get("q") ?? "";
		if (query.length > 500) throw new Error("Search is limited to 500 characters");
		const filter = params.get("filter") ?? "all";
		if (!["all", "messages", "tools", "failures", "system"].includes(filter)) throw new Error("Invalid filter");
		// A short read transaction keeps documents, entries and task records on the same WAL snapshot.
		db.exec("BEGIN");
		try {
			const conversations = records("SELECT record FROM conversations ORDER BY id DESC");
			const conversation = requested ?? conversations.at(-1)?.id;
			if (conversation !== undefined && !conversations.some((item) => item.id === conversation)) throw new Error("Unknown conversation");
			const seq = db.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get()!.next_seq;
			if (conversation === undefined) return { seq, conversations, entries: [], tasks: [], submissions: [], documents: [] };
			// Forks inherit the parent's transcript only up to the fork entry.
			const segments: string[] = [];
			const args: SQLInputValue[] = [];
			const visited = new Set<number>();
			let current = conversations.find((item) => item.id === conversation);
			let upper = Number.MAX_SAFE_INTEGER;
			while (current) {
				if (visited.has(current.id)) throw new Error("Invalid conversation ancestry");
				visited.add(current.id);
				segments.push("(conversation_id = ? AND id <= ?)");
				args.push(current.id, upper);
				if (!current.parent) break;
				upper = Math.min(upper, current.parent.at);
				current = conversations.find((item) => item.id === current.parent.conversationId);
				if (!current) throw new Error("Missing parent conversation");
			}
			const ancestry = `(${segments.join(" OR ")})`;
			const head = records(`SELECT record FROM entries WHERE ${ancestry} AND head IS NOT NULL ORDER BY id DESC LIMIT 1`, ...args)[0]?.head;
			const clauses = [ancestry];
			if (before !== undefined) { clauses.push("id < ?"); args.push(before); }
			if (query) { clauses.push("instr(lower(record), lower(?)) > 0"); args.push(query); }
			if (filter === "messages") clauses.push("json_extract(record, '$.kind') IN ('pi.user', 'pi.assistant')");
			if (filter === "tools") clauses.push("(json_extract(record, '$.kind') = 'pi.tool-result' OR EXISTS (SELECT 1 FROM json_tree(entries.record, '$.model') WHERE key = 'type' AND value = 'toolCall'))");
			if (filter === "system") clauses.push("json_extract(record, '$.kind') IN ('pi.system', 'pi.compaction', 'pi.reset')");
			if (filter === "failures") clauses.push("EXISTS (SELECT 1 FROM json_tree(entries.record) WHERE (key = 'isError' AND value = 1) OR (key = 'stopReason' AND value IN ('error', 'aborted')))");
			const page = records(`SELECT record FROM entries WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...args, PAGE_SIZE + 1);
			const entries = page.slice(0, PAGE_SIZE).reverse();
			// shortcut: task and request lists are unpaged; paginate if sessions grow large enough to slow polling.
			return {
				seq, conversation, conversations, head, entries,
				next: page.length > PAGE_SIZE ? entries[0].id : null,
				tasks: records(`SELECT record FROM tasks WHERE conversation_id IN (${[...visited].map(() => "?").join(",")}) ORDER BY id`, ...visited),
				submissions: records("SELECT record FROM submissions WHERE conversation_id = ? ORDER BY id DESC", conversation),
				documents: documents(conversation),
			};
		} finally {
			db.exec("ROLLBACK");
		}
	}
	return { snapshot, close: () => db.close() };
}

export async function createInspectorServer(path: string) {
	const inspector = openInspector(path);
	const assets = new Map(await Promise.all([
		["/", "index.html", "text/html"], ["/app.js", "app.js", "text/javascript"], ["/style.css", "style.css", "text/css"],
	].map(async ([route, file, type]) => [route, { body: await readFile(new URL(`./inspector/${file}`, import.meta.url)), type }] as const)).catch((error) => { inspector.close(); throw error; }));
	const server = createServer((request, response) => {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
		const authority = `127.0.0.1:${(server.address() as { port: number }).port}`;
		const origin = `http://${authority}`;
		if (request.headers.host !== authority || (request.headers.origin && request.headers.origin !== origin) || request.headers["sec-fetch-site"] === "cross-site") {
			response.writeHead(403).end("Local same-origin access only"); return;
		}
		if (request.method !== "GET") { response.writeHead(405, { Allow: "GET" }).end("Read-only inspector"); return; }
		try {
			const url = new URL(request.url!, origin);
			if (url.pathname === "/api/state") {
				response.setHeader("Content-Type", "application/json; charset=utf-8");
				response.end(JSON.stringify(inspector.snapshot(url.searchParams)));
			} else {
				const asset = assets.get(url.pathname);
				if (!asset) { response.writeHead(404).end("Not found"); return; }
				response.setHeader("Content-Type", `${asset.type}; charset=utf-8`);
				response.end(asset.body);
			}
		} catch (error) {
			response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
		}
	});
	server.on("close", () => inspector.close());
	return server;
}

if (import.meta.main) {
	try {
		const { values } = parseArgs({ options: { db: { type: "string" }, port: { type: "string", default: "4317" } } });
		const port = positiveInteger(values.port!, "port")!;
		if (port > 65535) throw new Error("Invalid port");
		const path = resolve(values.db ?? join(process.env.ASK_AGENT_STATE_DIR ?? join(import.meta.dirname, "..", ".ask-agent"), "session.sqlite"));
		const server = await createInspectorServer(path);
		server.on("error", (error) => { console.error(error.message); server.close(); process.exitCode = 1; });
		server.listen(port, "127.0.0.1", () => console.log(`Inspector: http://127.0.0.1:${port}\nRead-only: ${path}`));
		for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
