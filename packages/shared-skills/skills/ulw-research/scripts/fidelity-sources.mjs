// Source integrity and raw quote anchoring, shared by the fidelity value checks.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { sha256Of } from "./cli-support.mjs"
import { proseText } from "./html-lite.mjs"
import { reanchor } from "./raw-locator.mjs"

export function sourceChecks(ctx, rows, cited, sourcesDir, flag) {
	const ids = new Set([...cited.keys()].map((id) => rows.get(id)?.source_id).filter(Boolean))
	for (const match of proseText(ctx.body).matchAll(/\[S(\d+)\]/g)) ids.add(`S${match[1]}`)
	const meta = new Map()
	for (const id of sourcesDir ? ids : []) {
		const dir = join(sourcesDir, id)
		const metaPath = join(dir, "meta.json")
		if (!existsSync(metaPath)) continue
		const info = JSON.parse(readFileSync(metaPath, "utf8"))
		meta.set(id, info)
		const rawPath = join(dir, "raw.bin")
		const referenced = [...cited.keys()].map((key) => rows.get(key)).filter((row) => row.source_id === id)
		if (!existsSync(rawPath)) {
			const current = referenced.filter((row) => row.locator?.unit === "utf8-bytes")
			if (current.length && info.kind !== "converted-only") flag("snapshot_not_raw", ctx.body, `${id} has no raw.bin`)
			// Legacy rows keep their original text hash contract until explicitly re-registered.
			const textPath = join(dir, "text.txt")
			if (existsSync(textPath) && sha256Of(readFileSync(textPath)) !== info.sha256) flag("snapshot_hash_mismatch", ctx.body, `${id}/text.txt changed after its legacy snapshot was pinned`)
			for (const row of current) {
				if (info.kind === "converted-only" && row.kind === "measured") flag("snapshot_not_raw", cited.get(row.fact_id), `${row.fact_id} cannot measure a converted-only source`)
				else if (info.kind === "converted-only") flag("quote_fuzzy_match", cited.get(row.fact_id), `${row.fact_id} quotes a converted-only source, not the original fetched body`)
			}
			continue
		}
		const raw = readFileSync(rawPath)
		const actual = sha256Of(raw)
		if (info.sha256 !== actual || referenced.some((row) => row.locator?.unit === "utf8-bytes" && row.snapshot_sha256 !== actual)) {
			flag("snapshot_hash_mismatch", ctx.body, `${id}/raw.bin changed after its snapshot was pinned`)
			continue
		}
		for (const row of referenced.filter((row) => row.locator?.unit === "utf8-bytes")) {
			const anchor = reanchor(raw, row)
			if (!anchor) flag("quote_not_verbatim", cited.get(row.fact_id), `${row.fact_id}: no unique exact quote and context in ${id}/raw.bin`)
			else if (anchor.relocated) flag("relocated", cited.get(row.fact_id), `${row.fact_id}: ${row.locator.char_start}:${row.locator.char_end} -> ${anchor.start}:${anchor.end} (utf8-bytes)`)
		}
	}
	return meta
}
