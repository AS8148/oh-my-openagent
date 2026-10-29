import type { PageRule } from "../../rule"
import { shortSnippet, styleOf } from "../../core/page"
import { visible } from "./support/appearance"
export const repeatingStripesGradient: PageRule = {
 meta: { id: "repeating-stripes-gradient", name: "Repeating-gradient stripes", category: "slop", severity: "advisory", engine: "page", description: "Repeating gradient bands decorate a surface without adding structure.", fixHint: "Use a deliberate texture or keep the surface plain." },
 check: ({snapshot}) => snapshot.elements.flatMap(e=>visible(snapshot,e) && [e.style,e.before?.style,e.after?.style].some(s=>/repeating-(?:linear|radial)-gradient\(/i.test(s?.["background-image"] ?? "")) ? [{element:e,message:"Repeating gradient surface stripes",snippet:shortSnippet(e)}]:[]),
}
