import { ancestors, isHeading, isRendered, px, styleOf } from "../../../core/page"
import type { ElementSnapshot, PageSnapshot } from "../../../types"

export const readingTags = ["p", "li", "td", "th", "dd", "blockquote", "figcaption"]
export const lineage = (s: PageSnapshot, e: ElementSnapshot): readonly ElementSnapshot[] => [e, ...ancestors(s, e)]
export const className = (e: ElementSnapshot): string => e.attributes["class"] ?? ""
export const mono = (e: ElementSnapshot): boolean => /mono|courier|consolas|menlo|monaco/i.test(styleOf(e, "font-family"))
export const letters = (text: string): readonly string[] => [...text].filter(c => /\p{L}/u.test(c))
export const cjkChar = (c: string): boolean => /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u31f0-\u31ff\u3400-\u9fff\ua960-\ud7ff\uf900-\ufaff\uff66-\uff9f\u{20000}-\u{3ffff}]/u.test(c)
export const cjk = (text: string): boolean => {
	const sample = [...text].slice(0, 256)
	const count = sample.filter(cjkChar).length
	return count > 0 && count * 2 >= sample.filter(c => /\p{L}/u.test(c)).length
}
export const caps = (text: string): boolean => {
	const chars = letters(text)
	return chars.some(c => c.toUpperCase() !== c.toLowerCase()) && chars.every(c => /\p{Lu}/u.test(c))
}

export function visibleText(s: PageSnapshot, e: ElementSnapshot): boolean {
	return isRendered(s, e) && lineage(s, e).every(n =>
		n.attributes["hidden"] === undefined && styleOf(n, "display") !== "none" &&
		styleOf(n, "visibility") !== "collapse" && styleOf(n, "visibility") !== "hidden" &&
		styleOf(n, "content-visibility") !== "hidden" &&
		Number.parseFloat(styleOf(n, "opacity")) > 0.01 &&
		/sr-only|visually-?hidden|screen-?reader|a11y-hidden|hidden-visually/i.test(className(n)) === false &&
		/^(script|style|title|noscript|template|head|meta|link|base|param|source|track|datalist|col|colgroup|area)$/.test(n.tag) === false &&
		/inset\(\s*(50%|99|100%)/.test(styleOf(n, "clip-path")) === false)
}

export function control(s: PageSnapshot, e: ElementSnapshot): boolean {
	return lineage(s, e).some(n =>
		["button", "summary", "label", "select", "textarea"].includes(n.tag) ||
		(n.tag === "a" && n.attributes["href"] !== undefined) ||
		/^(button|link|tab|menuitem|menuitemcheckbox|menuitemradio|option|checkbox|radio|switch|treeitem)$/.test(n.attributes["role"] ?? "") ||
		(n.attributes["tabindex"] !== undefined && Number(n.attributes["tabindex"]) >= 0 && n.text.length <= 80))
}

export function headingText(s: PageSnapshot, e: ElementSnapshot): boolean {
	for (const n of lineage(s, e)) {
		if (isHeading(n) || n.attributes["role"] === "heading") return true
		if (readingTags.includes(n.tag)) return false
	}
	return false
}

export function pitch(s: PageSnapshot, e: ElementSnapshot): number {
	let height = px(styleOf(e, "line-height")) ?? 0
	if (styleOf(e, "display") === "inline") {
		for (const n of ancestors(s, e)) {
			height = Math.max(height, px(styleOf(n, "line-height")) ?? 0)
			if (["inline", "contents"].includes(styleOf(n, "display")) === false) break
		}
	}
	return height
}

export function finePrintExempt(s: PageSnapshot, e: ElementSnapshot): boolean {
	return lineage(s, e).some(n => /^(legal|footnotes?|endnotes?)$/i.test(n.attributes["role"] ?? "") ||
		/(?:^|[-_\s])(legal|footnotes?|endnotes?)(?:$|[-_\s])/i.test(className(n)) ||
		["doc-footnote", "doc-endnote", "doc-endnotes"].includes(n.attributes["role"] ?? ""))
}

export const smallprint = (s: PageSnapshot, e: ElementSnapshot): boolean => lineage(s, e).some(n =>
	["small", "footer"].includes(n.tag) || /legal|copyright|disclaimer|smallprint|fine-print/i.test(className(n)))

export const codeContext = (s: PageSnapshot, e: ElementSnapshot): boolean => lineage(s, e).some(n =>
	["pre", "code", "kbd", "samp", "var", "svg"].includes(n.tag) ||
	n.attributes["aria-hidden"] === "true" || /terminal|console|code|mock|editor|syntax|diff/i.test(className(n)))

export const uiContext = (s: PageSnapshot, e: ElementSnapshot): boolean => lineage(s, e).some(n =>
	["button", "a", "label", "summary", "pre", "nav", "footer"].includes(n.tag) ||
	n.attributes["aria-hidden"] === "true" ||
	/^(button|link|tab|menuitem|option)$/.test(n.attributes["role"] ?? "") ||
	/badge|caption|chip|code|console|diff|label|meta|mock|pill|preview|tag|terminal|writes/i.test(className(n)))

export const buttonBox = (s: PageSnapshot, e: ElementSnapshot): boolean => lineage(s, e).some(n => /(?:^|[-_\s])(btn|button)(?:$|[-_\s])/i.test(className(n)))
