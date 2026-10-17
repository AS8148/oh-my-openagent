import { type CssRule, parseCss } from "./css-parse"
import { ALL_CORNERS, type Corner, hasEdgeStripe, hasInsetShadowStripe, hasRadius, isPseudoBar, roundedCorners } from "./declarations"
import { type Finding, lineLocator, type RuleId } from "./findings"
import { classGroups, cssTemplates, inlineStyles, styleBlocks } from "./markup"
import { type Compound, compoundCovers, isExemptSelector, parseCompound, selectorParts } from "./selector"
import { checkClassSet } from "./tailwind"

export type SourceFile = { readonly path: string; readonly text: string }

const STYLESHEET = /\.(?:css|scss|less|pcss|postcss)$/i
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/i

function cssRulesOf(file: SourceFile): CssRule[] {
	if (STYLESHEET.test(file.path)) return parseCss(file.text, 0, !/\.css$/i.test(file.path))
	const blocks = SCRIPT.test(file.path) ? cssTemplates(file.text) : styleBlocks(file.text)
	return blocks.flatMap((b) => parseCss(b.css, b.offset, true))
}

function ruleHasRadius(rule: CssRule): boolean {
	return hasRadius(rule.declarations) || rule.applyClasses.some((c) => /^rounded(?:-|$)/.test(c) && !/none$/.test(c))
}

function radiusIndex(rules: readonly CssRule[]): Compound[] {
	return rules.filter(ruleHasRadius).flatMap((r) => selectorParts(r.selector).map(parseCompound))
}

const NO_CORNERS: ReadonlySet<Corner> = new Set()

function hostCorners(part: string, rule: CssRule, index: readonly Compound[]): ReadonlySet<Corner> {
	if (!parseCompound(part).pseudoElement) {
		if (hasRadius(rule.declarations)) return roundedCorners(rule.declarations)
		if (ruleHasRadius(rule)) return ALL_CORNERS
	}
	const host = parseCompound(part.replace(/::?(before|after)\b/gi, ""))
	return index.some((general) => compoundCovers(general, host)) ? ALL_CORNERS : NO_CORNERS
}

function checkRule(rule: CssRule, index: readonly Compound[]): RuleId[] {
	const found = new Set<RuleId>()
	for (const part of selectorParts(rule.selector)) {
		const corners = isExemptSelector(part) ? NO_CORNERS : hostCorners(part, rule, index)
		if (corners.size === 0) continue
		if (parseCompound(part).pseudoElement) {
			if (isPseudoBar(rule.declarations)) found.add("pseudo-bar")
			continue
		}
		if (hasEdgeStripe(rule.declarations, corners)) found.add("edge-stripe")
		if (hasInsetShadowStripe(rule.declarations)) found.add("inset-shadow-stripe")
		const ownRounding = rule.applyClasses.some((c) => c.startsWith("rounded"))
		for (const id of checkClassSet(ownRounding ? rule.applyClasses : ["rounded", ...rule.applyClasses])) found.add(id)
	}
	return [...found]
}

function excerptAt(text: string, offset: number): string {
	const lineStart = text.lastIndexOf("\n", offset - 1) + 1
	const lineEnd = text.indexOf("\n", offset)
	return text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim().slice(0, 140)
}

export function lintFiles(files: readonly SourceFile[]): Finding[] {
	const rulesByFile = new Map(files.map((f) => [f.path, cssRulesOf(f)]))
	const index = radiusIndex([...rulesByFile.values()].flat())
	const findings: Finding[] = []
	for (const file of files) {
		const locate = lineLocator(file.text)
		const seen = new Set<string>()
		const report = (offset: number, rule: RuleId) => {
			const at = locate(offset)
			const key = `${at.line}:${rule}`
			if (seen.has(key)) return
			seen.add(key)
			findings.push({ file: file.path, ...at, rule, excerpt: excerptAt(file.text, offset) })
		}
		for (const rule of rulesByFile.get(file.path) ?? []) {
			for (const id of checkRule(rule, index)) report(rule.offset, id)
		}
		if (STYLESHEET.test(file.path)) continue
		for (const group of classGroups(file.text, SCRIPT.test(file.path))) {
			for (const id of checkClassSet(group.tokens)) report(group.offset, id)
		}
		for (const style of inlineStyles(file.text)) {
			const own = roundedCorners(style.declarations)
			const corners = own.size > 0 ? own : style.tagRounded ? ALL_CORNERS : NO_CORNERS
			if (corners.size === 0) continue
			if (hasEdgeStripe(style.declarations, corners)) report(style.offset, "edge-stripe")
			if (hasInsetShadowStripe(style.declarations)) report(style.offset, "inset-shadow-stripe")
		}
	}
	return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
}
