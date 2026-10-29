import { ancestors, styleOf } from "../../../core/page"
import { cssBlocks } from "../../../core/source"
import type { ElementSnapshot, PageSnapshot } from "../../../types"
import { opacity } from "./gradients"

function opacityFrames(snapshot: PageSnapshot, name: string): readonly { readonly at: number; readonly opacity: number }[] {
	const frames: { at: number; opacity: number }[] = []
	for (const css of snapshot.cssText) {
		const marker = new RegExp(`@(?:-webkit-)?keyframes\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`).exec(css)
		if (!marker || marker.index === undefined) continue
		const open = marker.index + marker[0].length - 1
		let depth = 1
		let end = open + 1
		for (; end < css.length && depth > 0; end++) {
			if (css[end] === "{") depth++
			if (css[end] === "}") depth--
		}
		for (const block of cssBlocks(css.slice(open + 1, end - 1))) {
			const value = /(?:^|;)\s*opacity\s*:\s*([\d.]+)/.exec(block.body)
			if (!value) continue
			for (const selector of block.selector.split(",")) {
				const at = selector.trim() === "to" ? 100 : selector.trim() === "from" ? 0 : Number.parseFloat(selector)
				if (Number.isFinite(at)) frames.push({ at, opacity: Number(value[1]) })
			}
		}
	}
	return frames.sort((a, b) => a.at - b.at)
}

function settled(snapshot: PageSnapshot, node: ElementSnapshot): number {
	let value = opacity(node)
	const names = styleOf(node, "animation-name").split(",").map((n) => n.trim())
	const counts = styleOf(node, "animation-iteration-count").split(",").map((n) => n.trim())
	for (let i = 0; i < names.length; i++) {
		const name = names[i]
		if (!name || name === "none") continue
		const frames = opacityFrames(snapshot, name)
		const final = frames.at(-1)
		const infinite = counts[i % counts.length] === "infinite"
		if (infinite && final?.at === 100 && final.opacity <= 0.02) return 0
		if (!infinite && final?.at === 100 && styleOf(node, "animation-play-state") !== "paused") value = final.opacity
	}
	return value
}

export function textOpacity(snapshot: PageSnapshot, el: ElementSnapshot): number {
	return [el, ...ancestors(snapshot, el)].reduce((value, node) => value * settled(snapshot, node), 1)
}
