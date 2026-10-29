import type { PageRule } from "../../rule"
import { borderHits, stripeHit } from "./support/borders"
export const sideTab: PageRule = {
 meta: { id: "side-tab", name: "Side-tab accent border", category: "slop", severity: "warning", engine: "page", description: "A colored edge turns a card into a decorative side tab.", fixHint: "Remove the stripe and use spacing or a restrained surface change." },
 check: ({snapshot}) => snapshot.elements.flatMap(e=>[...borderHits(snapshot,e,"side-tab"),...stripeHit(snapshot,e)]),
}
