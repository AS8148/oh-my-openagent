import { expect, test } from "bun:test"
import { ALL_KNOWN_MODEL_IDS } from "./model-vocabulary"
import { isOtlpEvent, projectOtlpEvent, OTLP_SPANS } from "./otlp-projection"
import { PINNED_MODEL_ID_LIST } from "./pinned-model-ids"

// Independent examples from omo-telemetry's pinned omo-senpi v4 artifact.
for (const [event, property, wire] of [
  ["category_config", "cat_architect", "omo.cat_architect"],
  ["computer_use_activation", "active", "omo.active"],
  ["computer_use_engine_error", "code", "omo.code"],
  ["computer_use_permission_denied", "permission", "omo.permission"],
  ["daily_active", "day_utc", "omo.day_utc"],
  ["delegation_completed", "task_seq", "omo.task_seq"],
  ["delegation_started", "background", "omo.background"],
  ["feature_used", "feature", "omo.feature"],
  ["handoff_hint", "action", "omo.action"],
  ["kibitzer_summary", "wakes_total", "omo.wakes_total"],
  ["parallelism_summary", "schema_kind", "omo.schema_kind"],
  ["process_crashed", "exit_code", "process.exit.code"],
  ["prompt_submitted", "is_real_user_prompt", "omo.prompt.is_real_user"],
  ["session_started", "session_role", "omo.session.role"],
  ["session_summary", "session_role", "omo.session.role"],
  ["skill_loaded", "skill_name", "omo.skill_name"],
  ["turn_completed", "turn_index", "omo.turn.index"],
] as const) {
  test(`OTLP projection pins ${event} and drops unlisted attributes`, () => {
    expect(isOtlpEvent(event)).toBe(true)
    expect(projectOtlpEvent(event, { [property]: 1, $session_id: "hash", unknown: "private", prompt_text: "private" })).toEqual({
      [wire]: 1,
      ...(event === "process_crashed" ? {} : { "session.id": "hash" }),
    })
  })
}

test("OTLP drops events not present in the pinned artifact", () => {
  expect(isOtlpEvent("omo_senpi_daily_active")).toBe(false)
  expect(projectOtlpEvent("omo_senpi_daily_active", { reason: "session_start", $session_id: "hash" })).toEqual({})
})

test("OTLP turn projection includes cache tokens in input and maps cost and provider", () => {
  expect(projectOtlpEvent("turn_completed", {
    input_tokens: 10, cache_read_tokens: 20, cache_write_tokens: 30,
    output_tokens: 5, reasoning_tokens: 2, total_tokens: 65,
    cost_1e4: 123, cost_usd: 0.0123, provider: "google",
    request_model_id: "gemini-3.1-pro", response_model_id: "gemini-3.1-pro",
  })).toEqual({
    "gen_ai.usage.input_tokens": 60,
    "gen_ai.usage.cache_read.input_tokens": 20,
    "gen_ai.usage.cache_creation.input_tokens": 30,
    "gen_ai.usage.output_tokens": 5,
    "gen_ai.usage.reasoning.output_tokens": 2,
    "omo.usage.total_tokens": 65,
    "omo.cost.usd_1e4": 123,
    "omo.provider": "google",
    "gen_ai.provider.name": "gcp.gemini",
    "gen_ai.request.model": "gemini-3.1-pro",
    "gen_ai.response.model": "gemini-3.1-pro",
  })
})

test("OTLP summary cost uses the pinned integer cost field and excludes non-finite attributes", () => {
  expect(projectOtlpEvent("session_summary", { cost_1e4: 50, turns: NaN })).toEqual({ "omo.cost.usd_1e4": 50 })
})

test("OTLP spans allow only the pinned turn attributes", () => {
  expect(OTLP_SPANS).toEqual({
    "omo.turn": [
      "gen_ai.operation.name", "gen_ai.provider.name", "gen_ai.request.model", "gen_ai.response.model",
      "omo.model_id", "omo.provider", "omo.session.role", "omo.turn.index", "session.id",
    ],
  })
})

// Collector pin 13c6e61b (omo-senpi.json): omo.model_id on omo.turn_completed is a REQUIRED enum of the
// pinned model vocabulary, which lists custom. The client vocabulary can run ahead of the pin, and the
// collector rejects the whole record for an unlisted value (invalid_enum), so such a value must leave as custom.
const PIN_MODEL_IDS = new Set(PINNED_MODEL_ID_LIST)

test("#given a client model id the collector pin does not list #when turn_completed is projected #then every model key carries a pinned value", () => {
  const models = [...ALL_KNOWN_MODEL_IDS, "claude-fable-5-5", "custom"]
  for (const model of models) {
    const projected = projectOtlpEvent("turn_completed", {
      provider: "anthropic", model_id: model, request_model_id: model, response_model_id: model,
      input_tokens: 100, output_tokens: 20, cost_1e4: 1, session_role: "root",
    })
    for (const key of ["omo.model_id", "gen_ai.request.model", "gen_ai.response.model"]) {
      const value = projected[key]
      expect(typeof value === "string" && PIN_MODEL_IDS.has(value), `${key}=${String(value)} for ${model}`).toBe(true)
    }
  }
  expect(projectOtlpEvent("turn_completed", { model_id: "claude-fable-5-5" })["omo.model_id"]).toBe("custom")
  expect(projectOtlpEvent("turn_completed", { model_id: "claude-opus-5-5" })["omo.model_id"]).toBe("claude-opus-5-5")
})

test("#given an unpinned model id on another event #when it is projected #then it leaves as custom", () => {
  expect(projectOtlpEvent("session_started", { default_model: "claude-fable-5-5" })["omo.default_model"]).toBe("custom")
  expect(projectOtlpEvent("category_config", { cat_quick: "claude-fable-5-5" })["omo.cat_quick"]).toBe("custom")
  expect(projectOtlpEvent("kibitzer_summary", { model_top: "claude-fable-5-5" })["omo.model_top"]).toBe("custom")
})

test("#given session_summary top-model ranks #when they are projected #then unpinned ids leave as custom and none stays none", () => {
  const projected = projectOtlpEvent("session_summary", { m1_model: "claude-fable-5-5", m2_model: "claude-opus-5-5", m3_model: "none" })
  expect(projected["omo.m1_model"]).toBe("custom")
  expect(projected["omo.m2_model"]).toBe("claude-opus-5-5")
  expect(projected["omo.m3_model"]).toBe("none")
})
