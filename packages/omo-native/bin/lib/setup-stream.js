/**
 * The detection and planning half of `omo setup` as one stream: each source is read, classified
 * and yielded on its own, in the order later sources depend on. `omo setup` and the engine's
 * onboarding scan RPC (omo-senpi `components/onboarding/scan-runtime.ts`) both consume it, so the
 * import logic exists once. Nothing is written until a caller hands the collected plans to
 * `applySetupStages`. No source opens a socket or calls a model: the model-choice stage reads the
 * engine's offline model catalog only.
 */

import { join } from "node:path"
import { detectHarnesses } from "./setup-detect.js"
import { applyCredentials, credentialCounts, credentialPlanLines, credentialQuestion, opencodeOauthProviders, planCredentials } from "./setup-credentials.js"
import { applyAssets, assetCounts, assetPlanLines, assetQuestion, planAssets } from "./setup-assets-import.js"
import { planOpencodeProviders } from "./setup-opencode-providers.js"
import { applyProviders, planProviders, providerCounts, providerPlanLines, providerQuestion } from "./setup-providers-import.js"
import { applyModelChoices, modelChoiceCounts, modelChoicePlanLines, modelChoiceQuestion, planModelChoices } from "./setup-model-choices-import.js"
import { setupStageItems } from "./setup-stream-items.js"

export { canonicalAgentDir } from "./agent-dir.js"

/** Every source, in stream order: a later source reads what an earlier one decided. */
export const SETUP_SOURCES = ["detect", "providers", "credentials", "assets", "model-choices"]

const NO_PROVIDERS = { providers: [], skipped: [], notices: [] }

async function settle(work) {
  try {
    return { plan: await work() }
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
}

function stageResult(source, settled, disabled = false) {
  if (settled.error !== undefined) return { source, items: [], notices: [], plan: { pending: 0 }, error: settled.error }
  const plan = settled.plan
  return { source, items: disabled ? [] : setupStageItems(source, plan), notices: plan.notices ?? [], plan, ...(disabled ? { disabled: true } : {}) }
}

/**
 * Streams every source's plan. Custom providers (OpenCode `provider.<id>` blocks and catalog
 * providers) are read only with `includeCustomProviders`; without it the provider stage yields
 * disabled and empty, and a key for such a provider stays unmapped. `onSourceStart` is called
 * right before an enabled source starts reading. A source that throws yields its `error` and the
 * stream goes on with the sources after it.
 */
export async function* scanSetup(runtime, agentDir, options = {}) {
  const includeCustomProviders = options.includeCustomProviders === true
  const start = (source) => options.onSourceStart?.(source)

  start("detect")
  const detect = await settle(() => detectHarnesses(runtime))
  yield stageResult("detect", detect)

  if (includeCustomProviders) start("providers")
  let providerSource = NO_PROVIDERS
  const providers = await settle(() => {
    if (includeCustomProviders) providerSource = planOpencodeProviders(runtime)
    return planProviders(providerSource, agentDir)
  })
  if (providers.error !== undefined) providerSource = NO_PROVIDERS
  yield stageResult("providers", providers, !includeCustomProviders)

  start("credentials")
  // A provider the custom-provider stage described (carried or refused with its reason) is reported there only.
  const described = new Set([...providerSource.providers.map((item) => item.id), ...providerSource.skipped])
  yield stageResult("credentials", await settle(() => planCredentials(runtime, join(agentDir, "auth.json"), described)))

  start("assets")
  yield stageResult("assets", await settle(() => planAssets({ runtime, agentDir })))

  start("model-choices")
  let planChoices
  const modelChoices = await settle(() => {
    const oauthProviders = opencodeOauthProviders(runtime)
    planChoices = (customProviders) => planModelChoices({ runtime, agentDir, customProviders, oauthProviders })
    return planChoices(providers.plan?.result.added ?? [])
  })
  yield { ...stageResult("model-choices", modelChoices), ...(planChoices === undefined ? {} : { replan: planChoices }) }
}

/**
 * Drains a stream into the detect inventory and the stage plans `omo setup` renders and applies.
 * The CLI cannot summarize a partial plan, so the first failed source is rethrown.
 */
export async function collectSetupPlans(stream) {
  const plans = {}
  let inventory = { harnesses: [] }
  for await (const result of stream) {
    if (result.error !== undefined) throw result.error
    if (result.source === "detect") inventory = result.plan
    else if (result.source === "model-choices") {
      plans.modelChoices = result.plan
      plans.planChoices = result.replan
    } else plans[result.source] = result.plan
  }
  return { inventory, plans }
}

/**
 * In apply order: the model-choice stage runs last because a default model or category may name a
 * custom provider the stage before it carries. `present` stages report counts after the run. A
 * stage whose source failed has no plan and is never applied.
 */
export function setupStages(plans) {
  return [
    { id: "credentials", plan: plans.credentials, present: plans.credentials !== undefined && !plans.credentials.malformed, lines: credentialPlanLines, counts: credentialCounts, question: credentialQuestion, apply: applyCredentials },
    { id: "assets", plan: plans.assets, present: plans.assets?.present === true, lines: assetPlanLines, counts: assetCounts, question: assetQuestion, apply: applyAssets },
    { id: "providers", plan: plans.providers, present: plans.providers?.present === true, lines: providerPlanLines, counts: providerCounts, question: providerQuestion, apply: applyProviders },
    { id: "model-choices", plan: plans.modelChoices, present: plans.modelChoices?.present === true, lines: modelChoicePlanLines, counts: modelChoiceCounts, question: modelChoiceQuestion, apply: applyModelChoices },
  ]
}

/**
 * Applies every stage `confirm` accepts and returns the ids it applied. A declined provider stage
 * leaves models.json as it is, so the model choices are re-planned against it rather than against
 * providers that will not exist; the notices that re-plan adds go to `report`.
 */
export async function applySetupStages(plans, confirm, report = () => {}) {
  const applied = new Set()
  for (const stage of setupStages(plans)) {
    if (stage.id === "model-choices" && stage.plan !== undefined && plans.planChoices !== undefined && (plans.providers?.pending ?? 0) > 0 && !applied.has("providers")) {
      const shown = new Set(plans.modelChoices.notices)
      plans.modelChoices = await plans.planChoices([])
      stage.plan = plans.modelChoices
      for (const notice of plans.modelChoices.notices) if (!shown.has(notice)) report(notice)
    }
    if (stage.plan === undefined || stage.plan.pending === 0) continue
    if (!await confirm(stage)) continue
    stage.apply(stage.plan)
    applied.add(stage.id)
  }
  return applied
}
