import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { RuleId } from "./accent-stripes/findings"
import { lintFiles } from "./accent-stripes/lint"

const FIXTURES = join(import.meta.dir, "fixtures", "accent-stripes")
const SCRIPT = join(import.meta.dir, "check-accent-stripes.ts")

const EXPECTED: Readonly<Record<string, ReadonlyArray<[number, RuleId]>>> = {
	"border-top-card.css": [[1, "edge-stripe"]],
	"split-rule-and-token.scss": [[1, "edge-stripe"], [9, "edge-stripe"]],
	"pseudo-bar.css": [[7, "pseudo-bar"]],
	"inset-shadow.css": [[1, "inset-shadow-stripe"]],
	"apply.css": [[1, "edge-stripe"]],
	"tailwind-cards.tsx": [[4, "edge-stripe"], [5, "edge-stripe"]],
	"tailwind-pseudo.html": [[1, "pseudo-bar"]],
	"tailwind-inset-and-style.vue": [[2, "inset-shadow-stripe"], [7, "edge-stripe"]],
	"inline-styles.tsx": [[3, "edge-stripe"], [4, "edge-stripe"]],
	"cva-variant.ts": [[1, "edge-stripe"]],
	"styled-components.tsx": [[3, "edge-stripe"], [10, "edge-stripe"]],
}

function lintFixture(dir: string, name: string) {
	const path = join(FIXTURES, dir, name)
	return lintFiles([{ path, text: readFileSync(path, "utf8") }])
}

describe("#given a positive fixture with a coloured edge on a rounded surface", () => {
	test("#then every positive fixture has an expectation", () => {
		expect(readdirSync(join(FIXTURES, "positive")).sort()).toEqual(Object.keys(EXPECTED).sort())
	})

	for (const [name, expected] of Object.entries(EXPECTED)) {
		test(`#when ${name} is linted #then it reports exactly ${expected.length} finding(s) at the expected lines`, () => {
			const findings = lintFixture("positive", name).map((f): [number, RuleId] => [f.line, f.rule])
			expect(findings).toEqual([...expected])
		})
	}
})

describe("#given a negative fixture (neutral hairlines, flat edges, focus rings, validation, tables, overlays)", () => {
	for (const name of readdirSync(join(FIXTURES, "negative"))) {
		test(`#when ${name} is linted #then it reports nothing`, () => {
			expect(lintFixture("negative", name)).toEqual([])
		})
	}
})

describe("#given the radius and the stripe live in different stylesheets", () => {
	test("#when both files are linted together #then the stripe rule is flagged in its own file", () => {
		const findings = lintFiles([
			{ path: "base.css", text: ".card { border-radius: 12px; }\n" },
			{ path: "feature.css", text: "\n.card.card--promo { border-top: 4px solid #f97316; }\n" },
		])
		expect(findings.map((f) => [f.file, f.line, f.rule])).toEqual([["feature.css", 2, "edge-stripe"]])
	})
})

describe("#given the CLI", () => {
	const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 })

	test("#when it scans the positive fixtures #then it exits 1 and prints file:line findings", () => {
		const result = run(join(FIXTURES, "positive"))
		expect(result.status).toBe(1)
		expect(result.stdout).toMatch(/border-top-card\.css:1:1 {2}edge-stripe/)
	})

	test("#when it scans the negative fixtures #then it exits 0", () => {
		expect(run(join(FIXTURES, "negative")).status).toBe(0)
	})

	test("#when --json is passed #then stdout is a parseable findings array", () => {
		const result = run("--json", join(FIXTURES, "positive", "pseudo-bar.css"))
		expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ line: 7, rule: "pseudo-bar" })])
	})

	test("#when no path is given #then it exits 2 with usage", () => {
		const result = run()
		expect(result.status).toBe(2)
		expect(result.stderr).toContain("usage:")
	})
})
