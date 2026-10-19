export type RegistryFetch = (url: string, init?: { headers?: Record<string, string>; cache?: string }) => Promise<Response>

export declare function pendingPackages(packages: readonly string[], version: string, fetchImpl?: RegistryFetch): Promise<string[]>

export declare function waitForRegistryVersions(options: {
  readonly packages: readonly string[]
  readonly version: string
  readonly attempts: number
  readonly delayMs: number
  readonly fetchImpl?: RegistryFetch
  readonly sleep?: (ms: number) => Promise<void>
  readonly log?: (line: string) => void
}): Promise<{ ok: boolean; pending: string[] }>
