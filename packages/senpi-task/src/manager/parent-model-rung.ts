import type { ResolvedModelRecord, TaskRecord } from "../state"
import type { ManagerStartSpec, ResolvedChildPlan } from "./types"

export type ParentRungPlan = {
  readonly plan: ResolvedChildPlan
  readonly parentModel?: string
}

/**
 * A category child's chain ends on the model its parent session runs (#10750): when every category rung
 * is spent or signed out, the child keeps working on the model the user chose instead of dying. The rung
 * goes LAST, after admission picked the primary, so any usable category rung still routes exactly as
 * before. An explicit model pin, an agent route, or a parent model the chain already names adds nothing.
 */
export function withParentModelRung(plan: ResolvedChildPlan, spec: ManagerStartSpec): ParentRungPlan {
  if (spec.category === undefined || spec.model !== undefined || spec.parent_model === undefined) return { plan }
  const parent = parseParentModel(spec.parent_model, plan.resolved_model?.source ?? "category")
  if (parent === undefined) return { plan }
  const chain = [plan.resolved_model, plan.requested_model, ...(plan.fallback_models ?? [])]
  if (chain.some((rung) => rung !== undefined && sameModel(rung, parent)) || plan.model === parent.display) return { plan }
  return {
    plan: { ...plan, fallback_models: [...(plan.fallback_models ?? []), parent] },
    parentModel: parent.display,
  }
}

export function isParentModelRung(record: Pick<TaskRecord, "parent_model">, model: string | Pick<ResolvedModelRecord, "provider" | "model_id">): boolean {
  if (record.parent_model === undefined) return false
  const base = typeof model === "string" ? baseSelector(model) : `${model.provider}/${model.model_id}`
  return base === record.parent_model
}

function parseParentModel(value: string, source: ResolvedModelRecord["source"]): ResolvedModelRecord | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { source, provider: value.slice(0, slash), model_id: value.slice(slash + 1), display: value }
}

function sameModel(left: Pick<ResolvedModelRecord, "provider" | "model_id">, right: Pick<ResolvedModelRecord, "provider" | "model_id">): boolean {
  return left.provider === right.provider && left.model_id === right.model_id
}

function baseSelector(selector: string): string {
  const slash = selector.indexOf("/")
  const colon = selector.lastIndexOf(":")
  return colon > slash ? selector.slice(0, colon) : selector
}
