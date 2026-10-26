import { describe, expect, onTestFinished, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFECT_CODES } from "./contracts.mjs"
import { run } from "./report-tools.mjs"
import { writeSnapshot } from "./source-snapshot.mjs"

type Json = Record<string, unknown> & { data?: Record<string, unknown>; error?: string }
const PAGE = "<p>USD 4.2<sup>2</sup> billion in revenue.</p><p>Staff grew to 1,250 people.</p>"

function session() {
	const dir = mkdtempSync(join(tmpdir(), "conversion-altered-"))
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
	return dir
}

async function snapshot(dir: string, html = PAGE) {
	const file = join(dir, "page.html")
	writeFileSync(file, html)
	return (await run(["source", "snapshot", "--id", "S1", "--html", file, "--session-dir", dir])) as { exitCode: number; json: Json; summary: string }
}

describe("the conversion probe result is consumed", () => {
	test("#given a page whose conversion altered a number #when snapshotted #then the JSON and the summary report it", async () => {
		const result = await snapshot(session())
		expect(result.exitCode).toBe(0)
		expect(result.json.data?.conversion_altered_numbers).toEqual(["4.22"])
		expect(result.summary).toContain("1 altered")
	})

	test("#given an altered 4.22 in conversion.json #when fact add --find locates it #then it refuses with conversion_altered_number and writes no row", async () => {
		const dir = session()
		await snapshot(dir)
		const result = (await run(["fact", "add", "--source", "S1", "--find", "USD", "--label", "usd_bn", "--session-dir", dir, "--json"])) as { exitCode: number; json: Json }
		expect(result.exitCode).toBe(1)
		expect(result.json.error).toBe("conversion_altered_number")
		expect(existsSync(join(dir, "fact-ledger.json"))).toBe(false)
		expect(DEFECT_CODES.conversion_altered_number).toMatchObject({ severity: "blocker", integrity: true })
	})

	test("#given an unaltered number in the same snapshot #when fact add --find locates it #then it registers", async () => {
		const dir = session()
		await snapshot(dir)
		const result = (await run(["fact", "add", "--source", "S1", "--find", "Staff grew to", "--label", "staff", "--session-dir", dir, "--json"])) as { exitCode: number; json: Json }
		expect(result.exitCode).toBe(0)
		expect((result.json.data?.row as { value: string }).value).toBe("1250")
	})

	test("#given a non-ISO observed_at #when writeSnapshot runs #then it throws before writing anything", () => {
		const dir = join(session(), "sources")
		expect(() => writeSnapshot(dir, "S1", { path: "p.html", html: PAGE, extractor: "model", observed_at: "yesterday" })).toThrow(TypeError)
		expect(existsSync(join(dir, "S1"))).toBe(false)
	})
})
