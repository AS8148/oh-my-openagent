import { describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync } from "node:crypto"
import { keyringFor } from "../testing/sync-v1.test-support.ts"
import corpus from "./strict-25519.corpus.json"
import pin from "./strict-25519.pin.json"
import { classifyEd25519Key, ed25519SignaturePrecheck, isStrongEd25519Key, isStrongX25519Key, strictEd25519Verify } from "./strict-25519.ts"

// Vendored copy of the shared strict-25519 helper (#10742). The module and corpus must stay
// byte-identical to the source; the corpus runs here on Bun, the runtime the sync client ships on.
const bytes = (hex: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(hex, "hex"))
const sha256 = async (name: string): Promise<string> =>
  createHash("sha256").update(new Uint8Array(await Bun.file(`${import.meta.dir}/${name}`).arrayBuffer())).digest("hex")

describe("vendored strict-25519", () => {
  test("the module and corpus are byte-identical to the pinned source", async () => {
    expect(await sha256("strict-25519.ts")).toBe(pin.module)
    expect(await sha256("strict-25519.corpus.json")).toBe(pin.corpus)
  })

  test.each(corpus.ed25519.keys)("key class: $id", (c) => {
    expect<string>(classifyEd25519Key(bytes(c.key))).toBe(c.class)
    expect(isStrongEd25519Key(bytes(c.key))).toBe(c.class === "strong")
  })

  test.each(corpus.ed25519.verify)("verify: $id", async (c) => {
    const result = await strictEd25519Verify(bytes(c.key), bytes(c.sig), bytes(c.msg))
    expect(result.ok ? "ok" : result.refusal).toBe(c.expect)
    expect(ed25519SignaturePrecheck(bytes(c.key), bytes(c.sig)).ok).toBe(c.expect !== "malformed")
  })

  test("on Bun every corpus forgery is accepted by the runtime itself, so the precheck is what refuses it", async () => {
    const forgeries = corpus.ed25519.verify.filter((c) => "forgery" in c)
    expect(forgeries.length).toBeGreaterThan(0)
    for (const c of forgeries) {
      const key = await crypto.subtle.importKey("raw", bytes(c.key), { name: "Ed25519" }, false, ["verify"])
      expect(await crypto.subtle.verify({ name: "Ed25519" }, key, bytes(c.sig), bytes(c.msg))).toBe(true)
      expect(ed25519SignaturePrecheck(bytes(c.key), bytes(c.sig)).ok).toBe(false)
    }
  })

  test.each(corpus.x25519.keys)("X25519 key: $id", (c) => {
    expect(isStrongX25519Key(bytes(c.key))).toBe(c.strong)
  })

  test("the sync fixture's keys and freshly generated keys stay strong", () => {
    for (const device of ["owner", "recovered"] as const) {
      expect(isStrongEd25519Key(new Uint8Array(Buffer.from(keyringFor(device).publicKeys().signing, "base64url")))).toBe(true)
    }
    for (let i = 0; i < 20; i++) {
      const x = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x ?? ""
      expect(isStrongEd25519Key(new Uint8Array(Buffer.from(x, "base64url")))).toBe(true)
    }
  })
})
