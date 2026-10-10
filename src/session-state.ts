/**
 * Read-only window into one task's durable database.
 *
 * The manager uses it to reconcile execution intent against what was actually
 * committed, without opening a writable Harness for work that already settled.
 * Mirrors the inspector: a short-lived read-only connection, never a migration.
 */
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type DurableStatus = "absent" | "queued" | "placed" | "done" | "unanswered";

export type SessionProbe = {
	readonly status: DurableStatus;
	/** Session commit sequence; advances when a run makes durable progress. */
	readonly nextSeq: number;
	/** Answer text of a completed submission, or `""`. */
	readonly answerText: string;
	/** Terminal reason of an unanswered submission, or `""`. */
	readonly reason: string;
};

const ABSENT: SessionProbe = { status: "absent", nextSeq: 0, answerText: "", reason: "" };

/** Assistant text of one stored entry record. */
function entryText(record: unknown): string {
	const model = (record as { model?: { role?: string; content?: unknown }[] } | undefined)?.model;
	if (!Array.isArray(model)) return "";
	for (let i = model.length - 1; i >= 0; i--) {
		const message = model[i];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		return message.content
			.filter((part): part is { type: "text"; text: string } => (part as { type?: string })?.type === "text")
			.map((part) => part.text)
			.join("");
	}
	return "";
}

/**
 * Probe `session.sqlite` for one request. A missing, empty, or not-yet-migrated
 * database reads as `absent`; the caller then treats the request as not admitted.
 */
export function probeSession(path: string, requestId: string): SessionProbe {
	try {
		if (statSync(path).size === 0) return ABSENT;
	} catch {
		return ABSENT;
	}
	const db = new DatabaseSync(path, { readOnly: true, timeout: 0 });
	try {
		const row = db
			.prepare("SELECT status, record FROM submissions WHERE json_extract(record, '$.requestId') = ?")
			.get(requestId) as { status: DurableStatus; record: string } | undefined;
		const metadata = db.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get() as { next_seq: number } | undefined;
		const nextSeq = Number(metadata?.next_seq ?? 0);
		if (!row) return { ...ABSENT, nextSeq };
		const record = JSON.parse(row.record) as { answer?: number; reason?: string };
		let answerText = "";
		if (row.status === "done" && record.answer !== undefined) {
			const entry = db.prepare("SELECT record FROM entries WHERE id = ?").get(record.answer) as { record: string } | undefined;
			if (entry) answerText = entryText(JSON.parse(entry.record));
		}
		return { status: row.status, nextSeq, answerText, reason: record.reason ?? "" };
	} catch {
		// A database being created concurrently has no schema yet.
		return ABSENT;
	} finally {
		db.close();
	}
}
