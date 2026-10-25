import { describe, expect, onTestFinished, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readFidelityRecord } from "./fidelity-records.mjs"
import { writeSnapshot } from "./source-snapshot.mjs"

const CLI = join(import.meta.dir, "report-tools.mjs")
const FIXTURE = readFileSync(join(import.meta.dir, "tests/fixtures/conversion-probe.html"), "utf8")
const FLATTENED = FIXTURE.replace(/<[^>]*>/g, "")
// Superscript boundaries preserve 4.2 + 2, 27.3 + 1 and 10 + 9 in raw.
const ALTERED = ["4.22", "27.31", "109"]

function sandbox(): string {
	const dir = mkdtempSync(join(tmpdir(), "conversion-probe-"))
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
	return dir
}

function probe(raw: string, converted: string) {
	const dir = sandbox()
	const rawFile = join(dir, "raw.html")
	const convertedFile = join(dir, "converted.txt")
	writeFileSync(rawFile, raw)
	writeFileSync(convertedFile, converted)
	const proc = spawnSync("node", [CLI, "source", "probe-conversion", rawFile, convertedFile], { encoding: "utf8" })
	expect(proc.error).toBeUndefined()
	expect(proc.stdout, proc.stderr).not.toBe("")
	return { exitCode: proc.status, json: JSON.parse(proc.stdout) }
}

describe("source probe-conversion", () => {
	test("#given the probe page #when naively flattened #then only fabricated numbers are altered", () => {
		const result = probe(FIXTURE, FLATTENED)
		expect(result.exitCode).toBe(1)
		// Stripping the adjacent table tags also joins Total's 2 to the first cell.
		expect(result.json.altered).toEqual([...ALTERED, "212,345"])
		expect(result.json.lost).toContain("2026")
		expect(result.json.lost).not.toContain("99.9")
		expect(result.json.altered).not.toContain("99.9")
	})

	test("#given raw bytes #when compared to themselves #then identity passes without alterations", () => {
		const result = probe(FIXTURE, FIXTURE)
		expect(result.exitCode).toBe(0)
		expect(result.json.altered).toEqual([])
		expect(result.json.lost).toEqual([])
		expect(result.json.raw_count).toBeGreaterThan(0)
		expect(result.json.converted_count).toBe(result.json.raw_count)
	})

	test("#given a tag-split decimal #when compared with text #then each side has one number", () => {
		const result = probe("<span>1</span><span>,</span><span>234.5</span>", "1,234.5")
		expect(result).toEqual({ exitCode: 0, json: { altered: [], lost: [], raw_count: 1, converted_count: 1 } })
	})

	test.each(["\u202f", "\u00a0"])("#given %s thousands separators #when converted to spaces #then grouping is equivalent", (separator: string) => {
		const result = probe(`1${separator}234${separator}567`, "1 234 567")
		expect(result).toEqual({ exitCode: 0, json: { altered: [], lost: [], raw_count: 1, converted_count: 1 } })
	})

	test("#given a machine date #when its attribute is removed #then it is lost, not altered", () => {
		const result = probe('<time datetime="2026-10-01T09:00:00Z">1 Oct</time>', "1 Oct")
		expect(result.exitCode).toBe(0)
		expect(result.json.altered).toEqual([])
		expect(result.json.lost).toEqual(["2026", "-10", "-01", "09", "00", "00"])
	})

	test("#given repeated signed decimals #when one count increases #then multiset subtraction preserves the excess", () => {
		const result = probe("-4.2 +7 2", "-4.2 +7 2; 2")
		expect(result.exitCode).toBe(1)
		expect(result.json.altered).toEqual(["2"])
		expect(result.json.lost).toEqual([])
	})

	test("#given hidden text #when omitted by conversion #then the number is only lost", () => {
		const result = probe('<span style="display:none">99.9</span>', "")
		expect(result.exitCode).toBe(0)
		expect(result.json.altered).toEqual([])
		expect(result.json.lost).toEqual(["99.9"])
	})
})

test("#given HTML snapshot conversion #when written #then source warnings use the fidelity envelope", () => {
	const { dir } = writeSnapshot(join(sandbox(), "sources"), "S1", {
		path: "fixture.html", html: FIXTURE, extractor: "model", observed_at: "2026-10-25T00:00:00Z",
	})
	const record = readFidelityRecord(join(dir, "conversion.json"), "source_conversion")
	expect(record.conversion_altered_numbers).toEqual(ALTERED)
	expect(record.record_kind).toBe("source_conversion")
	expect(record.artifact_sha256).toMatch(/^[0-9a-f]{64}$/)
	expect(record.report).toBe(join(dir, "source.html"))
	expect(record.written_at).toBe("2026-10-25T00:00:00.000Z")
	expect(record.defects).toEqual([])
})
