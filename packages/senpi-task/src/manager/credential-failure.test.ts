import { describe, expect, test } from "bun:test"

import { createTaskRecord, type ResolvedModelRecord, type TaskRecord } from "../state"
import { MODEL_NOT_FOUND_ANSWERS, NOT_MODEL_NOT_FOUND_ANSWERS } from "./__fixtures__/model-not-found-inventory"
import { READABLE_PROVIDER_TEXT, SECRET_CELLS } from "./__fixtures__/secret-inventory"
import { isCredentialFailure, runtimeFallbackCandidates, terminalFailureMessage } from "./credential-failure"

function rung(provider: string, modelId: string): ResolvedModelRecord {
  return { source: "category", provider, model_id: modelId, display: `${provider}/${modelId}` }
}

const GO_M3 = rung("opencode-go", "minimax-m3")
const GO_M27 = rung("opencode-go", "minimax-m2.7")
const ZAI_GLM = rung("zai", "glm-5.3")

function record(primary: ResolvedModelRecord, fallbacks: readonly ResolvedModelRecord[], category?: string): TaskRecord {
  return createTaskRecord({
    ...(category === undefined ? {} : { category }),
    parent_session_id: "session-parent",
    root_session_id: "session-root",
    depth: 1,
    execution_mode: "in-process",
    notify_on_terminal: false,
    model: primary.display,
    requested_model: primary,
    resolved_model: primary,
    fallback_models: [...fallbacks],
  })
}

describe("isCredentialFailure", () => {
  test.each([
    ["401 without body", "401: Unauthorized"],
    ["invalid api key", '401: {"error":{"message":"Invalid API key provided"}}'],
    ["rejected OAuth refresh", 'OAuth refresh failed for anthropic: status=400; body={"error": "invalid_grant"}'],
    ["lapsed subscription (403 naming the subscription)", '403: {"message":"An active OpenCode Go subscription is required to use Go models."}'],
    ["403 naming the organization", "403: Your organization does not have access to this API"],
    ["403 naming the key", "403: This API key does not have permission to use the completions endpoint"],
    ["403 naming a suspended account", "403 Forbidden: this account has been suspended"],
  ])("#given %s #when classified #then it is a credential failure", (_label, message) => {
    expect(isCredentialFailure(message)).toBe(true)
  })

  test.each([
    ["an organization gate on one model", "403: Your organization must be verified to use this model"],
    ["a valid key refused one model", "403: The API key is valid, but access to restricted-model is forbidden. Use an allowed model."],
    ["an account gate naming the failed model id", "403: account tier does not include minimax-m3"],
  ])("#given a 403 that names the account or key but scopes itself to a model (%s) #when classified #then it is not a credential failure", (_label, message) => {
    expect(isCredentialFailure(message, "minimax-m3")).toBe(false)
  })

  test.each([
    ["a model-scoped 403", '403: {"error":{"message":"This model is not enabled for your project. Contact support to request access."}}'],
    ["a bare forbidden", "403 Forbidden"],
    ["a region-gated model", "403: gpt-6-astra is not available in your region"],
    ["a 500", "500: upstream overloaded"],
    ["a 429", "429: rate limited, retry after 3s"],
    ["a context overflow", "400: prompt is too long: 213000 tokens > 200000 maximum"],
  ])("#given %s #when classified #then it is not a credential failure", (_label, message) => {
    expect(isCredentialFailure(message)).toBe(false)
  })
})

