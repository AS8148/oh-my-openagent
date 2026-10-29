import { ancestors, isIgnored } from "../../../core/page"
import type { PageHit } from "../../../rule"
import type { ElementSnapshot, PageSnapshot } from "../../../types"

export type ContrastHit = PageHit & { readonly element: ElementSnapshot; readonly pair: string }

export function distinctPairs(snapshot: PageSnapshot, hits: readonly ContrastHit[]): readonly PageHit[] {
	const groups = new Map<string, ContrastHit[]>()
	for (const hit of hits) {
		if (isIgnored(snapshot, hit.element, "low-contrast")) continue
		const vendor = [hit.element, ...ancestors(snapshot, hit.element)].find((node) =>
			/taboola|outbrain|disqus|carbonads/i.test(`${node.attributes["id"] ?? ""} ${node.attributes["class"] ?? ""}`))
		const key = `${hit.pair}|${vendor?.index ?? "page"}`
		const group = groups.get(key) ?? []
		group.push(hit)
		groups.set(key, group)
	}
	return [...groups.values()].flatMap((group) => {
		const owner = group.find((hit) => [...hit.element.ownText.trim()].length > 1) ?? group[0]
		if (!owner) return []
		return [{
			element: owner.element,
			message: `${owner.message}${group.length > 1 ? ` (and ${group.length - 1} more)` : ""}`,
			snippet: owner.snippet,
		}]
	})
}
