import { generateDeviceKeyMaterial } from "@oh-my-opencode/memory-core/keyring"
import { createCredentialStore, createSession, type Credentials } from "@oh-my-opencode/omo-opencode/service-auth"

import { createCliAccountSource } from "./account-source"

const scenario = process.argv[2]
const api = "https://account-identity.test.invalid"
const values = new Map<string, string>()
const store = createCredentialStore(api, {
  secrets: {
    get: async ({ service, name }) => values.get(`${service}:${name}`) ?? null,
    set: async ({ service, name, value }) => { values.set(`${service}:${name}`, value) },
    delete: async ({ service, name }) => values.delete(`${service}:${name}`),
  },
  platform: "darwin",
})
const credentials = (id: string): Credentials => {
  const keys = generateDeviceKeyMaterial()
  return {
    device: { id, name: "synthetic" },
    accessToken: `synthetic-access-${id}`,
    refreshToken: `synthetic-refresh-${id}`,
    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    signingPrivateKey: Buffer.from(keys.signingPrivatePkcs8, "base64url").toString("base64"),
    sealingPrivateKey: Buffer.from(keys.sealingPrivatePkcs8, "base64url").toString("base64"),
  }
}
const a = credentials("device-a")
const b = credentials("device-b")
const session = createSession({ api, store })
await session.save(a)
const doFetch: typeof fetch = Object.assign(
  async () => {
    if (scenario === "resolution_change") await session.save(b)
    return Response.json({ user: { id: "user-a" }, account: { id: "account-a" }, deviceId: "device-a" })
  },
  { preconnect: fetch.preconnect },
)
try {
  const account = await createCliAccountSource({ api, store, fetch: doFetch })()
  if (account === null) throw new Error("unexpected signed-out fixture")
  switch (scenario) {
    case "replacement":
      await session.save(b)
      break
    case "signing_rotation":
      await session.save({ ...a, signingPrivateKey: b.signingPrivateKey })
      break
    case "sealing_rotation":
      await session.save({ ...a, sealingPrivateKey: b.sealingPrivateKey })
      break
    case "aba":
      await session.save(b)
      await session.save(a)
      break
    case "refresh":
      await store.write({ ...a, accessToken: "synthetic-refreshed", refreshToken: "synthetic-refresh-next" })
      break
    case "resolution_change":
      break
    default:
      throw new Error("unknown fixture scenario")
  }
  const token = await account.accessToken()
  process.stdout.write(JSON.stringify({ refused: false, refreshed: token === "synthetic-refreshed" }))
} catch (error) {
  if (!(error instanceof Error) || error.name !== "AbortError") throw error
  process.stdout.write(JSON.stringify({ refused: true, refreshed: false }))
}
