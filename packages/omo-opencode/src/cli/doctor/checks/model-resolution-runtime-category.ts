import { CATEGORY_MODEL_REQUIREMENTS } from "../../../shared/model-requirements"
import { resolveCategoryExecution } from "../../../tools/delegate-task/category-resolver"
import type { ExecutorContext } from "../../../tools/delegate-task/executor-types"
import type { OmoConfig, RuntimeCategoryResolution } from "./model-resolution-types"

/**
 * Resolves every user-configured builtin category through the delegate-task runtime resolver,
 * so doctor shows exactly the model and reasoning a task() spawn would use.
 */
export async function resolveConfiguredCategoriesAtRuntime(
  config: OmoConfig,
): Promise<Record<string, RuntimeCategoryResolution>> {
  const executorCtx = {
    client: {},
    manager: {},
    directory: process.cwd(),
    userCategories: config.categories,
    sisyphusJuniorModel: undefined,
  } as unknown as ExecutorContext
  const names = Object.keys(config.categories ?? {}).filter((name) => CATEGORY_MODEL_REQUIREMENTS[name] !== undefined)
  const resolved = await Promise.all(names.map(async (name) => {
    const result = await resolveCategoryExecution(
      { category: name, prompt: "", description: "omo doctor", run_in_background: false, load_skills: [] },
      executorCtx,
      undefined,
      undefined,
    )
    if (result.error !== undefined || result.actualModel === undefined || result.modelInfo?.type !== "user-defined") return []
    const reasoning = result.categoryModel?.reasoning ?? result.categoryModel?.variant
    return [[name, { model: result.actualModel, ...(reasoning === undefined ? {} : { reasoning }) }] as const]
  }))
  return Object.fromEntries(resolved.flat())
}
