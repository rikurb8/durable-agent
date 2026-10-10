import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, UserEntry, type Conversation, type Harness, type InboxItem } from "@earendil-works/pi-durable";
import { resolveVerbosity, VERBOSITY_OPTIONS, type Verbosity } from "./verbosity.ts";

/** Host request IDs: 1–128 letters, digits, dots, underscores or hyphens. */
export const REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidRequestId(id: string): boolean {
	return REQUEST_ID_PATTERN.test(id);
}

export type ResearchRequest = {
	requestId: string;
	/** `prompt` submits once, `resume` only waits, `chat` reads prompts from stdin. */
	mode: "prompt" | "resume" | "chat";
	task?: string;
	verbosity: Verbosity;
};

export function parseRequest(args: string[], requireId = false): ResearchRequest {
	const { values, positionals } = parseArgs({
		args, allowPositionals: true,
		options: { "request-id": { type: "string" }, resume: { type: "string" }, ...VERBOSITY_OPTIONS },
	});
	const task = positionals.join(" ").trim();
	if (values.resume !== undefined && (values["request-id"] !== undefined || task !== "")) {
		throw new Error("Use --resume <request-id> without a prompt or --request-id.");
	}
	const suppliedId = values.resume ?? values["request-id"];
	if (requireId && suppliedId === undefined) throw new Error("Dagger runs require --request-id <id> or --resume <id>.");
	const requestId = suppliedId ?? randomUUID();
	if (!isValidRequestId(requestId)) {
		throw new Error("Request ID must be 1–128 letters, digits, dots, underscores or hyphens, starting with a letter or digit.");
	}
	// No prompt and no --resume is the interactive session; --request-id only seeds its first turn.
	const mode = values.resume !== undefined ? "resume" : task === "" ? "chat" : "prompt";
	if (mode === "chat" && requireId) throw new Error('usage: --request-id <id> "<task>" | --resume <id>');
	return { requestId, mode, verbosity: resolveVerbosity(values), ...(mode === "prompt" ? { task } : {}) };
}

/** Resolve a request before enabling recovery, so typos never start unrelated work. */
export async function selectSubmission(harness: Harness, root: Conversation, request: ResearchRequest) {
	const existing = await root.commit(async (tx) => {
		const submission = await tx.submissionByRequest(root.id, request.requestId);
		if (!submission) return undefined;
		if (submission.type !== "input") throw new Error("Request ID belongs to a non-input submission.");
		if (request.task !== undefined) {
			const content = submission.entry
				? (await tx.entry(UserEntry, submission.entry))?.model?.find((message) => message.role === "user")?.content
				: (await tx.doc(InboxDoc, root.id)).items.find((item): item is Extract<InboxItem, { mode: "steer" | "followUp" }> => item.id === submission.id && item.mode !== "write")?.content;
			if (content !== request.task) throw new Error("Request ID already belongs to a different prompt. Use --resume or a new --request-id.");
		}
		return submission;
	}, BACKGROUND_CONTEXT);
	if (existing) return (await harness.submission(existing.id, BACKGROUND_CONTEXT))!;
	if (request.task === undefined) throw new Error(`Unknown request ${request.requestId}; check the session and request ID.`);
	return root.submit({ type: "input", content: request.task, requestId: request.requestId, whenBusy: "reject" }, BACKGROUND_CONTEXT);
}
