// Holds the manager-root lock for the parent test, then is SIGKILLed to prove release.
import { acquireOwnership } from "../src/ownership.ts";

const ownership = acquireOwnership(process.argv[2]!);
process.send?.({ type: "locked" });
process.on("SIGTERM", () => { ownership.release(); process.exit(0); });
// Keep the process alive until it is killed.
setInterval(() => {}, 1000);
