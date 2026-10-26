const BUNDLE_PATHS = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
] as const

type LinuxFamily = "debian" | "fedora" | "suse"
type BundlePath = (typeof BUNDLE_PATHS)[number]

export type LinuxBundleSelection =
  | { readonly kind: "known"; readonly family: LinuxFamily; readonly path: BundlePath }
  | { readonly kind: "unknown"; readonly family: "unknown"; readonly path: BundlePath }
  | { readonly kind: "linux-bundle-absent"; readonly family: LinuxFamily; readonly path: BundlePath }
  | { readonly kind: "linux-bundle-absent"; readonly family: "unknown"; readonly path: null }

function familyOf(token: string, isId: boolean): LinuxFamily | null {
  switch (token) {
    case "debian":
    case "ubuntu":
    case "alpine":
    case "arch":
      return "debian"
    case "fedora":
    case "rhel":
    case "centos":
      return "fedora"
    case "suse":
    case "opensuse":
    case "sles":
      return "suse"
    default:
      return isId && token.startsWith("opensuse-") ? "suse" : null
  }
}

export function selectLinuxBundle(
  osRelease: string | null,
  fallbackOsRelease: string | null,
  exists: (path: string) => boolean,
): LinuxBundleSelection {
  // os-release permits shell quoting/escaping, but neither expansion nor concatenation.
  let id = ""
  let idLike = ""
  const text = osRelease ?? fallbackOsRelease ?? ""
  for (const line of text.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
    const assignment = /^(ID|ID_LIKE)=(?:'([^']*)'|"((?:\\.|[^"\\])*)"|((?:\\.|[^\s"'\\])*))$/.exec(line)
    if (!assignment) continue
    const value = assignment[2] ?? (assignment[3] !== undefined
      ? assignment[3].replace(/\\([$`"\\])/g, "$1")
      : (assignment[4] ?? "").replace(/\\(.)/g, "$1"))
    if (assignment[1] === "ID") id = value
    else idLike = value
  }
  const family = familyOf(id, true)
    ?? idLike.split(/\s+/).map((token) => familyOf(token, false)).find((candidate) => candidate !== null)
    ?? null
  if (family !== null) {
    const paths = {
      debian: "/etc/ssl/certs/ca-certificates.crt",
      fedora: "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
      suse: "/etc/ssl/ca-bundle.pem",
    } as const
    const path = paths[family]
    return exists(path) ? { kind: "known", family, path } : { kind: "linux-bundle-absent", family, path }
  }
  const path = BUNDLE_PATHS.find(exists)
  return path === undefined
    ? { kind: "linux-bundle-absent", family: "unknown", path: null }
    : { kind: "unknown", family: "unknown", path }
}

export interface LinuxBundleStat {
  readonly size: number
  readonly mtimeMs: number
  readonly ino: number
  readonly dev: number
  isFile(): boolean
}

export interface LinuxBundleFs {
  stat(path: string): Promise<LinuxBundleStat>
  open(path: string, flags: "r"): Promise<{
    read(buffer: Uint8Array): Promise<{ readonly bytesRead: number }>
    close(): Promise<void>
  }>
}

export type LinuxBundleRead =
  | { readonly kind: "success"; readonly path: string; readonly bytes: Uint8Array }
  | {
    readonly kind: "linux-bundle-unreadable" | "linux-bundle-too-large" | "linux-bundle-replaced"
    readonly path: string
  }

export async function readLinuxBundle(path: string, fs: LinuxBundleFs): Promise<LinuxBundleRead> {
  const cap = 8 * 1024 * 1024
  try {
    const before = await fs.stat(path)
    if (!before.isFile()) return { kind: "linux-bundle-unreadable", path }
    if (before.size > cap) return { kind: "linux-bundle-too-large", path }
    const handle = await fs.open(path, "r")
    try {
      // One extra byte detects growth beyond the cap without an unbounded readFile.
      const bytes = new Uint8Array(cap + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes.subarray(length))
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > cap) return { kind: "linux-bundle-too-large", path }
      const after = await fs.stat(path)
      if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ino !== after.ino || before.dev !== after.dev || length !== after.size) {
        return { kind: "linux-bundle-replaced", path }
      }
      return { kind: "success", path, bytes: bytes.slice(0, length) }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof Error) return { kind: "linux-bundle-unreadable", path }
    throw error
  }
}
