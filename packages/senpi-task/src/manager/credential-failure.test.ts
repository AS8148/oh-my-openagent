import { describe, expect, test } from "bun:test"

import { createTaskRecord, type ResolvedModelRecord, type TaskRecord } from "../state"
import { isCredentialFailure, runtimeFallbackCandidates, terminalFailureMessage } from "./credential-failure"

function rung(provider: string, modelId: string): ResolvedModelRecord {
  return { source: "category", provider, model_id: modelId, display: `${provider}/${modelId}` }
}

const GO_M3 = rung("opencode-go", "minimax-m3")
const GO_M27 = rung("opencode-go", "minimax-m2.7")
const ZAI_GLM = rung("zai", "glm-5.3")

function record(primary: ResolvedModelRecord, fallbacks: readonly ResolvedModelRecord[]): TaskRecord {
  return createTaskRecord({
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

  // Every wording senpi emits when a provider has no credential at request time (#10806). The provider is
  // signed out, so its sibling models fail the same way.
  test.each([
    ["the session's request-time check (auth-guidance formatNoApiKeyFoundMessage)", "No API key found for openai.\n\nUse /login to log into a provider via OAuth or API key. See:\n  ~/docs/providers.md"],
    ["the same check for an unknown provider", "No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key."],
    ["the registry's request auth (model-registry getApiKeyAndHeaders)", 'No API key found for "openai"'],
    ["a provider adapter (ai api/*)", "No API key for provider: openai"],
    ["the pi-messages adapter", 'No API key provided for provider "openai"'],
    ["a model switch onto a keyless provider", "No API key for openai/gpt-6-luna-fast"],
    ["an empty Claude subscription pool", "authentication_failed: No Anthropic Subscription accounts configured for the managed lane; run /login anthropic-subscription or set CLAUDE_CODE_OAUTH_TOKEN"],
    ["an empty Cursor CLI account pool", "no accounts: run /login cursor-cli-oauth"],
    ["a missing Cursor access token", "Cursor access token is required; run /login cursor"],
    ["a missing Radius login", "Radius authentication is required; start Pi and run /login radius, then retry"],
    ["a signed-out Claude Code SDK", "Not logged in \u00b7 Please run /login"],
  ])("#given a missing credential from %s #when classified #then it is a credential failure", (_label, message) => {
    expect(isCredentialFailure(message, "gpt-6-luna-fast")).toBe(true)
  })

  test.each([
    ["no model selected at all, which names no provider", "No model selected.\n\nUse /login to log into a provider via OAuth or API key.\n\nThen use /model to select a model."],
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

  test("#given senpi's missing-key text on an API-key rung and a parent on the subscription #when the candidates are computed #then the other API-key rung is skipped and the parent's model is next (#10806)", () => {
    const selected = rung("openai", "gpt-6-luna-fast")
    const sibling = rung("openai", "another")
    const parent = rung("chatgpt-subscription", "gpt-6-luna-fast")
    const failed: TaskRecord = { ...record(selected, [sibling, parent]), parent_model: parent.display }

    const candidates = runtimeFallbackCandidates(failed, "No API key found for openai.")

    expect(candidates).toEqual({ remaining: [parent], skipped: [sibling] })
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
