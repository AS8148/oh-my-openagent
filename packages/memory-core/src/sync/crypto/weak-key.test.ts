import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import type { DeviceKeyring } from "../keyring-port.ts"
import { creatorAnchor } from "./anchor.ts"
import { buildBatch } from "./build.ts"
import { appendEntries, type ChainState, emptyChain } from "./chain.ts"
import { isStrictEd25519Signature, isStrongEd25519Key } from "./ed25519-key.ts"
import type { SyncEntry } from "./entry.ts"
import { openBatch } from "./open.ts"
import { type ParsedBody, parseBody } from "./parse.ts"
import { createRejectionCounter } from "./rejection.ts"
import { checkRecordRules } from "./rules.ts"
import { deviceIdOf, verifyRecordSig } from "./signatures.ts"
import { importSnapshot, type SnapshotRecord } from "./snapshot.ts"
import { buildFork } from "./testing/fork.ts"
import { approvalEntry, fixtureRecoveryCredential, genesisEntry, headAfter, pairingTranscript, principalOf, verifiedGenesisFor } from "./testing/genesis.ts"
import { ACCOUNT, appendBatch, appendKeyring, chain, fixtureAnchor, keyringFor, record, recoverySigningSeed } from "./testing/sync-v1.test-support.ts"
import { b64urlDecode, b64urlEncode, sha256B64 } from "./vendor/sync-format/jcs.ts"

// #10742: Bun's WebCrypto verifies the identity key 01 00..00 with R = identity and S = 0 as valid for
// any message, so every verify site and every key admission must refuse a weak key itself.
const hex = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(value, "hex"))
const IDENTITY_KEY = hex(`01${"00".repeat(31)}`)
const IDENTITY_SIG = hex(`01${"00".repeat(63)}`)
const WEAK = b64urlEncode(IDENTITY_KEY)

const weakKeyring = async (): Promise<DeviceKeyring> => {
  const id = await deviceIdOf(WEAK)
  if (id === null) throw new Error("identity key does not decode")
  return {
    principal: () => ({ kind: "device", id }),
    publicKeys: () => ({ signing: WEAK, sealing: keyringFor("owner").publicKeys().sealing }),
    sign: async () => IDENTITY_SIG,
    unseal: async () => {
      throw new Error("a weak keyring opens nothing")
    },
  }
}

const run = (entries: ReadonlyArray<SyncEntry>, state: ChainState) => appendEntries(state, entries, createRejectionCounter())
const refusal = (outcome: Awaited<ReturnType<typeof run>>) => (outcome.ok ? "accepted" : outcome.reason)
const ff = "ff".repeat(30)
const generatedKey = (): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x ?? "", "base64url"))

describe("isStrongEd25519Key", () => {
  test.each([
    ["y = 0 (order 4)", "00".repeat(32)],
    ["y = 0, x negative (order 4)", `${"00".repeat(31)}80`],
    ["the identity (order 1)", `01${"00".repeat(31)}`],
    ["the identity with the sign bit set (non-canonical)", `01${"00".repeat(30)}80`],
    ["an order-8 point", "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"],
    ["its negation (order 8)", "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85"],
    ["the other order-8 point", "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"],
    ["its negation (order 8)", "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa"],
    ["y = p - 1 (order 2)", `ec${ff}7f`],
    ["y = p (non-canonical zero)", `ed${ff}7f`],
    ["y = p + 1 (non-canonical one)", `ee${ff}7f`],
    ["a y with no point on the curve", `02${"00".repeat(31)}`],
    ["a valid key plus an order-8 point (mixed order)", "c51fa063c8acd6d17172fca4b9ae09f9778af8826bb715f227930bbbd439cd1a"],
  ])("refuses %s", (_name, value) => {
    expect(hex(value).length).toBe(32)
    expect(isStrongEd25519Key(hex(value))).toBe(false)
  })

  test("accepts freshly generated keys and the fixture's real keys", () => {
    for (let i = 0; i < 20; i++) expect(isStrongEd25519Key(generatedKey())).toBe(true)
    for (const device of ["owner", "recovered"] as const) {
      expect(isStrongEd25519Key(b64urlDecode(keyringFor(device).publicKeys().signing))).toBe(true)
    }
  })
})

