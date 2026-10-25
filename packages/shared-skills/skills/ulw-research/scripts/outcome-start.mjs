// outcome-start.mjs - existing run metadata clocks, never the interview's as-of date
// or the repair loop's later start. The basename fallback belongs to outcome.mjs.
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Existing manifest first (stable across re-init), then the recorded session start. */
export function sessionStartMetadata(sessionDir) {
	for (const [file, field] of [["outcome.json", "startedAt"], ["terminal-state.json", "started_at"]]) {
		let data
		try {
			data = JSON.parse(readFileSync(join(sessionDir, file), "utf8"))
		} catch (error) {
			if (error.code === "ENOENT" || error.code === "ENOTDIR") continue
			throw error
		}
		if (data?.[field] !== undefined) return { value: data[field], location: `${file}.${field}` }
	}
	return null
}
