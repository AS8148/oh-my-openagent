/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"

import {
  customMessage,
  editResult,
  evalRun,
  type FixtureEntry,
  hostBash,
  toolCall,
  toolResult,
} from "./entries.test-support"
import { buildTimeline } from "./evidence"

function checks(entries: readonly FixtureEntry[]): Array<[string, string, number]> {
  return buildTimeline(entries).checks.map((check) => [check.kind, check.outcome, Math.floor(check.at)])
}

describe("claim-receipt evidence timeline", () => {
  describe("#given a check run through an eval host bash call", () => {
    it("#then reads the outcome from ok and the result preview", () => {
      const passed = evalRun("c1", { code: "await tool.bash({ command: 'bun test' })" }, [hostBash("bun test src", " 12 pass\n 0 fail")])
      const failed = evalRun("c2", { code: "await tool.bash({ command: 'tsgo --noEmit' })" }, [hostBash("tsgo --noEmit", "error TS2322: nope", false)])
      expect(checks(passed)).toEqual([["test", "passed", 1]])
      expect(checks(failed)).toEqual([["typecheck", "failed", 1]])
    })
  })

  describe("#given a check command inside eval cell code", () => {
    it("#then a cell can support a claim but never contradicts one, because free-form cell code cannot attribute a failure", () => {
      expect(checks(evalRun("c1", { code: "await sh(`bun test x`)", output: " 35 pass\n 0 fail" }))).toEqual([["test", "passed", 1]])
      expect(checks(evalRun("c2", { code: "await sh(`bun test x`)", output: "boom", status: "error" }))).toEqual([["test", "unknown", 1]])
      expect(checks(evalRun("c5", { code: "await sh(`bun test x`)", output: " 3 pass\n 1 fail" }))).toEqual([["test", "unknown", 1]])
      expect(checks(evalRun("c3", { code: "await sh(`bun test x`)", output: "still going" }))).toEqual([["test", "unknown", 1]])
      expect(checks(evalRun("c4", { code: "await sh(`ls`)", output: "a\nb" }))).toEqual([])
    })

    it("#then a deliberate mutation probe that fails is not a failed check", () => {
      const probe = evalRun("m1", { code: "const mut = orig.replace(a, b)\nawait sh(`bun test x`)", output: " 3 pass\n 1 fail" })
      expect(checks(probe)).toEqual([["test", "unknown", 1]])
    })

    it("#then a detached cell that later fails stays unknown, like any cell failure", () => {
      const entries = [
        ...evalRun("call_8", { code: "await sh(`bun test x`)", output: "", status: "detached" }),
        customMessage("senpi-codemode:notification", "<system-reminder>Detached eval cell call_8 (py) failed.\n 1 fail</system-reminder>"),
      ]
      expect(checks(entries)).toEqual([["test", "unknown", 1], ["test", "unknown", 2]])
    })

    it("#then reads vitest summaries and vp test runs", () => {
      const vitest = evalRun("vt", { code: "await sh(`vp run --filter server test`)", output: " Test Files  3 passed (3)\n      Tests  8 passed (8)" })
      const red = evalRun("vr", { code: "await tool.bash({ command: 'vp test' })" }, [hostBash("vp test x", "      Tests  1 failed | 12 passed (13)")])
      expect(checks(vitest)).toEqual([["test", "passed", 1]])
      expect(checks(red)).toEqual([["test", "failed", 1]])
    })

    it("#then recognises CI status and combined check commands", () => {
      const ci = evalRun("g1", { code: "await tool.bash({ command: 'gh pr checks 12' })" }, [hostBash("gh pr checks 12", "build\tpass\t1m\thttps://x\ntest\tpass\t2m\thttps://y")])
      const pending = evalRun("g2", { code: "await tool.bash({ command: 'gh pr checks 12' })" }, [hostBash("gh pr checks 12", "build\tpass\t1m\thttps://x\ntest\tpending\t0\thttps://y")])
      const vp = evalRun("v1", { code: "await sh(`vp check`)", output: "Found 0 errors and 3 warnings" })
      expect(checks(ci)).toEqual([["test", "passed", 1]])
      expect(checks(pending)).toEqual([["test", "unknown", 1]])
      expect(checks(vp)).toEqual([["typecheck", "passed", 1], ["lint", "passed", 1]])
    })

    it("#then resolves a detached cell from its completion notification", () => {
      const entries = [
        ...evalRun("call_7", { code: "await sh(`bun run typecheck`)", output: "", status: "detached" }),
        customMessage("senpi-codemode:notification", "<system-reminder>Detached eval cell call_7 (js) completed.\nTYPECHECK_EXIT=0</system-reminder>"),
      ]
      expect(checks(entries)).toEqual([["typecheck", "unknown", 1], ["typecheck", "passed", 2]])
    })
  })

  describe("#given a background check that reports through a notification", () => {
    const start = (command: string, id: string) =>
      evalRun("c1", { code: "await tool.bash({ run_in_background: true })" }, [
        hostBash(command, `Command running in background with ID: ${id}`, true, { run_in_background: true }),
      ])

    it("#then the matching terminal notification decides the outcome at its own position", () => {
      const ok = [...start("bun test", "bash_2"), customMessage("senpi-terminal:notification", "<system-reminder>Background terminal session bash_2 finished: completed (exit code 0).</system-reminder>")]
      const bad = [...start("bun test", "bash_2"), customMessage("senpi-terminal:notification", "<system-reminder>Background terminal session bash_2 finished: completed (exit code 1).</system-reminder>")]
      const killed = [...start("bun test", "bash_2"), customMessage("senpi-terminal:notification", "<system-reminder>Background terminal session bash_2 finished: killed (exit code 0).</system-reminder>")]
      const other = [...start("bun test", "bash_2"), customMessage("senpi-terminal:notification", "<system-reminder>Background terminal session bash_9 finished: completed (exit code 0).</system-reminder>")]
      expect(checks(ok)).toEqual([["test", "passed", 2]])
      expect(checks(bad)).toEqual([["test", "failed", 2]])
      expect(checks(killed)).toEqual([])
      expect(checks(other)).toEqual([])
    })

    it("#then a monitor event for that id decides it, including one bundled inside a wake", () => {
      const content = "<system-reminder>Monitor event(run tests): TEST_EXIT=0\nwatcher completed (exit code 0)</system-reminder>"
      const direct = [...start("bun test", "bash_3"), customMessage("senpi-monitor:notification", content, { monitors: [{ id: "bash_3" }] })]
      const wake = [
        ...start("bun test", "bash_3"),
        customMessage("omo-senpi:wake", `prefix\n${content}`, [
          { customType: "senpi-monitor:notification", details: { monitors: [{ id: "bash_3" }] }, contentRange: [7, 7 + content.length] },
        ]),
      ]
      expect(checks(direct)).toEqual([["test", "passed", 2]])
      expect(checks(wake)).toEqual([["test", "passed", 2]])
    })
  })

  describe("#given a check the harness refused before it ran", () => {
    it("#then the refusal is not a failed check", () => {
      const missing = [toolCall("b1", "bash", { command: "bun test" }), toolResult("b1", "bash", { isError: true, text: "Tool bash not found. Run bash inside an eval cell." })]
      const denied = evalRun("b2", { code: "await tool.bash({ command: 'bun test' })" }, [hostBash("bun test", "Permission denied by policy: bash", false)])
      const ran = [toolCall("b3", "bash", { command: "bun test" }), toolResult("b3", "bash", { isError: true, text: " 2 pass\n 1 fail" })]
      expect(checks(missing)).toEqual([["test", "unknown", 1]])
      expect(checks(denied)).toEqual([["test", "unknown", 1]])
      expect(checks(ran)).toEqual([["test", "failed", 1]])
    })
  })

  describe("#given a managed lsp diagnostics result", () => {
    it("#then a clean report is a passed lsp check", () => {
      const entries = [toolCall("l1", "lsp_diagnostics", { filePath: "src" }), toolResult("l1", "lsp_diagnostics", { text: "Files scanned: 6\nFiles with errors: 0\nTotal diagnostics: 0" })]
      expect(checks(entries)).toEqual([["lsp", "passed", 1]])
    })
  })

  describe("#given file edits", () => {
    it("#then marks code edits relevant and notes or evidence edits not relevant", () => {
      const timeline = buildTimeline([...editResult("e1", "src/a.ts"), ...editResult("e2", ".omo/evidence/run/summary.md")])
      expect(timeline.edits.map((edit) => [edit.paths, edit.relevant])).toEqual([
        [["src/a.ts"], true],
        [[".omo/evidence/run/summary.md"], false],
      ])
    })

    it("#then writes and git commands inside eval cells are not edits, because cells write scratch files and compose text", () => {
      const edits = (code: string) => buildTimeline(evalRun("w", { code, output: " 3 pass\n 0 fail" })).edits
      expect(edits("await Bun.write(`${W}/zzScratch.test.ts`, s)\nawait sh(`bun test`)")).toEqual([])
      expect(edits("open(p, 'w').write(brief)")).toEqual([])
      expect(edits("await sh(`git merge-tree --write-tree HEAD origin/dev`)")).toEqual([])
    })
  })
})