describe("isStrictEd25519Signature (design 0003: R canonical and not small-order, S < L)", () => {
  const L = 2n ** 252n + 27742317777372353535851937790883648493n
  const scalar = (value: bigint): string => Buffer.from(Array.from({ length: 32 }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn))).toString("hex")
  const realR = b64urlDecode(keyringFor("owner").publicKeys().signing)
  const r = Buffer.from(realR).toString("hex")
  test.each([
    ["R = identity", `01${"00".repeat(31)}${scalar(1n)}`],
    ["R of order 8", `26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05${scalar(1n)}`],
    ["R non-canonical (y = p + 1)", `ee${ff}7f${scalar(1n)}`],
    ["S = L", `${r}${scalar(L)}`],
    ["S = L + 1", `${r}${scalar(L + 1n)}`],
  ])("refuses %s", (_name, value) => {
    expect(hex(value).length).toBe(64)
    expect(isStrictEd25519Signature(hex(value))).toBe(false)
  })

  test("accepts a real signature's R with S below L", () => {
    expect(isStrictEd25519Signature(hex(`${r}${scalar(L - 1n)}`))).toBe(true)
  })
})

describe("every verify site refuses a signature under the identity key", () => {
  test("record signatures (keyring and batch entries) do not verify under it", async () => {
    const fields = { account: ACCOUNT, base_seq: 0, digest: "D".repeat(43), epoch: 1, link: "L".repeat(43), keyring_link: null, record_sig: b64urlEncode(IDENTITY_SIG) }
    expect(await verifyRecordSig(WEAK, fields)).toBe(false)
  })

  test("a genesis whose first device holds the identity key is refused", async () => {
    const weak = await weakKeyring()
    const genesis = await genesisEntry(ACCOUNT, weak, "W".repeat(43), await fixtureRecoveryCredential())
    expect(refusal(await run([genesis], emptyChain(ACCOUNT, creatorAnchor(ACCOUNT, weak))))).toBe("bad_signature")
  })

  test("a genesis enrolling the identity key as its recovery key is refused", async () => {
    const owner = keyringFor("owner")
    const honest = await genesisEntry(ACCOUNT, owner, "W".repeat(43), await fixtureRecoveryCredential())
    const bootstrap = Object(honest.body["bootstrap"])
    const forged = { ...bootstrap, recovery_key: { ...Object(bootstrap["recovery_key"]), signing_public_key: WEAK } }
    const custody = await genesisEntry(ACCOUNT, owner, "W".repeat(43), { seed: new Uint8Array(32), key: forged["recovery_key"] })
    const body = { ...custody.body, countersign: b64urlEncode(IDENTITY_SIG) }
    const genesis = await appendKeyring({ seq: 0, link: "", keyring_link: "" }, body, { keyring: owner }, custody.wraps)
    expect(refusal(await run([genesis], emptyChain(ACCOUNT, creatorAnchor(ACCOUNT, owner))))).toBe("weak_key")
  })

  test("a recovery-key record enrolling the identity key is refused", async () => {
    const genesis = await run([record("genesis")], emptyChain(ACCOUNT, fixtureAnchor()))
    if (!genesis.ok) throw new Error(`fixture genesis refused: ${genesis.reason}`)
    const enrolled = record("recovery_key")
    const body = { ...enrolled.body, signing_public_key: WEAK, countersign: b64urlEncode(IDENTITY_SIG) }
    const entry = await appendKeyring(headAfter(record("genesis")), body, { keyring: keyringFor("owner") }, enrolled.wraps)
    expect(refusal(await run([entry], genesis.state))).toBe("weak_key")
  })

  test("an object signed under the identity key is not opened", async () => {
    const weak = await weakKeyring()
    const epochKey = new Uint8Array(32).fill(7)
    const bytes = await buildBatch({
      account: ACCOUNT, kind: "ops", epoch: 1, epochKey, keyring: weak, peers: [], batchId: new Uint8Array(16).fill(1),
      salt: new Uint8Array(32).fill(2), createdAt: 1760000000000, records: [{ type: 1, spaceId: new Uint8Array(16), itemKey: "forged", body: new Uint8Array([1]) }],
    })
    const binding = { account: ACCOUNT, epoch: 1, authorId: weak.principal().id, signingPublicKey: WEAK, digest: await sha256B64(bytes), kind: "ops" as const }
    const opened = await openBatch(bytes, binding, epochKey, createRejectionCounter())
    expect(opened.ok ? "opened" : opened.reason).toBe("bad_key")
  })

  test("a snapshot signed under the identity key is not imported", async () => {
    const weak = await weakKeyring()
    const genesis = await genesisEntry(ACCOUNT, weak, "W".repeat(43), await fixtureRecoveryCredential())
    const epochKey = new Uint8Array(32).fill(9)
    const chunk = await buildBatch({
      account: ACCOUNT, kind: "snapshot", epoch: 1, epochKey, keyring: weak, peers: [], batchId: new Uint8Array(16).fill(3),
      salt: new Uint8Array(32).fill(4), createdAt: 1760000000000, chunk: { index: 0, count: 1 }, records: [{ type: 1, spaceId: new Uint8Array(16), itemKey: "forged", body: new Uint8Array([1]) }],
    })
    const snapshot: SnapshotRecord = {
      account: ACCOUNT, author: principalOf(weak), covers_seq: genesis.seq, digest: await sha256B64(b64urlDecode(await sha256B64(chunk))),
      link: genesis.link, keyring_head: genesis.keyring_link, record_sig: b64urlEncode(IDENTITY_SIG),
    }
    const imported = await importSnapshot(ACCOUNT, creatorAnchor(ACCOUNT, weak), [genesis], snapshot, [chunk], () => epochKey, createRejectionCounter())
    expect(imported.ok ? "imported" : imported.reason).toBe("keyring_prefix_refused")
  })
})

