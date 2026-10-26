import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { clearSessionAgent, setSessionAgent } from "../../features/claude-code-session-state"
import { createPrometheusMdOnlyHook } from "./hook"
import { parsePatch } from "./fixtures/opencode-patch-parser"

const sessionID = "ses_prometheus_patch_lines"
const source = ".omo/plans/source.md"
const allowed = ".omo/plans/allowed.md"
const outside = "src/outside.ts"
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n")
const hook = createPrometheusMdOnlyHook({ directory: "/tmp/test", client: {} } as never)
const input = { tool: "apply_patch", sessionID, callID: "patch-lines" }

const operations = [
  { name: "Add", lines: (path: string) => [`*** Add File:${path}`, "+after"] },
  { name: "Update", lines: (path: string) => [`*** Update File:${path}`, "@@", "-before", "+after"] },
  { name: "Delete", lines: (path: string) => [`*** Delete File:${path}`] },
  {
    name: "Move to",
    lines: (path: string) => [`*** Update File:${source}`, `*** Move to:${path}`, "@@", "-before", "+after"],
  },
]
const terminators = [
  { name: "CR plus space", value: "\r " },
  { name: "U+2028", value: "\u2028" },
  { name: "U+2029", value: "\u2029" },
]

beforeEach(() => setSessionAgent(sessionID, "prometheus"))
afterEach(() => clearSessionAgent(sessionID))

describe("apply_patch executor / guard differential (omo#11367 B1)", () => {
  for (const operation of operations) {
    for (const terminator of terminators) {
      for (const mixed of [false, true]) {
        test(`${operation.name} outside with ${terminator.name}, mixed=${mixed}, is blocked`, async () => {
          // The independent executor parser must see the outside hunk before guard rejection counts.
          const patchText = patch(
            ...(mixed ? [`*** Add File:${allowed}`, "+# Plan"] : []),
            ...operation.lines(outside + terminator.value),
          )
          const hunks = parsePatch(patchText).hunks
          expect(hunks).toHaveLength(mixed ? 2 : 1)
          const target = hunks.at(-1)!
          if (operation.name === "Move to") {
            expect(target).toMatchObject({ type: "update", path: source, move_path: outside })
          } else {
            expect(target).toMatchObject({ type: operation.name.toLowerCase(), path: outside })
          }

          await expect(hook["tool.execute.before"](input, { args: { patchText } })).rejects.toThrow(
            "File operations restricted to .omo/*.md plan files only",
          )
        })
      }

      test(`${operation.name} allowed with ${terminator.name} remains allowed`, async () => {
        const patchText = patch(...operation.lines(allowed + terminator.value))
        const { hunks } = parsePatch(patchText)
        expect(hunks).toHaveLength(1)
        expect(hunks[0]).toMatchObject(
          operation.name === "Move to"
            ? { type: "update", path: source, move_path: allowed }
            : { type: operation.name.toLowerCase(), path: allowed },
        )

        await expect(hook["tool.execute.before"](input, { args: { patchText } })).resolves.toBeUndefined()
      })
    }
  }

  for (const header of [
    "*** Add File:",
    "*** Update File:\u2028",
    "*** Delete File:\r ",
    "*** Move to:\u2029",
    "*** Rename File:src/outside.ts",
  ]) {
    test(`unclassifiable or empty header ${JSON.stringify(header)} fails closed in a mixed patch`, async () => {
      const patchText = patch(`*** Add File:${allowed}`, "+# Plan", header)

      await expect(hook["tool.execute.before"](input, { args: { patchText } })).rejects.toThrow(
        "File operations restricted to .omo/*.md plan files only",
      )
    })
  }
})
