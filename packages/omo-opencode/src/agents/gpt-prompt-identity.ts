export type GptPromptIdentityKey =
  | "gpt-5.5"
  | "gpt-5.6-sol"
  | "gpt-6-astra"
  | "gpt-6-sol"
  | "gpt-6.1-sol"
  | "gpt-6-luna"
  | "gpt-family"

const GPT_PROMPT_IDENTITIES: Record<GptPromptIdentityKey, string> = {
  "gpt-5.5": "GPT-5.5",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6-sol": "GPT-6 Sol",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6-luna": "GPT-6 Luna",
  "gpt-family": "a GPT-family model",
}

// Same id shapes as senpi's GPT-6 preset matcher: dotted, dashed, and Venice's dotless `gpt-61-sol`.
const GPT_6_1_SOL_RE = /gpt-6(?:[.-]1|1)-sol/

export function getGptPromptIdentityKey(model?: string): GptPromptIdentityKey {
  const modelID = model?.split("/").at(-1)?.toLowerCase()

  if (modelID?.includes("gpt-6-astra")) {
    return "gpt-6-astra"
  }
  if (modelID && GPT_6_1_SOL_RE.test(modelID)) {
    return "gpt-6.1-sol"
  }
  if (modelID?.includes("gpt-6-sol")) {
    return "gpt-6-sol"
  }
  if (modelID?.includes("gpt-6-luna")) {
    return "gpt-6-luna"
  }
  if (modelID?.includes("gpt-5.6-sol") || modelID?.includes("gpt-5-6-sol")) {
    return "gpt-5.6-sol"
  }
  if (modelID?.includes("gpt-5.5") || modelID?.includes("gpt-5-5")) {
    return "gpt-5.5"
  }
  return "gpt-family"
}

export function getGptPromptIdentity(model?: string): string {
  return GPT_PROMPT_IDENTITIES[getGptPromptIdentityKey(model)]
}
