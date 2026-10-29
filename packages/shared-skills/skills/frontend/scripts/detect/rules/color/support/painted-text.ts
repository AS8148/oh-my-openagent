import { ancestors, childrenOf, isRendered, px, styleOf } from "../../../core/page"
import type { ComputedStyle, ElementSnapshot, PageSnapshot, Rect } from "../../../types"
import { effectiveOpacity, gradientStops, opacity } from "./gradients"
import { textOpacity } from "./animation-opacity"

export function contains(outer: Rect, inner: Rect): boolean {
	return inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1
}

export function textRect(el: ElementSnapshot): Rect {
	if (el.lineRects.length === 0) return el.rect
	const x = Math.min(...el.lineRects.map((r) => r.x))
	const y = Math.min(...el.lineRects.map((r) => r.y))
	return {
		x, y,
		width: Math.max(...el.lineRects.map((r) => r.x + r.width)) - x,
		height: Math.max(...el.lineRects.map((r) => r.y + r.height)) - y,
	}
}

const zIndex = (el: ElementSnapshot): number => Number.parseFloat(styleOf(el, "z-index")) || 0

export function coveredBySibling(snapshot: PageSnapshot, el: ElementSnapshot): boolean {
	const rect = textRect(el)
	for (const node of [el, ...ancestors(snapshot, el)]) {
		const parent = node.parent === null ? undefined : snapshot.elements[node.parent]
		if (!parent) continue
		for (const sibling of childrenOf(snapshot, parent)) {
			if (sibling === node || !isRendered(snapshot, sibling) || effectiveOpacity(snapshot, sibling) < 0.99 || !contains(sibling.rect, rect)) continue
			if (!["absolute", "fixed"].includes(styleOf(sibling, "position")) && styleOf(sibling, "z-index") === "auto") continue
			if (zIndex(sibling) < zIndex(node) || (zIndex(sibling) === zIndex(node) && sibling.index < node.index)) continue
			const bg = sibling.style["background-color"] ?? ""
			const alpha = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(bg)
			const solid = bg.startsWith("rgb(") || bg.startsWith("#") || (alpha !== null && Number(alpha[1]) >= 0.99)
			if (solid || ["img", "video", "canvas"].includes(sibling.tag)) return true
		}
	}
	return false
}

function maskHides(node: ElementSnapshot, rect: Rect): boolean {
	const mask = styleOf(node, "mask-image") || styleOf(node, "-webkit-mask-image")
	if (!mask.includes("linear-gradient")) return false
	const stops = gradientStops(mask)
	const last = stops.at(-1)
	if (!last || last.color.a > 0.02) return false
	const terminal = /([\d.]+)(px|%)(?:\s*\))?$/.exec(last.raw)
	if (!terminal) return false
	const edge = Number(terminal[1]) * (terminal[2] === "%" ? node.rect.height / 100 : 1)
	return rect.y >= node.rect.y + edge
}

export function textPainted(snapshot: PageSnapshot, el: ElementSnapshot): boolean {
	if (el.rect.width <= 0 || el.rect.height <= 0 || textOpacity(snapshot, el) <= 0.02) return false
	const rect = textRect(el)
	for (const node of [el, ...ancestors(snapshot, el)]) {
		if (["hidden", "collapse"].includes(styleOf(node, "visibility")) || styleOf(node, "display") === "none") return false
		if (node.rect.width <= 1 && node.rect.height <= 1 && styleOf(node, "overflow-x") === "hidden") return false
		const r = node.rect
		if (["hidden", "clip"].includes(styleOf(node, "overflow-x")) && (rect.x >= r.x + r.width || rect.x + rect.width <= r.x)) return false
		if (["hidden", "clip"].includes(styleOf(node, "overflow-y")) && (rect.y >= r.y + r.height || rect.y + rect.height <= r.y)) return false
		if (maskHides(node, rect)) return false
	}
	return !coveredBySibling(snapshot, el)
}

export function pseudoCovers(style: ComputedStyle, host: ElementSnapshot, rect: Rect): boolean {
	if (style["display"] === "none" || ["hidden", "collapse"].includes(style["visibility"] ?? "") || Number.parseFloat(style["opacity"] ?? "1") < 0.9) return false
	if (style["content"] === "none" || style["content"] === "normal") return false
	const length = (value: string | undefined, size: number, fallback: number): number => value?.endsWith("%") ? Number.parseFloat(value) * size / 100 : px(value) ?? fallback
	const width = length(style["width"], host.rect.width, host.rect.width)
	const height = length(style["height"], host.rect.height, host.rect.height)
	let x = host.rect.x + length(style["left"], host.rect.width, 0)
	let y = host.rect.y + length(style["top"], host.rect.height, 0)
	const matrix = /^matrix\(([^)]+)\)/.exec(style["transform"] ?? "")
	if (matrix) {
		const [a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0] = (matrix[1] ?? "").split(",").map(Number)
		if (Math.abs(a) < 0.01 || Math.abs(d) < 0.01) return false
		x += tx
		y += ty
		if (b !== 0 && c === 0) {
			const conservativeEdge = y + height + Math.min(0, b * width)
			if (rect.y + rect.height > conservativeEdge) return false
		}
	}
	if (style["scale"]?.startsWith("0")) return false
	return contains({ x, y, width, height }, rect)
}

export function siblingGrounds(snapshot: PageSnapshot, node: ElementSnapshot, rect: Rect): readonly ElementSnapshot[] {
	const parent = node.parent === null ? undefined : snapshot.elements[node.parent]
	if (!parent) return []
	return childrenOf(snapshot, parent).filter((sib) =>
		sib !== node && sib.index < node.index && zIndex(sib) <= zIndex(node) && isRendered(snapshot, sib) && opacity(sib) > 0 && contains(sib.rect, rect),
	).sort((a, b) => zIndex(b) - zIndex(a) || b.index - a.index)
}
