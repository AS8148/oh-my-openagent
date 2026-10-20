/**
 * Strict Ed25519 public-key validation (#10742). WebCrypto on Bun accepts a signature under a
 * small-order key: the identity key 01 00..00 with R = identity and S = 0 verifies for any message.
 * A key is accepted only when its 32 bytes are the canonical encoding of a curve point in the
 * prime-order subgroup: y < p, not x = 0 with the sign bit set, on the curve, [8]P is not the
 * identity (so none of the 8 small-order points), and [L]P is the identity (so no torsion part).
 */

const P = 2n ** 255n - 19n
const L = 2n ** 252n + 27742317777372353535851937790883648493n
const mod = (a: bigint): bigint => {
  const r = a % P
  return r >= 0n ? r : r + P
}
const pow = (base: bigint, exp: bigint): bigint => {
  let result = 1n
  let b = mod(base)
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = mod(result * b)
    b = mod(b * b)
  }
  return result
}
const inv = (a: bigint): bigint => pow(a, P - 2n)
const D = mod(-121665n * inv(121666n))
const SQRT_M1 = pow(2n, (P - 1n) / 4n)

/** Extended twisted Edwards coordinates (a = -1): x = X/Z, y = Y/Z, xy = T/Z. */
type Point = { readonly x: bigint; readonly y: bigint; readonly z: bigint; readonly t: bigint }
const IDENTITY: Point = { x: 0n, y: 1n, z: 1n, t: 0n }

const add = (p: Point, q: Point): Point => {
  const a = mod((p.y - p.x) * (q.y - q.x))
  const b = mod((p.y + p.x) * (q.y + q.x))
  const c = mod(2n * D * p.t * q.t)
  const d = mod(2n * p.z * q.z)
  const e = b - a
  const f = d - c
  const g = d + c
  const h = b + a
  return { x: mod(e * f), y: mod(g * h), z: mod(f * g), t: mod(e * h) }
}

const times = (point: Point, scalar: bigint): Point => {
  let result = IDENTITY
  let addend = point
  for (let k = scalar; k > 0n; k >>= 1n) {
    if (k & 1n) result = add(result, addend)
    addend = add(addend, addend)
  }
  return result
}

const isIdentity = (p: Point): boolean => mod(p.x) === 0n && mod(p.y - p.z) === 0n

/** The point a canonical 32-byte encoding names, or null for a non-canonical or off-curve one. */
const decode = (bytes: Uint8Array): Point | null => {
  const value = littleEndian(bytes)
  const sign = value >> 255n
  const y = value & ((1n << 255n) - 1n)
  if (y >= P) return null
  const u = mod(y * y - 1n)
  const v = mod(D * y * y + 1n)
  let x = mod(u * pow(v, 3n) * pow(mod(u * pow(v, 7n)), (P - 5n) / 8n))
  const vx2 = mod(v * x * x)
  if (vx2 === mod(-u)) x = mod(x * SQRT_M1)
  else if (vx2 !== u) return null
  if (x === 0n && sign === 1n) return null
  if ((x & 1n) !== sign) x = P - x
  return { x, y, z: 1n, t: mod(x * y) }
}

const littleEndian = (bytes: Uint8Array): bigint => {
  let value = 0n
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i] ?? 0)
  return value
}

/**
 * The signature half of the shared strict-verify rule (design 0003): R decodes canonically to a point
 * that is not of small order, and S < L. A runtime that already refuses these keeps doing so; this
 * makes the refusal independent of the runtime.
 */
export const isStrictEd25519Signature = (signature: Uint8Array): boolean => {
  if (signature.length !== 64) return false
  const r = decode(signature.subarray(0, 32))
  return r !== null && !isIdentity(times(r, 8n)) && littleEndian(signature.subarray(32)) < L
}

const verdicts = new Map<string, boolean>()
const VERDICTS_MAX = 4096

/** True when `bytes` is a 32-byte canonical encoding of a prime-order-subgroup point other than the identity. */
export const isStrongEd25519Key = (bytes: Uint8Array): boolean => {
  if (bytes.length !== 32) return false
  const id = Buffer.from(bytes).toString("hex")
  const known = verdicts.get(id)
  if (known !== undefined) return known
  const point = decode(bytes)
  const strong = point !== null && !isIdentity(times(point, 8n)) && isIdentity(times(point, L))
  if (verdicts.size >= VERDICTS_MAX) verdicts.clear()
  verdicts.set(id, strong)
  return strong
}
