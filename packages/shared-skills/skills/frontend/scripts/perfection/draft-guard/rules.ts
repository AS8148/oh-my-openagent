import type { DraftRuleId } from "./findings"
import type { Element, TextNode } from "./text-nodes"

export type RuleHit = { readonly rule: DraftRuleId; readonly offset: number }

const PROMO_PHRASES = new RegExp(
	[
		String.raw`\bseamless(?:ly)?\b`,
		String.raw`\beffortless(?:ly)?\b`,
		String.raw`\bsupercharge[sd]?\b`,
		String.raw`\bunlock (?:the|your)\b`,
		String.raw`\bat a glance\b`,
		String.raw`\bcutting[- ]edge\b`,
		String.raw`\bgame[- ]chang(?:er|ing)\b`,
		String.raw`\brevolutioni[sz]e\b`,
		String.raw`\bnext[- ]level\b`,
		String.raw`\bworld[- ]class\b`,
		String.raw`\belevate your\b`,
		"한눈에",
		"손쉽게",
		"간편하게",
		"스마트한",
		"혁신적인",
		"최적의",
		"효율적으로",
	].join("|"),
	"giu",
)

const PICTOGRAPH = /(?![©®™‼⁉])\p{Extended_Pictographic}/u
const BADGE_CLASS = /^(?:badge|chip|pill|tag)(?:$|[-_])/
const HYPE_LABEL = /^(?:new!?|hot|trending|popular|featured|ai|ai[- ]powered|pro|premium|recommended|best|신규|인기|추천|베스트)$/i
const STAT_CLASS = /^(?:stat|stats|metric|metrics|kpi)(?:$|[-_])/
const VANITY_NUMBER = /^(?:\d+(?:[.,]\d+)?\s*(?:%|x|×|k|m|b)\+?|\d+(?:[.,]\d+)?\+|24\/7)$/i

const hasClass = (element: Element | undefined, pattern: RegExp): boolean => element?.classes.some((c) => pattern.test(c)) ?? false

function leadingOffset(node: TextNode): number {
	return node.offset + (node.text.length - node.text.trimStart().length)
}

export function checkNode(node: TextNode): RuleHit[] {
	const hits: RuleHit[] = []
	const label = node.text.trim()
	for (const m of node.text.matchAll(PROMO_PHRASES)) hits.push({ rule: "promo-copy", offset: node.offset + (m.index ?? 0) })
	const pictograph = PICTOGRAPH.exec(node.text)
	if (pictograph) hits.push({ rule: "emoji-icon", offset: node.offset + pictograph.index })
	if (hasClass(node.stack.at(-1), BADGE_CLASS) && HYPE_LABEL.test(label)) hits.push({ rule: "decorative-badge", offset: leadingOffset(node) })
	if (node.stack.some((e) => hasClass(e, STAT_CLASS)) && VANITY_NUMBER.test(label)) hits.push({ rule: "vanity-stat", offset: leadingOffset(node) })
	return hits
}
