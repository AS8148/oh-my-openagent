import type { OmoConfig } from "@oh-my-opencode/omo-config-core"
import { resolveCategory, type SenpiModelPort, type SenpiModelRegistryPort } from "@oh-my-opencode/senpi-task"

import type { JobWidgetAuthorContext, JobWidgetHostApi } from "./job-widget-host"

const JOB_WIDGET_AUTHOR_CATEGORY = "quick"

export function resolveJobWidgetAuthorModel(
  omoConfig: OmoConfig,
  registry: SenpiModelRegistryPort<SenpiModelPort>,
): SenpiModelPort | undefined {
  const resolution = resolveCategory(JOB_WIDGET_AUTHOR_CATEGORY, omoConfig, registry)
  return resolution.kind === "resolved" ? resolution.spec.model : undefined
}

type AuthorConfig = { readonly cwd: string; readonly omoConfig: OmoConfig }

// senpi keeps ONE author route per process while a shared daemon runs many sessions, each with the
// omo.json of its own project. Every registered session adds its config here; the route answers with
// the config of the session asking (matched by cwd) and leaves a session it does not know to senpi's
// fallback, the session model. The route is withdrawn when the last session releases it.
const authorConfigs: AuthorConfig[] = []
let withdrawRoute: (() => void) | undefined

function routeAuthor(ctx: JobWidgetAuthorContext): SenpiModelPort | undefined {
  const config = authorConfigs.findLast((entry) => entry.cwd === ctx.cwd)
  return config === undefined ? undefined : resolveJobWidgetAuthorModel(config.omoConfig, ctx.modelRegistry)
}

export function installJobWidgetAuthor(host: JobWidgetHostApi, cwd: string, omoConfig: OmoConfig): () => void {
  const setAuthorResolver = host.setAuthorResolver
  if (setAuthorResolver === undefined) return () => {}
  const config: AuthorConfig = { cwd, omoConfig }
  authorConfigs.push(config)
  withdrawRoute ??= setAuthorResolver(routeAuthor)
  let released = false
  return () => {
    if (released) return
    released = true
    authorConfigs.splice(authorConfigs.indexOf(config), 1)
    if (authorConfigs.length > 0) return
    withdrawRoute?.()
    withdrawRoute = undefined
  }
}
