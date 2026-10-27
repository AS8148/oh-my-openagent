declare const require: (name: string) => any
const { afterEach, beforeEach, describe, expect, it, spyOn } = require("bun:test")
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { validatePluginConfig } from "../../../config/validate"
import { resolveAgentVariant } from "../../../shared/agent-variant"
import * as connectedProvidersCache from "../../../shared/connected-providers-cache"
import { resolveCategoryExecution } from "../../../tools/delegate-task/category-resolver"
import type { ExecutorContext } from "../../../tools/delegate-task/executor-types"
import { unsafeTestValue } from "../../../../../../test-support/unsafe-test-value"
import { checkModels } from "./model-resolution"

// Issue #11531: doctor "Configured Models" must print what the runtime resolves for
// configs written in the canonical `models` chain format with `reasoning`.
const ISSUE_CONFIG = {
  "[opencode]": {
    agents: {
      "multimodal-looker": { models: [{ model: "openai/gpt-6.1-terra", reasoning: "medium" }] },
      prometheus: { models: [{ model: "anthropic/claude-fable-5-1", reasoning: "high" }] },
    },
    categories: {
      "visual-engineering": { models: [{ model: "anthropic/claude-fable-5-1", reasoning: "high" }] },
      writing: { models: ["anthropic/claude-opus-5-5"], reasoning: "low" },
    },
  },
}

describe("doctor Configured Models with canonical models chains (#11531)", () => {
  let originalHome: string | undefined
  let temporaryDirectory = ""
  const spies: Array<{ mockRestore: () => void }> = []

  beforeEach(() => {
    originalHome = process.env.HOME
    temporaryDirectory = mkdtempSync(join(tmpdir(), "omo-doctor-models-chain-"))
    process.env.HOME = temporaryDirectory
    const path = join(temporaryDirectory, ".omo", "omo.jsonc")
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, JSON.stringify(ISSUE_CONFIG) + "\n")
    spies.push(
      spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(null),
      spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue(null),
      spyOn(connectedProvidersCache, "hasConnectedProvidersCache").mockReturnValue(false),
      spyOn(connectedProvidersCache, "hasProviderModelsCache").mockReturnValue(false),
    )
  })

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
    rmSync(temporaryDirectory, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it("#given agents configured only via models with reasoning #when doctor renders #then the effort equals the runtime agent variant", async () => {
    //#given
    const config = validatePluginConfig(process.cwd()).config

    //#when
    const details = (await checkModels()).details ?? []

    //#then
    for (const [agent, model, reasoning] of [
      ["multimodal-looker", "openai/gpt-6.1-terra", "medium"],
      ["prometheus", "anthropic/claude-fable-5-1", "high"],
    ] as const) {
      expect(resolveAgentVariant(config, agent)).toBe(reasoning)
      expect(details.some((line) => line.includes(`● ${agent}: ${model} (${reasoning}) [`))).toBe(true)
    }
  })

  it("#given categories configured only via models #when doctor renders #then the model and effort equal the runtime category resolution", async () => {
    //#given
    const config = validatePluginConfig(process.cwd()).config
    const executorCtx: ExecutorContext = {
      client: unsafeTestValue({}),
      manager: unsafeTestValue({}),
      directory: temporaryDirectory,
      userCategories: config.categories,
      sisyphusJuniorModel: undefined,
    }

    //#when
    const details = (await checkModels()).details ?? []

    //#then
    for (const [category, model, reasoning] of [
      ["visual-engineering", "anthropic/claude-fable-5-1", "high"],
      ["writing", "anthropic/claude-opus-5-5", "low"],
    ] as const) {
      const runtime = await resolveCategoryExecution(
        { category, prompt: "p", description: "d", run_in_background: false, load_skills: [] },
        executorCtx,
        undefined,
        undefined,
      )
      expect(runtime.actualModel).toBe(model)
      expect(runtime.categoryModel?.reasoning).toBe(reasoning)
      expect(details.some((line) => line.includes(`● ${category}: ${model} (${reasoning}) [`))).toBe(true)
    }
  })
})
