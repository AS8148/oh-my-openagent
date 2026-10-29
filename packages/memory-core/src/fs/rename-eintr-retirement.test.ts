import { expect, test } from "bun:test"

test("retirement fences the raw rename below the composed EINTR retry", async () => {
  // Given/when: a separate process holds the raw syscall and retires before releasing EINTR.
  const child = Bun.spawn([
    process.execPath,
    new URL("./rename-eintr-retirement.fixture.ts", import.meta.url).pathname,
  ], { stdout: "pipe", stderr: "pipe", timeout: 45_000 })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  // Then: the production resilient composition cannot replay the raw syscall.
  expect(exit, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ published: false, aborted: true, syscalls: 1 })
}, 60_000)
