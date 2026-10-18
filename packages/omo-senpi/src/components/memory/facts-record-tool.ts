import type { AgentToolResult, ToolDefinition } from "@code-yeongyu/senpi"
import { appendFile } from "@oh-my-opencode/memory-core/fs"
import { parseFactsExtractionRecord, resolveClaimReceipt, type FactsPayload } from "@oh-my-opencode/memory-core"
import { Type, type Static } from "typebox"

export const FACTS_RECORD_TOOL_NAME = "record_fact"

const FactsRecordParams = Type.Object({
  scope: Type.Union([Type.Literal("person"), Type.Literal("project")]),
  person: Type.Optional(Type.Object({
    name: Type.String(),
    aliases: Type.Array(Type.String()),
  }, { additionalProperties: false })),
  text: Type.String(),
  date: Type.String(),
  source: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("agent"), Type.Literal("inferred")], {
    description: "Who the fact came from: user (the user said it), agent (an assistant suggestion or statement), inferred (a conclusion drawn from the conversation). Omitted means inferred.",
  })),
  user_quote: Type.Optional(Type.String({
    description: "Required when source is user: the user's own words, copied verbatim from a user message. Without a matching quote the fact is stored as an agent suggestion.",
  })),
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
  /** Every user-authored message in the payload; a `user` claim must quote one of them verbatim. */
  readonly userTexts: readonly string[]
  readonly maxRecords?: number
  readonly maxBytes?: number
  readonly onFailure?: (reason: string) => void
  readonly state?: { readonly cancelled: boolean }
}

export function createFactsRecordTool(input: FactsRecordToolInput): FactsRecordTool {
  let active = true
  let count = 0
  let bytes = 0
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
      if (input.maxRecords !== undefined && count >= input.maxRecords) {
        return reject(`the facts run limit (${input.maxRecords}) has been reached`)
      }
      try {
        const { source, user_quote: userQuote, ...fact } = params
        const receipt = resolveClaimReceipt({ source, userQuote }, input.userTexts)
        const record = parseFactsExtractionRecord({ ...fact, receipt }, count)
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
        return reject(error instanceof Error ? error.message : String(error))
      }
    },
  }
}

export function payloadUserTexts(payload: FactsPayload): string[] {
  return payload.entries.flatMap((entry) => entry.entries.flatMap((item) => item.kind === "user" ? [item.text] : []))
}

function errorResult(reason: string): FactsRecordToolResult {
  return {
    content: [{ type: "text", text: `Fact rejected: ${reason}` }],
    details: undefined,
    isError: true,
  }
}
