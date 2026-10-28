import { callHelper, type HelperCall, type HelperLease, type HelperReply, type HelperSpawner, spawnDetachedHelper } from "./client"
import { locateHelper } from "./location"
import { createSignatureChecker, type SignatureVerdict } from "./signature"

export type HelperAccess =
  | { readonly kind: "ready"; readonly path: string; readonly call: (call: HelperCall, lease?: HelperLease) => Promise<HelperReply> }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly rejected: readonly string[] }

/**
 * The only way the store reaches a helper process: a path is spawned only after it passed the designated-requirement
 * check, so an unsigned, ad-hoc-signed or tampered copy at any candidate path is never executed.
 */
export async function resolveHelperAccess(
  candidates: readonly string[],
  options: { readonly verify?: (path: string) => Promise<SignatureVerdict>; readonly spawn?: HelperSpawner } = {},
): Promise<HelperAccess> {
  const location = await locateHelper(candidates, options.verify ?? createSignatureChecker())
  if (location.kind !== "found") return location
  const spawn = options.spawn ?? spawnDetachedHelper
  return {
    kind: "ready",
    path: location.path,
    call: (call, lease) => callHelper(location.path, call, { spawn, ...(lease === undefined ? {} : { lease }) }),
  }
}
