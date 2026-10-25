// Availability is checked before hash/locator checks, including the raw-byte snapshot contract.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sha256Of } from "./cli-support.mjs"

export function snapshotsReadable(ctx, rows, cited, sourcesDir, out) {
	let readable = true
	for (const [id, node] of cited) {
		const row = rows.get(id)
		if (!row?.source_id) continue
		try {
			if (!sourcesDir) throw new Error("no sources directory")
			const dir = join(sourcesDir, row.source_id)
			const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))
			if (!meta || typeof meta.sha256 !== "string") throw new Error("invalid snapshot metadata")
			const raw = join(dir, "raw.bin")
			const needsRaw = row.locator?.unit === "utf8-bytes" && meta.kind !== "converted-only"
			const body = readFileSync(existsSync(raw) || needsRaw ? raw : join(dir, "text.txt"))
			if (sha256Of(body) !== meta.sha256) throw new Error("snapshot hash mismatch")
		} catch {
			readable = false
			out.push({ ...ctx.defect("snapshot_hash_mismatch", node, `${id}: snapshot ${row.source_id} metadata or body is unreadable or does not match its pinned hash`), fact_id: id })
		}
	}
	return readable
}