describe("no record brings a weak key into the keyring authority", () => {
  test("an approval admitting a device that holds the identity key is refused, so it can never sign a batch", async () => {
    const owner = keyringFor("owner")
    const state = await verifiedGenesisFor(owner, "W".repeat(43))
    const weak = await weakKeyring()
    const genesisHead = state.head
    if (genesisHead === null) throw new Error("empty chain")
    const approval = await approvalEntry(genesisHead, ACCOUNT, owner, weak, await pairingTranscript(ACCOUNT, weak), "J".repeat(43))
    const batch = await appendBatch(headAfter(approval), await sha256B64(new Uint8Array([1])), 1, weak)
    const outcome = await run([approval, batch], state)
    expect(refusal(outcome)).toBe("weak_key")
    expect(outcome.steps).toEqual([])
  })

  test("a recovery-join naming a device that holds the identity key is refused", async () => {
    const prefix = chain.main.slice(0, chain.main.indexOf("recovery_join")).map(record)
    const walked = await run(prefix, emptyChain(ACCOUNT, fixtureAnchor()))
    if (!walked.ok) throw new Error(`fixture prefix refused: ${walked.reason}`)
    const join = record("recovery_join")
    const weak = await weakKeyring()
    const body = { ...join.body, principal: principalOf(weak) }
    const credentialId = String(join.body["credential_id"])
    const last = prefix.at(-1)
    if (last === undefined) throw new Error("fixture prefix is empty")
    const entry = await appendKeyring(headAfter(last), body, { recoverySeed: await recoverySigningSeed("key1"), credentialId })
    expect(refusal(await run([entry], walked.state))).toBe("weak_key")
  })

  test("a weak key is refused ahead of the record's other refusals (precedence: weak_key first)", async () => {
    const walked = await run(chain.main.map(record), emptyChain(ACCOUNT, fixtureAnchor()))
    if (!walked.ok || walked.state.authority === null) throw new Error("fixture chain refused")
    const weak = principalOf(await weakKeyring())
    const approval: ParsedBody = { kind: "approval", principal: { ...weak, id: "X".repeat(22) }, wrapsDigest: "D".repeat(43), commitment: "C".repeat(43), joiningNonce: "N".repeat(22) }
    expect(await checkRecordRules(record("approval"), approval, walked.state.authority, walked.state.history, "")).toBe("weak_key")
  })

  test("a fork-resolution whose evidence branch, or stated state, carries a weak or malformed key is refused", async () => {
    const fork = await buildFork()
    const walked = await run([...fork.ancestry, fork.branchA], emptyChain(ACCOUNT, fixtureAnchor()))
    if (!walked.ok || walked.state.authority === null) throw new Error("fork ancestry refused")
    const authority = walked.state.authority
    const weak = principalOf(await weakKeyring())
    const inEvidence = await fork.resolution((evidence) => {
      const branch = evidence.branches[1]
      const first = branch?.records[0]
      if (branch !== undefined && first !== undefined) branch.records.push({ ...first, body: { kind: "approval", principal: weak } })
      return evidence
    })
    const malformed = await fork.resolution()
    const malformedBody = { ...malformed.body, state: { ...Object(malformed.body["state"]), members: [{ ...weak, signing_public_key: "AQ" }] } }
    for (const entry of [inEvidence, { ...malformed, body: malformedBody }]) {
      const body = parseBody(entry.body)
      if (body === null) throw new Error("fork-resolution body does not parse")
      expect(await checkRecordRules(entry, body, authority, walked.state.history, "")).toBe("weak_key")
    }
    const honest = await fork.resolution()
    const honestBody = parseBody(honest.body)
    if (honestBody === null) throw new Error("honest resolution does not parse")
    expect(await checkRecordRules(honest, honestBody, authority, walked.state.history, "")).toBeNull()
  })
})
