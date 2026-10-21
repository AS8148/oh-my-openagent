import { X509Certificate } from "node:crypto"
import * as nodeTls from "node:tls"

/**
 * Certificate trust for the compiled engine (#10215).
 *
 * A `bun build --compile` binary trusts only Bun's bundled CA list, and `--use-system-ca` passed to
 * it is inert (it reaches `process.argv` as a plain string). So the engine installs bundled + OS
 * store + extras itself, at the top of every start: `host ensure`, the host daemon it spawns, and
 * the provisioned handoff all run this entry again. The OS store is read off the main thread and
 * awaited (bounded) only by the first outbound request (#10760).
 *
 * Extras come from `OMO_EXTRA_CA_CERTIFICATES`, PEM text (never a path) that the desktop validated
 * and its server set for the engine (sisyphuslabs/omo-desktop-app#2760). It is re-validated here
 * with the same rules and a bad value fails closed: the engine refuses to start rather than run
 * with a trust set the caller did not intend.
 */
export const ENGINE_EXTRA_CA_ENV = "OMO_EXTRA_CA_CERTIFICATES"
/** One environment variable on every OS: Windows caps a variable at 32,767 characters. */
export const MAX_EXTRA_CA_BYTES = 24 * 1024

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----\n([A-Za-z0-9+/=\n]*?)-----END \1-----/g

export class ExtraCaCertificatesError extends Error {
  override readonly name = "ExtraCaCertificatesError"
}

/** PEM `CERTIFICATE` blocks only, each a CA; whitespace is the only other content allowed. */
export function parseExtraCaCertificates(text: string): string[] {
  if (Buffer.byteLength(text, "utf8") > MAX_EXTRA_CA_BYTES) {
    throw new ExtraCaCertificatesError(`${ENGINE_EXTRA_CA_ENV} is larger than ${MAX_EXTRA_CA_BYTES / 1024} KiB`)
  }
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
  const certificates = new Map<string, string>()
  for (const [block, label] of normalized.matchAll(PEM_BLOCK)) {
    if (label !== "CERTIFICATE") throw new ExtraCaCertificatesError(`${ENGINE_EXTRA_CA_ENV} contains a ${label} block`)
    let certificate: X509Certificate
    try {
      certificate = new X509Certificate(block)
    } catch {
      throw new ExtraCaCertificatesError(`${ENGINE_EXTRA_CA_ENV} holds a certificate that cannot be read`)
    }
    if (!certificate.ca) throw new ExtraCaCertificatesError(`${ENGINE_EXTRA_CA_ENV} holds a certificate that is not a CA`)
    certificates.set(certificate.fingerprint256, certificate.toString())
  }
  if (certificates.size === 0 || normalized.replace(PEM_BLOCK, "").trim().length > 0) {
    throw new ExtraCaCertificatesError(`${ENGINE_EXTRA_CA_ENV} is not a PEM certificate bundle`)
  }
  return [...certificates.values()]
}

type TrustApi = Pick<typeof nodeTls, "getCACertificates" | "setDefaultCACertificates">

export interface EngineTrustReport {
  readonly installed: boolean
  readonly bundled: number
  /** OS-store certificates installed so far: 0 until the off-thread read lands (#10760). */
  readonly system: number
  /** Certificates `NODE_EXTRA_CA_CERTS` loaded. */
  readonly ambient: number
  readonly extra: number
}

/** How the OS store reached the trust set: read, still pending when a request had to go, or not read at all. */
export type SystemStoreOutcome = "loaded" | "timed-out" | "failed" | "skipped"

export interface EngineTrustOptions {
  /** Reads the OS store off the main thread. Default: a Worker calling `getCACertificates("system")`. */
  readonly loadSystem?: () => Promise<readonly string[]>
  /** `--version` / `--help`: never touch the OS store (#10760). */
  readonly skipSystem?: boolean
  readonly warn?: (message: string) => void
}

/** How long the first outbound request waits for the OS store before going with what is installed. */
export const SYSTEM_STORE_BUDGET_MS = 1_500

let systemStore: Promise<SystemStoreOutcome> = Promise.resolve("skipped")
let systemSettled = false

/**
 * Installs bundled + `NODE_EXTRA_CA_CERTS` (which Bun loads natively before this runs) + the validated
 * extras at once, and reads the OS store OFF the main thread (#10760): on some Macs the security
 * server never answers `getCACertificates("system")`, which used to hang every start, `--version`
 * included. When the read lands its certificates are added and `NODE_USE_SYSTEM_CA=1` is set for
 * later `BUN_BE_BUN` children (which read the store themselves); until then, and forever when it
 * never lands, those children keep the bundled set like this process does.
 * `NODE_EXTRA_CA_CERTS` is honored because standalone CLI users behind a corporate proxy set it; the
 * desktop strips it from the engines it starts (omo-desktop-app#2766). Those ambient certificates are
 * taken as Node loaded them, without the `CA:TRUE` and strict-parse checks the `OMO_EXTRA_CA_CERTIFICATES`
 * extras get, matching standard Node behaviour. `OMO_EXTRA_CA_CERTIFICATES` stays in the environment:
 * the host daemon is a grandchild and needs it.
 */
