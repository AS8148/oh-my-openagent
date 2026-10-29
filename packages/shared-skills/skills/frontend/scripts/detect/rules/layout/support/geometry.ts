import { ancestors, childrenOf, descendants, fontSizePx, isRendered, px, styleOf } from "../../../core/page"
import { parseColor } from "../../../core/color"
import type { ElementSnapshot, PageSnapshot, Rect } from "../../../types"

export const right = (r: Rect): number => r.x + r.width
export const bottom = (r: Rect): number => r.y + r.height
export const length = (el: ElementSnapshot, prop: string): number => px(styleOf(el, prop)) ?? 0
export const chain = (s: PageSnapshot, el: ElementSnapshot): readonly ElementSnapshot[] => [el, ...ancestors(s, el)]
export const scrollsX = (el: ElementSnapshot): boolean => /^(auto|scroll)$/.test(styleOf(el, "overflow-x"))
export const clipsX = (el: ElementSnapshot): boolean => /^(hidden|clip|auto|scroll)$/.test(styleOf(el, "overflow-x"))
export const clipsY = (el: ElementSnapshot): boolean => /^(hidden|clip|auto|scroll)$/.test(styleOf(el, "overflow-y"))
export const outOfFlow = (el: ElementSnapshot): boolean => /^(absolute|fixed)$/.test(styleOf(el, "position"))
export const hasRole = (el: ElementSnapshot, roles: readonly string[]): boolean =>
	(el.attributes["role"] ?? "").toLowerCase().split(/\s+/).some((r) => roles.includes(r))
export const ident = (el: ElementSnapshot): string => `${el.attributes["class"] ?? ""} ${el.attributes["id"] ?? ""}`.toLowerCase()
export const alpha = (el: ElementSnapshot, prop: string): number => parseColor(styleOf(el, prop))?.a ?? 0
export const borders = (el: ElementSnapshot): readonly boolean[] =>
	["top", "right", "bottom", "left"].map((side) =>
		length(el, `border-${side}-width`) >= 0.5 &&
		!/^(none|hidden)$/.test(styleOf(el, `border-${side}-style`)) &&
		alpha(el, `border-${side}-color`) >= 0.05)
export const screenReaderOnly = (el: ElementSnapshot): boolean =>
	styleOf(el, "clip-path") === "inset(50%)" ||
	(el.rect.width <= 1 && el.rect.height <= 1 && (clipsX(el) || clipsY(el)))

export function painted(s: PageSnapshot, el: ElementSnapshot): boolean {
	if (!isRendered(s, el) || screenReaderOnly(el)) return false
	for (const a of chain(s, el)) {
		if (styleOf(a, "display") === "none" || Number.parseFloat(styleOf(a, "opacity")) <= 0.01) return false
		if (a.tag === "details" && a.attributes["open"] === undefined) {
			const summary = childrenOf(s, a).find((c) => c.tag === "summary")
			if (!summary || !chain(s, el).includes(summary)) return false
		}
		if (a !== el && ((clipsX(a) && (right(el.rect) <= a.rect.x || el.rect.x >= right(a.rect))) ||
			(clipsY(a) && (bottom(el.rect) <= a.rect.y || el.rect.y >= bottom(a.rect))))) return false
	}
	return true
}

export function textLines(s: PageSnapshot, el: ElementSnapshot): readonly Rect[] {
	const nodes = [el, ...descendants(s, el)].filter((n) => n === el || styleOf(n, "display") === "inline")
	const rects = nodes.flatMap((n) => n.lineRects).filter((r) => r.width > 0 && r.height > 0).sort((a, b) => a.y - b.y || a.x - b.x)
	const lines: Rect[] = []
	for (const r of rects) {
		const i = lines.findIndex((l) => Math.min(bottom(l), bottom(r)) - Math.max(l.y, r.y) > Math.min(l.height, r.height) / 2)
		const l = lines[i]
		if (l) lines[i] = { x: Math.min(l.x, r.x), y: Math.min(l.y, r.y), width: Math.max(right(l), right(r)) - Math.min(l.x, r.x), height: Math.max(bottom(l), bottom(r)) - Math.min(l.y, r.y) }
		else lines.push(r)
	}
	return lines
}

export function bounds(rects: readonly Rect[]): Rect | null {
	if (rects.length === 0) return null
	const x = Math.min(...rects.map((r) => r.x))
	const y = Math.min(...rects.map((r) => r.y))
	return { x, y, width: Math.max(...rects.map(right)) - x, height: Math.max(...rects.map(bottom)) - y }
}

export const lineHeight = (el: ElementSnapshot): number => px(styleOf(el, "line-height")) ?? fontSizePx(el) * 1.2
export const intersects = (a: Rect, b: Rect): boolean =>
	Math.min(right(a), right(b)) > Math.max(a.x, b.x) && Math.min(bottom(a), bottom(b)) > Math.max(a.y, b.y)
