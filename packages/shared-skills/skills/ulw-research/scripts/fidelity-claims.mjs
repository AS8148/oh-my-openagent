// fidelity-claims.mjs - the claim-kind checks of the deterministic fidelity gate.
//
// A claim kind is read from the data-claim-kind attribute on a data-fact element or on any
// ancestor (so a writer may mark one value or a whole sentence element). Every marked element must
// cite at least one fact, and every fact under a mark must be a row the kind accepts
// (claim-kinds.mjs CLAIM_KINDS); otherwise the kind's defect (unsupported_verification for
// `verified`). A sentence that carries no mark of a kind but matches that kind's short unmarked
// phrase list gets the kind's minor warning (verification_claim_unmarked), never a major. No
// model, no network.

import { CLAIM_ATTRIBUTE, CLAIM_KINDS, claimSatisfied, unmarkedKinds } from "./claim-kinds.mjs"
import { proseSentences } from "./fidelity-binding.mjs"
import { clip } from "./fidelity-trace.mjs"
import { proseText } from "./html-lite.mjs"

const marked = (node) => node.attrs[CLAIM_ATTRIBUTE] !== undefined

function markOf(ctx, node) {
	const owner = marked(node) ? node : ctx.util.closest(node, marked)
	return owner ? owner.attrs[CLAIM_ATTRIBUTE].trim() : null
}

/**
 * @param {object} ctx buildContext(...) from gates-static.mjs
 * @param {Map<string, object>} rows ledger rows by fact_id
 * @param {(sourceId: string | null) => string | undefined} sourceKindOf meta.json kind of a source snapshot
 * @param {(code: string, node: object, message: string) => void} flag
 */
export function claimChecks(ctx, rows, sourceKindOf, flag) {
	for (const node of ctx.all.filter(marked)) {
		const name = node.attrs[CLAIM_ATTRIBUTE].trim()
		const entry = CLAIM_KINDS[name]
		if (!entry) {
			flag("claim_kind_mismatch", node, `${CLAIM_ATTRIBUTE}="${name}" is not a claim kind (${Object.keys(CLAIM_KINDS).join(", ")})`)
			continue
		}
		const cited = [node, ...ctx.util.descendants(node)].filter((cur) => cur.attrs["data-fact"] !== undefined)
		const facts = cited.filter((cur) => markOf(ctx, cur) === name)
		if (cited.length === 0) flag(entry.defect, node, `"${clip(proseText(node))}" is marked ${name} but cites no fact`)
		for (const fact of facts) {
			const row = rows.get(fact.attrs["data-fact"])
			if (!row || claimSatisfied(name, row, sourceKindOf(row.source_id))) continue
			const source = entry.sourceKinds ? ` from a ${entry.sourceKinds.join(" or ")} snapshot` : ""
			flag(entry.defect, fact, `${row.fact_id} is marked ${name}, but it is a ${row.kind} row${source ? ` and not one${source}` : ""}`)
		}
	}
	for (const block of proseSentences(ctx)) {
		if (block.kind === "sources" || block.kind === "toc") continue
		for (const sentence of block.sentences) {
			for (const name of unmarkedKinds(sentence.text)) {
				if (markOf(ctx, block.owner) === name || sentence.facts.some((fact) => markOf(ctx, fact.node) === name)) continue
				flag(CLAIM_KINDS[name].unmarked.code, block.owner, `"${clip(sentence.text)}" reads as a ${name} claim but carries no ${CLAIM_ATTRIBUTE}="${name}" mark`)
			}
		}
	}
}
