import { describe, expect, test } from "bun:test"
import { FABLE_55_LAUNCH, FABLE_55_RELEASED } from "./fable-55-launch"
import type { ModelCapabilitiesSnapshotEntry } from "./model-capabilities/types"

// Names every launch value still at its placeholder (undefined), including any field added later.
function unfilledLaunchValues(entry: ModelCapabilitiesSnapshotEntry): string[] {
  const required: Record<string, unknown> = {
    reasoning: entry.reasoning,
    temperature: entry.temperature,
    toolCall: entry.toolCall,
    "modalities.input": entry.modalities?.input,
    "modalities.output": entry.modalities?.output,
    "limit.context": entry.limit?.context,
    "limit.input": entry.limit?.input,
    "limit.output": entry.limit?.output,
  }
  const declared: Record<string, unknown> = { ...entry }
  for (const [key, value] of Object.entries(entry.limit ?? {})) declared[`limit.${key}`] = value
  for (const [key, value] of Object.entries(entry.modalities ?? {})) declared[`modalities.${key}`] = value
  const unfilled = Object.entries({ ...declared, ...required }).filter(([, value]) => value === undefined)
  return unfilled.map(([key]) => key).sort()
}

describe("Fable 5.5 launch values", () => {
  test("a release leaves no launch value at its placeholder", () => {
    // given / when
    const unfilled = FABLE_55_RELEASED ? unfilledLaunchValues(FABLE_55_LAUNCH) : []
    // then
    expect(unfilled).toEqual([])
  })

  test("the placeholder check names every unfilled value and passes a filled entry", () => {
    // given
    const filled: ModelCapabilitiesSnapshotEntry = {
      id: "fixture",
      family: "claude-fable",
      reasoning: true,
      temperature: true,
      toolCall: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 1, input: 1, output: 1 },
    }
    // when / then
    expect(unfilledLaunchValues(filled)).toEqual([])
    expect(unfilledLaunchValues({ id: "fixture" })).toEqual([
      "limit.context",
      "limit.input",
      "limit.output",
      "modalities.input",
      "modalities.output",
      "reasoning",
      "temperature",
      "toolCall",
    ])
    expect(unfilledLaunchValues({ ...filled, family: undefined })).toEqual(["family"])
  })
})
