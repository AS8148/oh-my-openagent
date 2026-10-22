// Preloaded into a real `omo account` process: a Linux host with no gdbus on PATH (a minimal install) and an
// in-memory OS credential store standing in for libsecret.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

Object.defineProperty(process, "platform", { value: "linux" })
process.env.PATH = mkdtempSync(join(tmpdir(), "omo-no-gdbus-"))
const values = new Map<string, string>()
Object.defineProperty(Bun, "secrets", {
  value: {
    get: async ({ name }: { readonly name: string }) => values.get(name) ?? null,
    set: async ({ name, value }: { readonly name: string; readonly value: string }) => { values.set(name, value) },
    delete: async ({ name }: { readonly name: string }) => values.delete(name),
  },
})
