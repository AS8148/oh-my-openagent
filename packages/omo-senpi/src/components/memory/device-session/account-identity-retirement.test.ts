import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fixture = new URL("./account-identity.fixture.ts", import.meta.url).pathname

// #11737: real source/session/store code runs in a child with no access to the user's account state.
test.each(["replacement", "signing_rotation", "sealing_rotation", "aba", "resolution_change", "refresh"])(
  "captured account authority handles %s without changing credential generations silently",
  async (scenario) => {
    // Given: an isolated account-state directory, real generated keys and an in-memory OS store.
    const home = await mkdtemp(join(tmpdir(), "account-identity-"))
    try {
      // When: the real session changes credentials after the account source captures its authority.
      const child = Bun.spawn([process.execPath, fixture, scenario], {
        env: { ...process.env, HOME: home, TMPDIR: home, SENPI_CODING_AGENT_DIR: join(home, "agent") },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 45_000,
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])

      // Then: only an identity-preserving refresh can release a token for the captured account.
      expect(exit, stderr).toBe(0)
      expect(JSON.parse(stdout)).toEqual(
        scenario === "refresh" ? { refused: false, refreshed: true } : { refused: true, refreshed: false },
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  },
  60_000,
)
