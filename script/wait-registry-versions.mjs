#!/usr/bin/env node
// Waits until every named package serves EXACTLY the given version from the npm registry, read with
// no-cache so a cached 404 cannot hide a landed version, and fails once the bounded window closes.
// npm answers a publish with 202 "being processed" and can still drop it server-side: 5.1.38's
// oh-my-openagent printed "+ oh-my-openagent@5.1.38" and never appeared, while the old check only
// waited on omo-ai and the run went green. Every published package has to be read back.

export async function pendingPackages(packages, version, fetchImpl = fetch) {
  const pending = []
  for (const name of packages) {
    const url = `https://registry.npmjs.org/${name}/${encodeURIComponent(version)}`
    let served = null
    try {
      const response = await fetchImpl(url, { headers: { "Cache-Control": "no-cache", Accept: "application/json" }, cache: "no-store" })
      if (response.status === 200) served = (await response.json()).version ?? null
    } catch {
      served = null
    }
    if (served !== version) pending.push(name)
  }
  return pending
}

export async function waitForRegistryVersions({ packages, version, attempts, delayMs, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
  let pending = [...packages]
  for (let attempt = 1; attempt <= attempts; attempt++) {
    pending = await pendingPackages(pending, version, fetchImpl)
    if (pending.length === 0) {
      log(`all ${packages.length} packages serve ${version} (attempt ${attempt}/${attempts})`)
      return { ok: true, pending: [] }
    }
    log(`waiting for ${pending.length} package(s) at ${version} (attempt ${attempt}/${attempts}): ${pending.join(" ")}`)
    if (attempt < attempts) await sleep(delayMs)
  }
  return { ok: false, pending }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, ...packages] = process.argv.slice(2)
  if (!version || packages.length === 0) {
    console.error("usage: node script/wait-registry-versions.mjs <version> <package...>")
    process.exit(2)
  }
  const attempts = Number(process.env.REGISTRY_WAIT_ATTEMPTS ?? 240)
  const delayMs = Number(process.env.REGISTRY_WAIT_DELAY_SECONDS ?? 15) * 1000
  const result = await waitForRegistryVersions({ packages, version, attempts, delayMs })
  if (!result.ok) {
    console.log(`::error::npm never served ${version} for: ${result.pending.join(" ")}. publish printed success for each, so npm accepted and then dropped or held them; check https://www.npmjs.com/package/<name> and npm support before re-running.`)
    process.exit(1)
  }
}
