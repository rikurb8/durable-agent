import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CacheSharingMode, connect, ReturnType, type Client } from "@dagger.io/dagger";
import { parseRequest, type ResearchRequest } from "./session.ts";

// Multi-platform Node 24 image; update the digest deliberately with the lockfile.
export const NODE_IMAGE = "node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20";
const SOURCE_FILES = ["*.ts", "test/**"];
const EXEC_OPTIONS = { expect: ReturnType.Any, experimentalPrivilegedNesting: false, insecureRootCapabilities: false };

export function parseDaggerArgs(args: string[]) {
	if (args.length === 1 && args[0] === "--test") return { mode: "test" } as const;
	const [session, ...rest] = args;
	if (!session || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(session)) {
		throw new Error('usage: npm run dagger -- <session> --request-id <id> "<task>" | <session> --resume <id> | <session> --export | --test');
	}
	if (rest.length === 1 && rest[0] === "--export") return { mode: "export", session } as const;
	return { mode: "run", session, request: parseRequest(rest, true) } as const;
}

export function researcherContainer(dag: Client) {
	const source = dag.host().directory(import.meta.dirname, { include: ["package.json", "package-lock.json", ...SOURCE_FILES] });
	return dag.container().from(NODE_IMAGE).withWorkdir("/app")
		.withFile("package.json", source.file("package.json"))
		.withFile("package-lock.json", source.file("package-lock.json"))
		.withExec(["npm", "ci"], { experimentalPrivilegedNesting: false })
		.withDirectory("/app", source, { include: SOURCE_FILES });
}

/** Copy artifacts out of the cache mount during the same locked exec, even on a nonzero exit. */
export async function runSession(dag: Client, session: string, request?: ResearchRequest) {
	if (request && !process.env.RADIUS_API_KEY) throw new Error("Set RADIUS_API_KEY before running research in Dagger.");
	let container = request ? researcherContainer(dag) : dag.container().from(NODE_IMAGE);
	// ponytail: engine-local cache is recoverable state, not permanent storage; use external durable storage before promising engine-loss recovery.
	container = container.withMountedCache("/work", dag.cacheVolume(`ask-agent-v1-${session}`), { sharing: CacheSharingMode.Locked })
		.withWorkdir("/work")
		.withEnvVariable("ASK_AGENT_STATE_DIR", "/work/.ask-agent")
		// Cache dependency installation, never an agent invocation or an artifact snapshot.
		.withEnvVariable("ASK_AGENT_INVOCATION", randomUUID());
	if (request) {
		for (const name of ["RADIUS_API_KEY", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]) {
			const value = process.env[name];
			if (value) container = container.withSecretVariable(name, dag.setSecret(name, value));
		}
		for (const name of ["ASK_AGENT_MODEL", "ASK_AGENT_CLASSIFIER"]) {
			const value = process.env[name];
			if (value) container = container.withEnvVariable(name, value);
		}
	}
	const args = !request ? [] : request.task === undefined
		? ["--resume", request.requestId]
		: ["--request-id", request.requestId, "--", request.task];
	const script = request ? `
mkdir -p /work/articles /out || exit "$?"
node /app/ask-agent.ts "$@"
status=$?
cp -a /work/articles /out/articles || exit "$?"
exit "$status"
` : `
test -d /work/articles || { echo 'No articles found for this session.' >&2; exit 1; }
mkdir -p /out && cp -a /work/articles /out/articles
`;
	const result = await container.withExec(["sh", "-c", script, "research", ...args], EXEC_OPTIONS).sync();
	process.stdout.write(await result.stdout());
	process.stderr.write(await result.stderr());
	const exitCode = await result.exitCode();
	// Missing export-only sessions have no /out; an agent failure still has partial articles to export.
	if (request || exitCode === 0) {
		const output = join(import.meta.dirname, "dagger-output", session);
		await result.directory("/out").export(output);
		console.log(`Articles exported to ${output}/articles`);
	}
	return exitCode;
}

if (import.meta.main) {
	try {
		const options = parseDaggerArgs(process.argv.slice(2));
		await connect(async (dag) => {
			if (options.mode === "test") {
				const result = await researcherContainer(dag).withEnvVariable("ASK_AGENT_INVOCATION", randomUUID())
					.withExec(["npm", "test"], EXEC_OPTIONS).sync();
				process.stdout.write(await result.stdout());
				process.stderr.write(await result.stderr());
				process.exitCode = await result.exitCode();
			} else {
				process.exitCode = await runSession(dag, options.session, options.mode === "run" ? options.request : undefined);
			}
		}, { LogOutput: process.stderr });
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
