export type Element = { readonly tag: string; readonly classes: readonly string[] }
export type TextNode = { readonly text: string; readonly offset: number; readonly stack: readonly Element[] }

const HIDDEN_BLOCKS = /<(script|style|pre|code|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->|\{\/\*[\s\S]*?\*\/\}/gi
const TAG = /<(\/?)([A-Za-z][\w.:-]*)((?:[^>"'{}]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*)>/g
const CLASS_ATTR = /\b(?:class|className)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"])

function blank(text: string, pattern: RegExp): string {
	return text.replace(pattern, (m) => m.replace(/[^\n]/g, " "))
}

function classesOf(attrs: string): string[] {
	const m = CLASS_ATTR.exec(attrs)
	return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").split(/\s+/).filter(Boolean)
}

function closeTo(stack: Element[], tag: string): void {
	const at = stack.map((e) => e.tag).lastIndexOf(tag)
	if (at >= 0) stack.length = at
}

/** Visible text between tags, each with the elements open around it. Code outside any element is skipped. */
export function textNodes(source: string): TextNode[] {
	const text = blank(source, HIDDEN_BLOCKS)
	const nodes: TextNode[] = []
	const stack: Element[] = []
	let cursor = 0
	const flush = (end: number) => {
		if (stack.length === 0) return
		const segment = text.slice(cursor, end).replace(/\{[^{}]*\}/g, (m) => " ".repeat(m.length))
		if (segment.trim()) nodes.push({ text: segment, offset: cursor, stack: [...stack] })
	}
	for (const m of text.matchAll(TAG)) {
		const start = m.index ?? 0
		flush(start)
		cursor = start + m[0].length
		const [, closing, rawTag = "", attrs = ""] = m
		const tag = rawTag.toLowerCase()
		if (closing) closeTo(stack, tag)
		else if (!VOID_TAGS.has(tag) && !attrs.trimEnd().endsWith("/")) stack.push({ tag, classes: classesOf(attrs) })
	}
	return nodes
}
