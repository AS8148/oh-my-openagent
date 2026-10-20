export type EnvGrantLabel = {
  readonly project: string
  readonly skill: string
  readonly server: string
}
export type EnvGrant = {
  readonly label: EnvGrantLabel
  readonly names: readonly string[]
}
export type EnvGrantSnapshot = {
  readonly version: 1
  readonly generation: number
  readonly grants: Readonly<Record<string, EnvGrant>>
  /** Observer metadata, never serialized into the grants file. */
  readonly revision?: string
}
export interface GrantStore {
  read(): Promise<EnvGrantSnapshot>
  add(digest: string, grant: EnvGrant): Promise<void>
  revoke(digest: string): Promise<void>
  list(): Promise<Readonly<Record<string, EnvGrant>>>
  watch(listener: () => void | Promise<void>): () => void
  digest(): Promise<string>
}

export const unavailableGrantStore: GrantStore = {
  read: async () => ({ version: 1, generation: 0, grants: {} }),
  add: async () => { throw new Error("The shared MCP environment grants store is not connected.") },
  revoke: async () => { throw new Error("The shared MCP environment grants store is not connected.") },
  list: async () => ({}),
  watch: () => () => {},
  digest: async () => "unavailable",
}
