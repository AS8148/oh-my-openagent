import type { AgentToolResult, ToolDefinition } from "@code-yeongyu/senpi"
import { appendFile } from "@oh-my-opencode/memory-core/fs"
import { FactsExtractionValidationError, parseFactsExtractionRecord } from "@oh-my-opencode/memory-core"
import { Type, type Static } from "typebox"

export const FACTS_RECORD_TOOL_NAME = "record_fact"

const FactsRecordParams = Type.Object({
  scope: Type.Union([Type.Literal("person"), Type.Literal("project")]),
  person: Type.Optional(Type.Object({
    name: Type.String(),
    aliases: Type.Array(Type.String()),
  }, { additionalProperties: false, description: "Only for scope person. Omit this field for scope project." })),
  text: Type.String(),
  date: Type.String(),
}, { additionalProperties: false })

type FactsRecordParams = Static<typeof FactsRecordParams>
export const factsRecordContract = {
  name: FACTS_RECORD_TOOL_NAME,
  description: "Record one durable fact extracted from the supplied conversation payload.",
  parameters: FactsRecordParams,
}
export type FactsRecordToolResult = AgentToolResult<undefined> & { readonly isError?: boolean }
export type FactsRecordTool = Omit<ToolDefinition<typeof FactsRecordParams, undefined>, "execute" | "renderCall" | "renderResult"> & {
  readonly execute: (toolCallId: string, params: FactsRecordParams) => Promise<FactsRecordToolResult>
  readonly deactivate: () => void
}

type FactsRecordToolInput = {
  readonly extractionPath: string
  readonly maxRecords?: number
  readonly maxBytes?: number
  /** Every call counts, rejected ones too: it bounds the model's tool turns, not only the records kept. */
  readonly maxCalls?: number
  readonly onCall?: () => void
  readonly onFailure?: (reason: string) => void
  readonly state?: { readonly cancelled: boolean }
}

export function createFactsRecordTool(input: FactsRecordToolInput): FactsRecordTool {
  let active = true
  let count = 0
  let bytes = 0
  let calls = 0
  let ended = false
  // A model that resends a call the validator already refused will resend it until the deadline
  // (#10918). The second identical refusal ends the run instead; the facts recorded so far commit.
  const refused = new Set<string>()
  const reject = (reason: string): FactsRecordToolResult => {
    input.onFailure?.(reason)
    return errorResult(reason)
  }
  return {
    ...factsRecordContract,
    label: "Record fact",
    deactivate: () => { active = false },
    execute: async (_toolCallId, params) => {
      if (!active || input.state?.cancelled === true) return errorResult("the facts run is no longer active")
      if (ended) return { ...errorResult("the facts run has ended; stop calling record_fact"), terminate: true }
      if (input.maxCalls !== undefined && calls >= input.maxCalls) {
        return reject(`the facts tool-call limit (${input.maxCalls}) has been reached`)
      }
      calls += 1
      input.onCall?.()
      if (input.maxRecords !== undefined && count >= input.maxRecords) {
        return reject(`the facts run limit (${input.maxRecords}) has been reached`)
      }
      try {
        const record = parseFactsExtractionRecord(params, count)
        const line = `${JSON.stringify(record)}\n`
        const lineBytes = Buffer.byteLength(line, "utf8")
        if (input.maxBytes !== undefined && bytes + lineBytes > input.maxBytes) {
          return reject(`the facts byte limit (${input.maxBytes}) has been reached`)
        }
        // Reserve before the asynchronous append: parallel tool calls share the same budget.
        count += 1
        bytes += lineBytes
        const recordNumber = count
        await appendFile(input.extractionPath, line, "utf8")
        return {
          content: [{ type: "text", text: `Fact recorded (${recordNumber}).` }],
          details: undefined,
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (!(error instanceof FactsExtractionValidationError)) return reject(reason)
        const call = JSON.stringify(params)
        if (!refused.has(call)) {
          refused.add(call)
          return reject(`${reason}. Fix this call or skip this fact; the same call will not be accepted`)
        }
        ended = true
        return { ...reject(`${reason}. This exact call was already refused, so the facts run ends here; facts recorded so far are kept`), terminate: true }
      }
    },
  }
}

function errorResult(reason: string): FactsRecordToolResult {
  return {
    content: [{ type: "text", text: `Fact rejected: ${reason}` }],
    details: undefined,
    isError: true,
  }
}
