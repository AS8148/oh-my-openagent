import { describe, expect, test } from "bun:test"

import { reinstallStep } from "./reinstall-step"

// Contract: omo-native's launcher sets OMO_REINSTALL_COMMAND (engine-environment.js, pinned by launcher.test.ts);
// the plugin names exactly that command, and nothing when another launch left it unset.
describe("reinstallStep", () => {
  test("#given the launcher's OMO_REINSTALL_COMMAND #then the step carries that exact command", () => {
    expect(reinstallStep({ OMO_REINSTALL_COMMAND: "bun add -g omo-ai@beta" }).endsWith(": bun add -g omo-ai@beta")).toBe(true)
  })

  test("#given no or a blank OMO_REINSTALL_COMMAND #then no command is named", () => {
    expect(reinstallStep({})).not.toContain(":")
    expect(reinstallStep({ OMO_REINSTALL_COMMAND: "  " })).not.toContain(":")
  })
})
