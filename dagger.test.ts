import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheSharingMode, ReturnType, type Client } from "@dagger.io/dagger";
import { parseDaggerArgs, runSession } from "./dagger.ts";

function fakeDagger(exitCode = 0) {
	const calls: { name: string; args: any[] }[] = [];
	const proxy: any = new Proxy({}, {
		get: (_target, name: string) => name === "then" ? undefined : (...args: any[]) => {
			calls.push({ name, args });
			if (name === "stdout" || name === "stderr") return Promise.resolve("");
			if (name === "exitCode") return Promise.resolve(exitCode);
			if (name === "sync") return Promise.resolve(proxy);
			if (name === "export") return Promise.resolve("exported");
			return proxy;
		},
	});
	return { client: proxy as Client, calls };
}

test("Dagger CLI requires a safe session and explicit request identity", () => {
	assert.deepEqual(parseDaggerArgs(["batteries", "--request-id", "r1", "Research"]), {
		mode: "run", session: "batteries", request: { requestId: "r1", mode: "prompt", task: "Research", verbosity: "normal" },
	});
	assert.deepEqual(parseDaggerArgs(["batteries", "--resume", "r1"]), {
		mode: "run", session: "batteries", request: { requestId: "r1", mode: "resume", verbosity: "normal" },
	});
	assert.deepEqual(parseDaggerArgs(["batteries", "--export"]), { mode: "export", session: "batteries" });
	assert.deepEqual(parseDaggerArgs(["--test"]), { mode: "test" });
	for (const args of [[], ["../escape", "--export"], ["batteries", "Research"], ["batteries", "--export", "extra"]]) {
		assert.throws(() => parseDaggerArgs(args));
	}
});

test("failed runs export partial articles, retain locked session state, and invalidate only execution cache", async (t) => {
	const previous = process.env.RADIUS_API_KEY;
	process.env.RADIUS_API_KEY = "test-secret";
	t.after(() => { if (previous === undefined) delete process.env.RADIUS_API_KEY; else process.env.RADIUS_API_KEY = previous; });
	const { client, calls } = fakeDagger(7);
	const prompt = 'Research "$HOME"; do not interpret this as shell syntax';
	assert.equal(await runSession(client, "batteries", { requestId: "r1", mode: "prompt", task: prompt }), 7);
	const mount = calls.find((call) => call.name === "withMountedCache")!;
	assert.equal(mount.args[0], "/work");
	assert.deepEqual(mount.args[2], { sharing: CacheSharingMode.Locked });
	assert.deepEqual(calls.find((call) => call.name === "cacheVolume")!.args, ["ask-agent-v1-batteries"]);
	const execs = calls.filter((call) => call.name === "withExec");
	assert.deepEqual(execs[0].args[0], ["npm", "ci"]);
	assert.equal(execs.at(-1)!.args[1].expect, ReturnType.Any);
	assert.equal(execs.at(-1)!.args[1].experimentalPrivilegedNesting, false);
	assert.deepEqual(execs.at(-1)!.args[0].slice(-4), ["--request-id", "r1", "--", prompt]);
	assert.match(execs.at(-1)!.args[0][2], /status=\$\?[\s\S]*cp -a[\s\S]*exit "\$status"/);
	assert.equal(calls.filter((call) => call.name === "export").length, 1);
	assert.ok(calls.some((call) => call.name === "setSecret" && call.args[0] === "RADIUS_API_KEY"));
	assert.ok(!calls.some((call) => call.name === "withEnvVariable" && call.args[1] === "test-secret"));
	const firstNonce = calls.find((call) => call.name === "withEnvVariable" && call.args[0] === "ASK_AGENT_INVOCATION")!.args[1];
	const second = fakeDagger();
	await runSession(second.client, "batteries", { requestId: "r1", mode: "resume" });
	const secondNonce = second.calls.find((call) => call.name === "withEnvVariable" && call.args[0] === "ASK_AGENT_INVOCATION")!.args[1];
	assert.notEqual(firstNonce, secondNonce);
	assert.deepEqual(second.calls.filter((call) => call.name === "withExec").at(-1)!.args[0].slice(-2), ["--resume", "r1"]);
	const source = calls.find((call) => call.name === "directory")!;
	assert.deepEqual(source.args[1].include, ["package.json", "package-lock.json", "*.ts", "test/**"]);
});

test("export-only needs no credentials and does not start an agent; unknown sessions fail", async () => {
	for (const exitCode of [0, 1]) {
		const { client, calls } = fakeDagger(exitCode);
		assert.equal(await runSession(client, "batteries"), exitCode);
		assert.ok(!calls.some((call) => call.name === "setSecret"));
		const execs = calls.filter((call) => call.name === "withExec");
		assert.equal(execs.length, 1);
		assert.ok(!execs[0].args[0][2].includes("ask-agent.ts"));
		assert.equal(calls.filter((call) => call.name === "export").length, exitCode === 0 ? 1 : 0);
	}
});
