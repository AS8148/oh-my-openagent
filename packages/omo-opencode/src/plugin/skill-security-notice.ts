import type { PluginContext } from "./types"
import { log } from "../shared/logger"

export function showSkillSecurityNotice(ctx: Pick<PluginContext, "client">, message: string): void {
  log("[skill-security] " + message)
  // The notice runs inside skill discovery and the skill tool; a client without a TUI, or a toast that throws
  // synchronously, must never replace the loader's containment result (#10693).
  const failed = (error: unknown) => {
    log("[skill-security] toast delivery failed", { error: error instanceof Error ? error.name : "unknown" })
  }
  try {
    const delivery = ctx.client.tui?.showToast?.({
      body: { title: "Skill security", message, variant: "warning", duration: 15000 },
    })
    void delivery?.catch(failed)
  } catch (error) {
    failed(error)
  }
}