describe("runtimeFallbackCandidates", () => {
  test("#given a model-scoped 403 on the first rung #when the candidates are computed #then the sibling model on the same provider stays", () => {
    const candidates = runtimeFallbackCandidates(record(GO_M3, [GO_M27, ZAI_GLM]), "403: This model is not enabled for your project.")

    expect(candidates).toEqual({ remaining: [GO_M27, ZAI_GLM], skipped: [] })
  })

  test.each([
    ["403: Your organization must be verified to use this model"],
    ["403: The API key is valid, but access to restricted-model is forbidden. Use an allowed model."],
  ])("#given a model-scoped 403 that names the organization or key (%s) #when the candidates are computed #then the allowed sibling stays and no re-authentication is prescribed", (message) => {
    const failed = record(GO_M3, [GO_M27, ZAI_GLM])

    expect(runtimeFallbackCandidates(failed, message)).toEqual({ remaining: [GO_M27, ZAI_GLM], skipped: [] })
    expect(terminalFailureMessage(record(GO_M3, []), message)).toBe(message)
  })

  test("#given a credential rejection on the first rung #when the candidates are computed #then every rung on that provider is skipped", () => {
    const candidates = runtimeFallbackCandidates(record(GO_M3, [GO_M27, ZAI_GLM]), "401: Unauthorized")

    expect(candidates).toEqual({ remaining: [ZAI_GLM], skipped: [GO_M27] })
  })

  test.each([
    ["a Claude session limit", "You've hit your session limit \u00b7 resets 3pm (Asia/Seoul)"],
    ["an OpenCode Go monthly limit", "429 Monthly usage limit reached. It will reset in 2 days 8 hours"],
    ["a Codex usage limit", '429 {"type":"usage_limit_reached","message":"The usage limit has been reached"}'],
    ["senpi's account limit text, which points at /model", "The anthropic-subscription account usage limit has been reached (resets 3:20am). Switch to another provider with /model, or configure another provider in retry.fallbackChains."],
  ])("#given %s on the first rung #when the candidates are computed #then other providers come first and the spent provider's rungs stay as the last resort", (_label, message) => {
    const candidates = runtimeFallbackCandidates(record(GO_M3, [GO_M27, ZAI_GLM]), message)

    expect(candidates).toEqual({ remaining: [ZAI_GLM, GO_M27], skipped: [], limit: "account" })
  })

  test.each([
    ["a gateway model_not_found", '400 {"code":"model_not_found","message":"unknown provider for model minimax-m3"}'],
    ["an unknown-provider answer", "400 Bad Request: unknown provider for model minimax-m3"],
  ])("#given %s on the first rung #when the candidates are computed #then no rung is offered (#11355)", (_label, message) => {
    const candidates = runtimeFallbackCandidates(record(GO_M3, [GO_M27, ZAI_GLM]), message)

    expect(candidates).toEqual({ remaining: [], skipped: [GO_M27, ZAI_GLM] })
  })

  test("#given a limit that names one model #when the candidates are computed #then the sibling model on the same provider is next", () => {
    const candidates = runtimeFallbackCandidates(record(GO_M3, [GO_M27, ZAI_GLM]), "You've hit your Fable weekly limit \u00b7 resets Oct 2, 9am")

    expect(candidates).toEqual({ remaining: [GO_M27, ZAI_GLM], skipped: [], limit: "model" })
  })

  describe("the parent session's model as the last rung (#10750)", () => {
    const PARENT = rung("chatgpt-subscription", "gpt-6.1-sol")
    const SPENT_PARENT = rung("opencode-go", "minimax-m2.7")
    const withParent = (parent: ResolvedModelRecord): TaskRecord => ({ ...record(GO_M3, [ZAI_GLM, parent]), parent_model: parent.display })

    test.each([
      ["a usage limit", "429 Monthly usage limit reached. It will reset in 2 days 8 hours"],
      ["a signed-out provider", "401: Unauthorized"],
    ])("#given %s #when the candidates are computed #then the parent's model stays after the category rungs", (_label, message) => {
      expect(runtimeFallbackCandidates(withParent(PARENT), message).remaining).toEqual([ZAI_GLM, PARENT])
    })

    test("#given a failure that is not a limit or a sign-in #when the candidates are computed #then the parent's model is not offered", () => {
      expect(runtimeFallbackCandidates(withParent(PARENT), "500: upstream overloaded").remaining).toEqual([ZAI_GLM])
    })

    test("#given the parent runs on the account whose limit is spent #when the candidates are computed #then the parent's model is skipped", () => {
      const candidates = runtimeFallbackCandidates(withParent(SPENT_PARENT), "429 Monthly usage limit reached. It will reset in 2 days 8 hours")

      expect(candidates).toEqual({ remaining: [ZAI_GLM], skipped: [SPENT_PARENT], limit: "account" })
    })
  })
})

