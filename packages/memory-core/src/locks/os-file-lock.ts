// flock(2) through bun:ffi, so liveness can be answered by the kernel instead of by reading other
// processes' /proc entries (omo #10322). A flock belongs to the open file description: every
// process that inherits the descriptor keeps it held, and the kernel drops it when the last such
// process exits, SIGKILL included. Only non-blocking attempts are made, so the JS thread never
// waits inside the kernel.

const LOCK_SH = 1
const LOCK_EX = 2
const LOCK_NB = 4

const LIBC_CANDIDATES: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ["/usr/lib/libSystem.B.dylib"],
  linux: ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1", "libc.so"],
}

type Flock = (fd: number, operation: number) => number

let flockLookup: Promise<Flock | null> | null = null

async function openFlock(): Promise<Flock | null> {
  const candidates = LIBC_CANDIDATES[process.platform]
  if (candidates === undefined) return null
  let ffi: typeof import("bun:ffi")
  try {
    ffi = await import("bun:ffi")
  } catch {
    return null
  }
  for (const name of candidates) {
    try {
      const library = ffi.dlopen(name, { flock: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 } })
      return (fd, operation) => Number(library.symbols.flock(fd, operation))
    } catch {
      continue
    }
  }
  return null
}

function loadFlock(): Promise<Flock | null> {
  flockLookup ??= openFlock()
  return flockLookup
}

export async function osFileLockAvailable(): Promise<boolean> {
  return (await loadFlock()) !== null
}

export type OsLockAttempt = "acquired" | "busy" | "unavailable"

async function attempt(fd: number, mode: number): Promise<OsLockAttempt> {
  const flock = await loadFlock()
  if (flock === null) return "unavailable"
  return flock(fd, mode | LOCK_NB) === 0 ? "acquired" : "busy"
}

export function tryLockShared(fd: number): Promise<OsLockAttempt> {
  return attempt(fd, LOCK_SH)
}

export function tryLockExclusive(fd: number): Promise<OsLockAttempt> {
  return attempt(fd, LOCK_EX)
}
