export const TRANSCRIPT_MESSAGE_LIMIT = 50
const TOOL_RESULT_KEEP = 1200

const SECRET_KEY = /(api[-_]?key|token|secret|password|passwd|authorization|cookie|credential|private[-_]?key|client[-_]?secret)/i
const SECRET_CONTAINERS = new Set(["headers", "env"])

const blankUserinfo = (value: string): string => value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/i, "$1<redacted>@")

/**
 * Structural pass before text redaction: values under secret-named keys, and every value inside `headers` and `env`
 * maps, are blanked regardless of what they look like, because a custom header or env value has no shape a pattern
 * can recognize. URL userinfo is blanked too.
 */
export function blankConfigSecrets(value: unknown, insideSecretContainer = false): unknown {
  if (Array.isArray(value)) return value.map((item) => blankConfigSecrets(item, insideSecretContainer))
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (insideSecretContainer || SECRET_KEY.test(key)) {
        out[key] = child !== null && typeof child === "object" ? blankConfigSecrets(child, true) : "<redacted>"
        continue
      }
      out[key] = blankConfigSecrets(child, SECRET_CONTAINERS.has(key.toLowerCase()))
    }
    return out
  }
  if (insideSecretContainer) return "<redacted>"
  return typeof value === "string" ? blankUserinfo(value) : value
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: unknown) => {
      const type: unknown = Reflect.get(Object(part), "type")
      if (type === "text") return String(Reflect.get(Object(part), "text") ?? "")
      if (type === "toolCall") {
        const name = String(Reflect.get(Object(part), "name") ?? "tool")
        return `[${name}] ${JSON.stringify(Reflect.get(Object(part), "arguments") ?? {})}`
      }
      if (type === "image") return "[image]"
      return ""
    })
    .filter((piece) => piece !== "")
    .join(" ")
}

const shorten = (text: string): string => {
  if (text.length <= TOOL_RESULT_KEEP * 2) return text
  const cut = text.length - TOOL_RESULT_KEEP * 2
  return `${text.slice(0, TOOL_RESULT_KEEP)} [${cut} characters cut] ${text.slice(-TOOL_RESULT_KEEP)}`
}

const clock = (timestamp: unknown): string => {
  const parsed = typeof timestamp === "string" || typeof timestamp === "number" ? new Date(timestamp) : null
  return parsed === null || Number.isNaN(parsed.getTime()) ? "" : ` (${parsed.toISOString().slice(11, 19)})`
}

/** The reported session's last messages as plain lines; custom extension entries (memory, notes) never appear. */
export function transcriptText(entries: readonly unknown[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    if (Reflect.get(Object(entry), "type") !== "message") continue
    const message: unknown = Reflect.get(Object(entry), "message")
    const role = String(Reflect.get(Object(message), "role") ?? "unknown")
    const body = textOf(Reflect.get(Object(message), "content")).replace(/\s+/g, " ").trim()
    lines.push(`${role}${clock(Reflect.get(Object(entry), "timestamp"))}: ${shorten(body)}`)
  }
  return lines.slice(-TRANSCRIPT_MESSAGE_LIMIT).join("\n")
}
