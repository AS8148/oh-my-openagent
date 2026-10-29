import { ancestors, isRendered, px, styleOf } from "../../../core/page"
import { blend, parseColor, type Rgba } from "../../../core/color"
import type { ElementSnapshot, PageSnapshot } from "../../../types"

export const sides = ["top", "right", "bottom", "left"] as const
export const corners = ["top-left", "top-right", "bottom-right", "bottom-left"] as const
export const borderSafe = new Set(["blockquote", "nav", "a", "input", "textarea", "select", "pre", "code", "span", "th", "td", "tr", "li", "button", "hr", "html", "head", "body", "script", "style", "link", "meta", "title", "br", "img", "svg", "path", "circle", "rect", "line", "polyline", "polygon", "g", "defs", "use"])
export const length = (value: string): number => px(value) ?? (value.trim() === "0" ? 0 : Number.NaN)
export const chroma = (value: string, floor = 30): boolean => {
 const c = parseColor(value)
 return c !== null && c.a >= 0.1 && Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) >= floor
}
export const radius = (el: ElementSnapshot, corner: string): number => {
 const parts = styleOf(el, "border-" + corner + "-radius").split(/\s+/)
 const values = parts.map(v => v.endsWith("%") ? Number.parseFloat(v) * Math.min(el.rect.width, el.rect.height) / 100 : length(v))
 return Math.min(...values)
}
export const radii = (el: ElementSnapshot): readonly number[] => corners.map(c => radius(el, c))
export const roundedAway = (el: ElementSnapshot, side: number): boolean => {
 const far = [[2, 3], [0, 3], [0, 1], [1, 2]][side] ?? []
 const values = radii(el)
 return far.every(i => (values[i] ?? 0) >= 4)
}
export const visible = (s: PageSnapshot, e: ElementSnapshot): boolean => isRendered(s,e) && [e,...ancestors(s,e)].every(a => styleOf(a,"display") !== "none" && styleOf(a,"visibility") !== "hidden" && a.attributes["hidden"] === undefined)
export const context = (s: PageSnapshot, e: ElementSnapshot, predicate: (e: ElementSnapshot) => boolean): boolean => [e,...ancestors(s,e)].some(predicate)
export const selected = (e: ElementSnapshot): boolean => e.attributes["aria-selected"] === "true" || (e.attributes["aria-current"] !== undefined && e.attributes["aria-current"] !== "false") || /^(selected|active|checked|current)$/i.test(e.attributes["data-state"] ?? e.attributes["data-status"] ?? "") || /(?:^|[\s_-])(?:selected|current|checked)(?:$|[\s_-])/.test(e.attributes["class"] ?? "")
export const showsOver = (paint: Rgba, surface: Rgba): boolean => {
 const over = blend(paint, surface)
 return Math.max(Math.abs(over.r-surface.r), Math.abs(over.g-surface.g), Math.abs(over.b-surface.b)) >= 8
}
export function splitTop(value: string, separator: RegExp = /,/): string[] {
 let depth=0, start=0
 const parts: string[]=[]
 for(let i=0;i<value.length;i++) {
  const c=value[i] ?? ""
  if(c === "(") depth++
  else if(c === ")") depth--
  else if(depth === 0 && separator.test(c)) { parts.push(value.slice(start,i).trim()); start=i+1 }
 }
 parts.push(value.slice(start).trim())
 return parts.filter(Boolean)
}
