// /palace slash command registration. The handler loads the palace runtime sidecar on first use
// (see runtime-loader.ts); the generator and collectors never ship in the entry bundle.

import type { SenpiExtensionAPI } from "../../../extension/types"
import type { MemoryIdentityContext } from "../context"
import type { PalacePeopleOptions } from "./people"
import { loadPalaceRuntime, palaceRuntimeLoadFailure, type PalaceRuntimeLoader } from "./runtime-loader"

export interface PalaceCommandUi {
  notify(message: string, type?: "info" | "warning" | "error"): void
}

/** Structural slice of senpi's ExtensionCommandContext the palace command reads. */
export interface PalaceCommandContext {
  readonly hasUI?: boolean
  readonly ui?: PalaceCommandUi
  readonly env?: Record<string, string | undefined>
  readonly platform?: NodeJS.Platform
  output?(text: string): void
  exec?(
    command: string,
    args: string[],
    options?: Record<string, unknown>,
  ): Promise<{ code: number; stdout: string; stderr: string }>
}

export type PalaceContextResolver = (ctx: PalaceCommandContext) => MemoryIdentityContext | undefined

/** Resolves the people-panel gate; omitted resolvers fall back to the schema defaults. */
export type PalacePeopleResolver = () => PalacePeopleOptions | undefined

export function registerPalaceCommand(
  pi: SenpiExtensionAPI,
  resolve: PalaceContextResolver,
  resolvePeople?: PalacePeopleResolver,
  loadRuntime: PalaceRuntimeLoader = loadPalaceRuntime,
): void {
  pi.registerCommand("palace", {
    description: "Generate the memory palace HTML viewer for the bound identity.",
    handler: async (_args: string, ctx: PalaceCommandContext): Promise<void> => {
      const runtime = await loadRuntime().catch((error: unknown) => {
        reportPalace(ctx, palaceRuntimeLoadFailure("palace", error), "error")
        return undefined
      })
      if (runtime === undefined) return
      return runtime.runPalaceCommand(resolve, ctx, resolvePeople)
    },
  })
}

export function reportPalace(ctx: PalaceCommandContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.ui !== undefined) {
    ctx.ui.notify(message, level)
    return
  }
  ctx.output?.(message)
}
