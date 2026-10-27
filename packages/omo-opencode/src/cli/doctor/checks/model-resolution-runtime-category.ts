import { CATEGORY_MODEL_REQUIREMENTS } from "../../../shared/model-requirements"
import { resolveCategoryExecution } from "../../../tools/delegate-task/category-resolver"
import type { ExecutorContext } from "../../../tools/delegate-task/executor-types"
import type { OmoConfig, RuntimeCategoryResolution } from "./model-resolution-types"

/**
 * Resolves every user-configured, enabled builtin category through the delegate-task runtime resolver,
 * so doctor shows exactly the model, reasoning or error a task() spawn would get.
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
  const names = Object.entries(config.categories ?? {})
    .filter(([name, category]) => CATEGORY_MODEL_REQUIREMENTS[name] !== undefined && category?.disable !== true)
    .map(([name]) => name)
  const resolved = await Promise.all(names.map(async (name): Promise<[string, RuntimeCategoryResolution]> => {
    const result = await resolveCategoryExecution(
      { category: name, prompt: "", description: "omo doctor", run_in_background: false, load_skills: [] },
      executorCtx,
      undefined,
      undefined,
    )
    if (result.error !== undefined) return [name, { error: result.error }]
    const reasoning = result.categoryModel?.reasoning ?? result.categoryModel?.variant
    return [name, {
      ...(result.actualModel === undefined ? {} : { model: result.actualModel }),
      ...(reasoning === undefined ? {} : { reasoning }),
      userDefined: result.modelInfo?.type === "user-defined",
    }]
  }))
  return Object.fromEntries(resolved)
}