export function installEngineCaTrust(
  env: NodeJS.ProcessEnv = process.env,
  tls: TrustApi = nodeTls,
  options: EngineTrustOptions = {},
): EngineTrustReport {
  const raw = env[ENGINE_EXTRA_CA_ENV]
  const extra = raw === undefined || raw === "" ? [] : parseExtraCaCertificates(raw)
  systemSettled = false
  if (typeof tls.getCACertificates !== "function" || typeof tls.setDefaultCACertificates !== "function") {
    systemStore = Promise.resolve("skipped")
    systemSettled = true
    return { installed: false, bundled: 0, system: 0, ambient: 0, extra: 0 }
  }
  const bundled = tls.getCACertificates("bundled")
  const ambient = tls.getCACertificates("extra")
  const base = [...new Set([...bundled, ...ambient, ...extra])]
  tls.setDefaultCACertificates(base)
  if (options.skipSystem === true) {
    systemStore = Promise.resolve("skipped")
    systemSettled = true
  } else {
    const warn = options.warn ?? ((message: string) => process.stderr.write(`omo: ${message}\n`))
    systemStore = (options.loadSystem ?? loadSystemStoreOffThread)().then(
      (system) => {
        tls.setDefaultCACertificates([...new Set([...base, ...system])])
        env.NODE_USE_SYSTEM_CA = "1"
        systemSettled = true
        return "loaded" as const
      },
      (error: unknown) => {
        systemSettled = true
        warn(`could not read the system certificate store (${error instanceof Error ? error.message : String(error)}); using the bundled certificates`)
        return "failed" as const
      },
    )
  }
  return { installed: true, bundled: bundled.length, system: 0, ambient: ambient.length, extra: extra.length }
}

let slowStoreWarned = false

/**
 * Waits for the OS store at most `budgetMs`, so the first outbound request trusts it on every machine
 * whose store answers, and a machine whose store never answers is held up once, not forever.
 */
export async function engineCaTrustReady(
  budgetMs = SYSTEM_STORE_BUDGET_MS,
  warn: (message: string) => void = (message) => process.stderr.write(`omo: ${message}\n`),
): Promise<SystemStoreOutcome> {
  if (systemSettled) return await systemStore
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    systemStore,
    new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), budgetMs)
    }),
  ])
  clearTimeout(timer)
  if (outcome === "timed-out" && !slowStoreWarned) {
    slowStoreWarned = true
    warn(
      `the system certificate store did not answer within ${budgetMs / 1000} s; continuing with the bundled certificates and any NODE_EXTRA_CA_CERTS / ${ENGINE_EXTRA_CA_ENV}. Its certificates are added when it answers.`,
    )
  }
  return outcome
}

const CERT_ERROR = /CERT|UNABLE_TO_(?:GET_ISSUER|VERIFY)|SELF_SIGNED|certificate/i

/** Error text for a request refused while the OS store was still unread: names the store and the escape hatch. */
export function slowStoreCertificateError(cause: unknown): Error {
  return new Error(
    `TLS certificate check failed while the system certificate store was still not answering, so only the bundled certificates and any NODE_EXTRA_CA_CERTS / ${ENGINE_EXTRA_CA_ENV} were trusted. If your network needs a certificate from the system store (a company proxy, for example), set NODE_EXTRA_CA_CERTS to a PEM file with it and start omo again.`,
    { cause },
  )
}

/**
 * The first `fetch` waits (bounded) for the OS store; every later one goes straight through. A
 * certificate error while the store is still unread is reported as that, never as a bare
 * certificate error: a company proxy whose CA lives only in the OS store (why #10219 added it)
 * needs to know the store did not answer and how to supply the CA instead.
 */
export function gateFetchOnEngineCaTrust(target: { fetch: typeof fetch } = globalThis, budgetMs = SYSTEM_STORE_BUDGET_MS): void {
  const original = target.fetch
  let ready: Promise<SystemStoreOutcome> | undefined
  const gated = (async (...args: Parameters<typeof fetch>) => {
    ready ??= engineCaTrustReady(budgetMs)
    await ready
    try {
      return await original(...args)
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      const text = `${typeof code === "string" ? code : ""} ${error instanceof Error ? error.message : String(error)}`
      if (!systemSettled && CERT_ERROR.test(text)) throw slowStoreCertificateError(error)
      throw error
    }
  }) as typeof fetch
  target.fetch = Object.assign(gated, original)
}

// A Worker blocked inside the OS call cannot hold the process open (`unref`), and its result is
// plain PEM text, so nothing native crosses threads.
export const SYSTEM_STORE_WORKER_SOURCE = 'postMessage(require("node:tls").getCACertificates("system"))'

export function loadSystemStoreOffThread(source = SYSTEM_STORE_WORKER_SOURCE): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
    const worker = new Worker(url)
    worker.unref()
    worker.onmessage = (event: MessageEvent<readonly string[]>) => {
      resolve(event.data)
      void worker.terminate()
    }
    worker.onerror = (event: ErrorEvent) => reject(new Error(event.message))
  })
}
