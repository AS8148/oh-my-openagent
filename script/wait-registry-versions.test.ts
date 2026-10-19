import { describe, expect, test } from "bun:test"
import { pendingPackages, waitForRegistryVersions, type RegistryFetch } from "./wait-registry-versions.mjs"

const registry = (served: Record<string, string>): RegistryFetch => async (url) => {
  const name = decodeURIComponent(new URL(url).pathname.split("/")[1] ?? "")
  const version = served[name]
  return version === undefined ? new Response("not found", { status: 404 }) : Response.json({ name, version })
}

describe("wait-registry-versions", () => {
  test("#given one package npm never served #when the window closes #then it fails naming only that package", async () => {
    const result = await waitForRegistryVersions({
      packages: ["omo-ai", "oh-my-openagent", "oh-my-openagent-linux-x64"],
      version: "5.1.38",
      attempts: 3,
      delayMs: 0,
      fetchImpl: registry({ "omo-ai": "5.1.38", "oh-my-openagent-linux-x64": "5.1.38" }),
      log: () => {},
    })
    expect(result).toEqual({ ok: false, pending: ["oh-my-openagent"] })
  })

  test("#given a package that lands on the second probe #when waiting #then it succeeds", async () => {
    let calls = 0
    const late: RegistryFetch = async () => {
      calls++
      return calls === 1 ? new Response("", { status: 404 }) : Response.json({ version: "5.1.38" })
    }
    const result = await waitForRegistryVersions({ packages: ["oh-my-openagent"], version: "5.1.38", attempts: 3, delayMs: 0, fetchImpl: late, log: () => {} })
    expect(result.ok).toBe(true)
  })

  test("#given the registry serves a different version #when checked #then the package is still pending", async () => {
    expect(await pendingPackages(["omo-ai"], "5.1.38", registry({ "omo-ai": "5.1.37" }))).toEqual(["omo-ai"])
  })

  test("#given a no-cache read #when probing #then the request asks the registry to bypass caches", async () => {
    const seen: { headers?: Record<string, string> }[] = []
    await pendingPackages(["omo-ai"], "5.1.38", async (_url, init) => {
      seen.push(init ?? {})
      return Response.json({ version: "5.1.38" })
    })
    expect(seen[0]?.headers?.["Cache-Control"]).toBe("no-cache")
  })
})
