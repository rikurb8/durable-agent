/**
 * One-process ownership of a manager state root.
 *
 * `BEGIN IMMEDIATE` on a dedicated database holds a RESERVED lock for the
 * manager's lifetime, so a second manager for the same root fails before it
 * opens the catalog or any task database. Default journal mode (no WAL) plus a
 * zero busy timeout makes contention fail immediately instead of retrying.
 * Process death releases the lock; no PID file or staleness cleanup is needed.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Ownership = {
	readonly root: string;
	release(): void;
};

export function acquireOwnership(root: string): Ownership {
	mkdirSync(root, { recursive: true });
	const db = new DatabaseSync(join(root, "owner.sqlite"), { timeout: 0 });
	try {
		db.exec("BEGIN IMMEDIATE");
	} catch (error) {
		db.close();
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Another manager owns ${root} (${message}). Stop it or choose a different state root.`);
	}
	let released = false;
	return {
		root,
		release() {
			if (released) return;
			released = true;
			try {
				db.exec("ROLLBACK");
			} finally {
				db.close();
			}
		},
	};
}
