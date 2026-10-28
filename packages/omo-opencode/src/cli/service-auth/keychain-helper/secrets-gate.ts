// Every Bun.secrets call in the process goes through this one queue (#11262 design 3.2 step 2). Bun.secrets runs on a
// thread pool, and keychain interaction is a process-wide switch: a call that started while another call had turned
// interaction off would see -25308 and report "locked". So calls run one at a time, each to completion, and a silent
// call turns interaction off only for its own duration.

let queue: Promise<unknown> = Promise.resolve()

type InteractionSwitch = (allowed: boolean) => void
let interactionSwitch: InteractionSwitch | null | undefined

async function loadInteractionSwitch(): Promise<InteractionSwitch | null> {
  if (interactionSwitch !== undefined) return interactionSwitch
  if (process.platform !== "darwin") return (interactionSwitch = null)
  try {
    const { dlopen, FFIType } = await import("bun:ffi")
    const security = dlopen("/System/Library/Frameworks/Security.framework/Security", {
      SecKeychainSetUserInteractionAllowed: { args: [FFIType.u8], returns: FFIType.i32 },
    })
    interactionSwitch = allowed => {
      security.symbols.SecKeychainSetUserInteractionAllowed(allowed ? 1 : 0)
    }
  } catch {
    interactionSwitch = null
  }
  return interactionSwitch
}

/** Runs one Bun.secrets call after every earlier one has settled. */
export function gatedSecrets<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run)
  queue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/** As `gatedSecrets`, with keychain interaction off for exactly this call: it can never show a dialog. */
export function silentSecrets<T>(run: () => Promise<T>): Promise<T> {
  return gatedSecrets(async () => {
    const setInteraction = await loadInteractionSwitch()
    if (setInteraction === null) throw new Error("Keychain interaction cannot be switched off on this host.")
    setInteraction(false)
    try {
      return await run()
    } finally {
      setInteraction(true)
    }
  })
}