describe("terminalFailureMessage", () => {
  test("#given a model-scoped 403 #when the terminal message is built #then no re-authentication is prescribed", () => {
    const message = terminalFailureMessage(record(GO_M3, []), "403: This model is not enabled for your project.")

    expect(message).toBe("403: This model is not enabled for your project.")
  })

  test("#given a credential rejection #when the terminal message is built #then both re-authentication paths and the alternatives are named", () => {
    const message = terminalFailureMessage(record(GO_M3, []), "401: Unauthorized")

    expect(message).toContain("re-authenticate opencode-go")
    expect(message).toContain("Provider authentication settings")
    expect(message).toContain("/login opencode-go")
    expect(message).toContain("omo.json")
  })

  test("#given a single-model lane whose only model hits an account usage limit #when the terminal message is built #then it says the chain is exhausted and how to recover", () => {
    const astra = { ...rung("chatgpt-subscription", "gpt-6-astra"), display: "GPT-6 Astra" }
    const limit = `403: {"message":"You've reached your usage limit for this billing cycle.","type":"access_terminated_error"}`

    const message = terminalFailureMessage(record(astra, []), limit)

    expect(message.startsWith(limit)).toBe(true)
    expect(message).toContain("chatgpt-subscription/gpt-6-astra reached its usage limit, so this task stopped.")
    expect(message).toContain("No other model in its fallback chain could take over.")
    expect(message).toContain("omo.json")
  })

  test("#given a usage limit while fallback rungs remain #when the terminal message is built #then it does not claim the chain is exhausted", () => {
    const message = terminalFailureMessage(record(GO_M3, [ZAI_GLM]), "You've hit your session limit")

    expect(message).toContain("opencode-go/minimax-m3 reached its usage limit, so this task stopped.")
    expect(message).not.toContain("No other model")
  })

  test("#given an ordinary provider error #when the terminal message is built #then it is passed through unchanged", () => {
    expect(terminalFailureMessage(record(GO_M3, []), "500: upstream connect error")).toBe("500: upstream connect error")
  })
})

describe("model configuration errors (#11355)", () => {
  test.each(MODEL_NOT_FOUND_ANSWERS)("#given %s #when the candidates are computed #then no rung is offered", (_label, message) => {
    expect(runtimeFallbackCandidates(record(GO_M3, [GO_M27, ZAI_GLM]), message).remaining).toEqual([])
  })

  test.each(NOT_MODEL_NOT_FOUND_ANSWERS)("#given %s #when the candidates are computed #then the chain is still walked", (_label, message) => {
    expect(runtimeFallbackCandidates(record(GO_M3, [GO_M27, ZAI_GLM]), message).remaining).not.toEqual([])
  })

  test.each(MODEL_NOT_FOUND_ANSWERS)("#given %s on a category task #when the terminal message is built #then it names the model and the omo.json key to fix, never an exhausted chain", (_label, message) => {
    const text = terminalFailureMessage(record(GO_M3, [GO_M27, ZAI_GLM], "quick"), message)

    expect(text.startsWith(message)).toBe(true)
    expect(text).toContain("opencode-go/minimax-m3 is not served by its route; fix categories.quick in omo.json.")
    expect(text).not.toMatch(/exhausted|No other model/i)
  })

  test("#given a model-not-found answer that also carries a 401 #when it is classified #then it is a configuration error, not a credential failure", () => {
    const message = '401 {"code":"model_not_found","message":"unknown provider for model minimax-m3"}'
    const failed = record(GO_M3, [GO_M27, ZAI_GLM], "quick")

    expect(runtimeFallbackCandidates(failed, message).remaining).toEqual([])
    const text = terminalFailureMessage(failed, message)
    expect(text).toContain("is not served by its route")
    expect(text).not.toContain("re-authenticate")
  })
})

describe("terminal error text redaction (#11355)", () => {
  const modelNotFound = '400 {"code":"model_not_found","message":"unknown provider for model minimax-m3"}'

  for (const cell of SECRET_CELLS) {
    test(`#given ${cell.name} #when a configuration error or an ordinary error is stored #then the secret is gone`, () => {
      for (const failure of [`${cell.text}\n${modelNotFound}`, `${cell.text}\n500: upstream connect error`]) {
        const text = terminalFailureMessage(record(GO_M3, [ZAI_GLM], "quick"), failure)

        expect(text).toContain("[REDACTED]")
        expect(text).not.toContain(cell.secret)
      }
    })
  }

  test("#given model ids, error codes and request ids #when the terminal message is built #then they stay readable", () => {
    const failure = `500: upstream connect error ${READABLE_PROVIDER_TEXT}`

    expect(terminalFailureMessage(record(GO_M3, [ZAI_GLM], "quick"), failure)).toBe(failure)
  })
})
