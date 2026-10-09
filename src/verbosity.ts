/**
 * How much of a run to log. `normal` is what the CLI has always printed; the
 * higher levels add the event-stream detail that is otherwise discarded.
 *
 *   --quiet / -q   only the answer
 *   (default)      the answer, tool names, and task failures
 *   --verbose / -v tool arguments and results, retries, spend
 *   --verbose -v   same as -vv: turns, thinking, entries, checkpoints
 */
export const VERBOSITY = { quiet: 0, normal: 1, verbose: 2, debug: 3 } as const;
export type Verbosity = keyof typeof VERBOSITY;

export const VERBOSE = VERBOSITY.verbose;
export const DEBUG = VERBOSITY.debug;

/** Flags every entrypoint accepts, so `-v` is never mistaken for part of the prompt. */
export const VERBOSITY_OPTIONS = {
	verbose: { type: "boolean", short: "v", multiple: true },
	quiet: { type: "boolean", short: "q" },
} as const;

/** `--quiet` wins, then `-v`/`-vv`, then `ASK_AGENT_VERBOSITY`, then normal. */
export function resolveVerbosity(flags: { verbose?: boolean[]; quiet?: boolean } = {}): Verbosity {
	if (flags.quiet === true) return "quiet";
	if ((flags.verbose?.length ?? 0) >= 2) return "debug";
	if (flags.verbose?.length === 1) return "verbose";
	const env = process.env.ASK_AGENT_VERBOSITY;
	return env !== undefined && Object.hasOwn(VERBOSITY, env) ? (env as Verbosity) : "normal";
}
