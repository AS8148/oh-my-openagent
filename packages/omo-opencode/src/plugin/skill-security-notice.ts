import type { PluginContext } from "./types"
import { log } from "../shared/logger"

export function showSkillSecurityNotice(ctx: Pick<PluginContext, "client">, message: string): void {
  log("[skill-security] " + message)
  void ctx.client.tui.showToast({
    body: { title: "Skill security", message, variant: "warning", duration: 15000 },
  }).catch((error: unknown) => {
    log("[skill-security] toast delivery failed", { error: error instanceof Error ? error.name : "unknown" })
  })
}
