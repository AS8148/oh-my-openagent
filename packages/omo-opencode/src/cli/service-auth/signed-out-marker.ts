import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"

// `omo logout` leaves this non-secret marker next to the account state (#11434): an OS store that reads empty
// while it is not ready looks exactly like a removed item, so only the marker says the sign-out was deliberate.
const markerSchema = z.object({ device: z.string().nullable(), at: z.string() })
export type SignedOutMarker = z.infer<typeof markerSchema>

export const signedOutMarkerPath = (home: string, credential: string): string =>
  join(home, ".omo", "account-state", `${credential}.signed-out.json`)

export async function readSignedOutMarker(path: string): Promise<SignedOutMarker | null> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
  return markerSchema.parse(JSON.parse(text))
}

export async function writeSignedOutMarker(path: string, device: string | null): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const staging = `${path}.${process.pid}.tmp`
  await writeFile(staging, JSON.stringify({ device, at: new Date().toISOString() } satisfies SignedOutMarker), { mode: 0o600 })
  await rename(staging, path)
}

export const clearSignedOutMarker = (path: string): Promise<void> => rm(path, { force: true })
