import { parse, stringify } from "yaml"

import { renderEntry, type FmEntry, type FmValue } from "../item/frontmatter"
import { mergeInsertions } from "./merge"

/** Every input value is either merged into its key or returned as a marked body line. */
export function adoptFrontmatter(fm: Map<string, FmValue>, entries: readonly FmEntry[]): string[] {
  const conflicts: string[] = []
  for (const { key, value } of entries) {
    if (value.kind === "remove") continue
    const current = fm.get(key)
    if (current === undefined || current.kind === "remove") {
      fm.set(key, value)
    } else if (current.kind === "text" && value.kind === "text") {
      fm.set(key, { kind: "text", text: mergeInsertions(current.text, value.text) })
    } else if (current.kind === "set" && value.kind === "set") {
      const elements = [...new Set([...current.elements, ...value.elements])]
      fm.set(key, { kind: "set", elements, flow: flowSet(elements) })
    } else if (!(current.kind === "reg" && value.kind === "reg" && current.value === value.value)) {
      // One line is one merge token: conflicts cannot be interleaved into invalid YAML.
      const flow = value.kind === "reg" ? `{${JSON.stringify(key)}: ${value.value}}` : stringify({ [key]: naturalValue(value) }, {
        collectionStyle: "flow",
        defaultStringType: "QUOTE_DOUBLE",
        defaultKeyType: "QUOTE_DOUBLE",
        lineWidth: 0,
      }).trim()
      const payload = flow.replace(/>/g, "\\u003e")
      conflicts.push(`<!-- memory-sync frontmatter conflict: ${payload} -->\n`)
    }
  }
  return conflicts
}

function naturalValue(value: FmValue): unknown {
  switch (value.kind) {
    case "text": return value.text
    case "set": return value.elements.map((element) => parse(element))
    case "reg": return parse(value.value)
    case "remove": return null
  }
}

function flowSet(elements: readonly string[]): string {
  return stringify(elements.map((element) => parse(element)), { collectionStyle: "flow", lineWidth: 0 }).trim()
}

export function renderAssembled(entries: readonly FmEntry[], body: string): string {
  const lines: string[] = []
  for (const { key, value } of entries) {
    switch (value.kind) {
      case "remove": break
      case "set":
        lines.push(renderEntry(key, value.elements))
        break
      case "text":
        lines.push(renderEntry(key, value.text))
        break
      case "reg":
        lines.push(renderEntry(key, value.value, true))
        break
    }
  }
  return lines.length === 0 ? body : `---\n${lines.join("\n")}\n---\n${body}`
}
