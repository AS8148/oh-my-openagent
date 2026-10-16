import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { maskProviderAndModel } from "./product-identity"

// Vendored byte-identically from sisyphuslabs/omo-telemetry@4c8069b7fd:jobs/backfill/fixtures/mask-model-vectors.json.
// The collector tests against the same bytes, so client and collector masking cannot drift.
const VECTORS_PATH = join(import.meta.dir, "fixtures", "mask-model-vectors.json")
const VECTORS_SHA256 = "7142318f50f8f3ee8f58049aec8d7ee4cc82fa8c89265635347e737e6e153a1a"

type MaskVector = {
  readonly provider: string
  readonly model_id: string
  readonly expected: { readonly provider: string; readonly model_id: string }
}

const bytes = readFileSync(VECTORS_PATH)
const vectors: readonly MaskVector[] = JSON.parse(bytes.toString("utf8")).vectors

describe("shared maskModel vectors", () => {
  test("#given the vendored fixture #then its bytes match the collector copy", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(VECTORS_SHA256)
    expect(vectors.length).toBeGreaterThan(0)
  })

  test("#given every shared vector #when masked by the client #then the result equals the expected pair", () => {
    const mismatches = vectors.filter((vector) => {
      const masked = maskProviderAndModel(vector.provider, vector.model_id)
      return masked.provider !== vector.expected.provider || masked.model_id !== vector.expected.model_id
    })
    expect(mismatches).toEqual([])
  })
})
