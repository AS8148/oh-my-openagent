import { describe, expect, spyOn, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { startFakeHost } from "./__fixtures__/fake-host"
import { askHost } from "./host-request"
import { withContractHost, type ContractHost, type ContractHostOptions } from "./testing/contract-host"

const warm = (host: ContractHost) => Reflect.apply(askHost, undefined, [
  host.socket, { type: "warm", id: "warm-contract", cwd: host.root, kind: "worker" }, 2000, { keyRoot: host.root },
]) as ReturnType<typeof askHost>

describe.skipIf(process.platform === "win32")("POSIX raw task host challenge-response", () => {
  test("#given an enforcing authenticated host #when warm is sent #then authenticate succeeds before warm", async () => {
    await withContractHost({ auth: true }, async (host) => {
      expect(await warm(host)).toMatchObject({ success: true, data: { warmed: true } })
      expect(host.frames.map(({ frame }) => frame.type)).toEqual(["get_protocol_info", "authenticate", "warm"])
      expect(host.frames[0].frame).toMatchObject({ observe: true, auth: { client_nonce: expect.stringMatching(/^[0-9a-f]{64}$/) } })
      const record = JSON.parse(readFileSync(host.recordPath, "utf8")) as { key: string }
      expect(JSON.stringify(host.frames)).not.toContain(record.key)
    })
  })

  test("#given a today host #when warm runs #then no authenticate is sent", async () => {
    await withContractHost({ legacy: true }, async (host) => {
      expect(await warm(host)).toMatchObject({ success: true })
      expect(host.frames.some(({ frame }) => frame.type === "authenticate")).toBe(false)
    })
  })

  test("#given a wrong server proof #when warm runs #then the connection closes without sending client proof or warm", async () => {
    await withContractHost({ auth: true, badProof: true }, async (host) => {
      await expect(warm(host)).rejects.toThrow("host_identity_unproven")
      expect(host.frames.map(({ frame }) => frame.type)).toEqual(["get_protocol_info"])
    })
  })

  const unsafe: readonly [string, NonNullable<ContractHostOptions["prepareRecord"]>][] = [
    ["file mode", (path) => chmodSync(path, 0o644)],
    ["directory mode", (_path, root) => chmodSync(`${root}/rpc/keys`, 0o755)],
    ["key root mode", (_path, root) => chmodSync(root, 0o755)],
    ["symlink", (path, root) => { const bytes = readFileSync(path); rmSync(path); writeFileSync(`${root}/record`, bytes, { mode: 0o600 }); symlinkSync(`${root}/record`, path) }],
    ["directory record", (path) => { rmSync(path); mkdirSync(path, { mode: 0o700 }) }],
    ["unreadable mode", (path) => chmodSync(path, 0o000)],
    ["invalid JSON", (path) => writeFileSync(path, "not-json")],
    ["short key", (path) => { const row = JSON.parse(readFileSync(path, "utf8")); row.key = "ab"; writeFileSync(path, JSON.stringify(row)) }],
    ["wrong launch", (path) => { const row = JSON.parse(readFileSync(path, "utf8")); row.launch_id = "00000000-0000-4000-8000-000000000000"; writeFileSync(path, JSON.stringify(row)) }],
    ["wrong version", (path) => { const row = JSON.parse(readFileSync(path, "utf8")); row.version = 2; writeFileSync(path, JSON.stringify(row)) }],
  ]
  test.each(unsafe)("#given unsafe key record: %s #when warm runs #then it refuses without fallback", async (_name, prepareRecord) => {
    await withContractHost({ auth: true, prepareRecord }, async (host) => {
      await expect(warm(host)).rejects.toThrow("unsafe_key_record")
      expect(host.frames.map(({ frame }) => frame.type)).toEqual(["get_protocol_info"])
    })
  })

  test("#given records belonging to another uid #when warm runs #then ownership is refused", async () => {
    await withContractHost({ auth: true }, async (host) => {
      const uid = process.getuid!()
      const getuid = spyOn(process, "getuid").mockReturnValue(uid + 1)
      try {
        await expect(warm(host)).rejects.toThrow("unsafe_key_record")
        expect(host.frames.map(({ frame }) => frame.type)).toEqual(["get_protocol_info"])
      } finally { getuid.mockRestore() }
    })
  })

  test("#given a missing record #when an enforcing host challenges #then grace logs the remedy and surfaces auth_required", async () => {
    await withContractHost({ auth: true, prepareRecord: (path) => rmSync(path) }, async (host) => {
      const warning = spyOn(console, "error").mockImplementation(() => undefined)
      try {
        const reply = await warm(host)
        expect(reply).toMatchObject({ success: false, error: "auth_required" })
        expect(warning.mock.calls.flat().join(" ")).toContain("SENPI_RPC_KEY_ROOT")
        expect(host.frames.map(({ frame }) => frame.type)).toEqual(["get_protocol_info", "warm"])
      } finally { warning.mockRestore() }
    })
  })
})

test.skipIf(process.platform !== "win32")("#given a Windows task host #when warm is sent #then the raw pipe secret transport remains unchanged", async () => {
  const host = await startFakeHost()
  try {
    const reply = await askHost(host.socketPath, { type: "warm", id: "warm-contract", cwd: process.cwd(), kind: "worker" }, 2000)
    expect(reply).toMatchObject({ success: true, data: { state: "warmed" } })
    expect(host.commands.map((command) => command.type)).toEqual(["warm"])
  } finally {
    await host.stop()
  }
})
