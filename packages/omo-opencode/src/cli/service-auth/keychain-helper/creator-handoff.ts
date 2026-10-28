import { join } from "node:path"
import type { RequirementCheck } from "./signature"
import { verifyWithSecurityFramework } from "./signature"

export const DESKTOP_RUNTIME_REQUIREMENT =
  'identifier "com.mengmota.omo-desktop-runtime" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] ' +
  'and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "523JNR86LZ"'

/** Set in the creator's environment so it never hands off in turn (a runtime that is not the creator would loop). */
export const HANDOFF_ENV = "OMO_KEYCHAIN_HANDOFF"
// The desktop gives `omo account token` the same deadline (apps/desktop/src/account/omoAccountProcess.ts).
const HANDOFF_DEADLINE_MS = 45_000

export function desktopRuntimeCandidates(home: string, arch: string = process.arch): readonly string[] {
  const runtimeArch = arch === "arm64" ? "arm64" : "x64"
  const inApp = (app: string) => join(app, "Contents", "Resources", "omo-runtime", `darwin-${runtimeArch}`, "omo")
  return [inApp("/Applications/OmO.app"), inApp(join(home, "Applications", "OmO.app"))]
}

export type HandOffRunner = (path: string, args: readonly string[], env: Record<string, string>, deadlineMs: number) => Promise<number | null>

const runBounded: HandOffRunner = async (path, args, env, deadlineMs) => {
  const child = Bun.spawn([path, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env })
  const timer = setTimeout(() => child.kill("SIGKILL"), deadlineMs)
  try {
    const code = await child.exited
    return child.signalCode === null ? code : null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Addendum change 1 (rows 7, 8): before any prompt, ask the side that created the item to move it to the helper. Its
 * own read is silent, and a version that carries the helper migrates the item in its `accessToken()`. The other
 * side's binary runs only after it passed its own designated requirement. At most once per process; true when a
 * verified creator ran to a clean exit (the caller re-reads to see whether the item moved).
 */
export function createCreatorHandOff(options: {
  readonly candidates: readonly string[]
  readonly requirement: string
  readonly env?: NodeJS.ProcessEnv
  readonly check?: RequirementCheck
  readonly run?: HandOffRunner
  readonly selfPath?: string
}): () => Promise<boolean> {
  let ran: Promise<boolean> | undefined
  return () => {
    ran ??= (async () => {
      const env = options.env ?? process.env
      if (env[HANDOFF_ENV] === "1") return false
      const check = options.check ?? verifyWithSecurityFramework
      const self = options.selfPath ?? process.execPath
      for (const candidate of options.candidates) {
        if (candidate === self || !(await Bun.file(candidate).exists())) continue
        if (!(await check(candidate, options.requirement))) continue
        const childEnv: Record<string, string> = { [HANDOFF_ENV]: "1" }
        for (const name of ["HOME", "OMO_SERVICE_API_URL"]) if (env[name] !== undefined) childEnv[name] = env[name] ?? ""
        return (await (options.run ?? runBounded)(candidate, ["account", "token"], childEnv, HANDOFF_DEADLINE_MS)) === 0
      }
      return false
    })()
    return ran
  }
}
