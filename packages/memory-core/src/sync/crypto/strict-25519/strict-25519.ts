/**
 * Strict Ed25519 and X25519 checks: the one source for both curves (design 0003 + prime-order keys).
 * Some runtimes (Bun 1.4.3, workerd) verify Ed25519 signatures under small-order keys, so every
 * check below runs before the runtime verifier, and the verdicts do not depend on the runtime.
 * Vendored byte-identical into other repositories; edit only here and re-pin every copy.
 *
 * Ed25519 key A: 32 bytes, y < p (never reduced), on the curve, not x = 0 with the sign bit set,
 * not small order ([8]A != O), prime order ([L]A = O).
 * Ed25519 signature R || S: 64 bytes, R passes the same point checks except prime order, S < L
 * (never reduced), then the runtime's cofactorless verifier.
 * X25519 key: 32 bytes, top bit clear, u < p, not one of the low-order u values (RFC 7748 6.1).
 * X25519 shared secret: an all-zero result is refused before key derivation.
 */
const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a: bigint): bigint => {
  const r = a % P;
  return r >= 0n ? r : r + P;
};
const pow = (base: bigint, exponent: bigint): bigint => {
  let result = 1n;
  let b = mod(base);
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
  }
  return result;
};
const D = mod(-121665n * pow(121666n, P - 2n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

const littleEndian = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i] ?? 0);
  return value;
};

/** Extended twisted Edwards coordinates (a = -1): x = X/Z, y = Y/Z, xy = T/Z. */
type Point = readonly [x: bigint, y: bigint, z: bigint, t: bigint];
const IDENTITY: Point = [0n, 1n, 1n, 0n];

/** Complete addition (add-2008-hwcd-3); valid for every pair of points, doubling included. */
const add = ([x1, y1, z1, t1]: Point, [x2, y2, z2, t2]: Point): Point => {
  const a = mod((y1 - x1) * (y2 - x2));
  const b = mod((y1 + x1) * (y2 + x2));
  const c = mod(2n * D * t1 * t2);
  const d = mod(2n * z1 * z2);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
};

const times = (k: bigint, point: Point): Point => {
  let result = IDENTITY;
  let addend = point;
  for (let n = k; n > 0n; n >>= 1n) {
    if (n & 1n) result = add(result, addend);
    addend = add(addend, addend);
  }
  return result;
};

const isIdentity = ([x, y, z]: Point): boolean => x === 0n && mod(y - z) === 0n;

/** RFC 8032 5.1.3 decoding without any reduction of y. */
const decode = (bytes: Uint8Array): Point | "non_canonical" | "off_curve" => {
  const sign = (bytes[31] ?? 0) >> 7;
  const y = littleEndian(bytes) & ((1n << 255n) - 1n);
  if (y >= P) return "non_canonical";
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = mod(u * pow(v, 3n) * pow(mod(u * pow(v, 7n)), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === mod(-u)) x = mod(x * SQRT_M1);
  else if (vx2 !== u) return "off_curve";
  if (x === 0n && sign === 1) return "non_canonical";
  if (Number(x & 1n) !== sign) x = P - x;
  return [x, y, 1n, mod(x * y)];
};

export type Ed25519KeyClass = "strong" | "bad_length" | "non_canonical" | "off_curve" | "small_order" | "mixed_order";

/** What a public key is; only "strong" (canonical, prime order L) proves possession. */
export const classifyEd25519Key = (bytes: Uint8Array): Ed25519KeyClass => {
  if (bytes.length !== 32) return "bad_length";
  const point = decode(bytes);
  if (typeof point === "string") return point;
  if (isIdentity(times(8n, point))) return "small_order";
  return isIdentity(times(L, point)) ? "strong" : "mixed_order";
};

const keyVerdicts = new Map<string, boolean>();
const KEY_VERDICTS_MAX = 4096;

/** True only for a strong key; verdicts are cached (bounded) because the order check costs a scalar multiple. */
export const isStrongEd25519Key = (bytes: Uint8Array): boolean => {
  if (bytes.length !== 32) return false;
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const known = keyVerdicts.get(id);
  if (known !== undefined) return known;
  const strong = classifyEd25519Key(bytes) === "strong";
  if (keyVerdicts.size >= KEY_VERDICTS_MAX) keyVerdicts.clear();
  keyVerdicts.set(id, strong);
  return strong;
};

export type StrictEd25519Result = { readonly ok: true } | { readonly ok: false; readonly refusal: "malformed" | "signature" };
const MALFORMED: StrictEd25519Result = { ok: false, refusal: "malformed" };

/** Every check that runs before the runtime verifier: key, R and S. */
export const ed25519SignaturePrecheck = (key: Uint8Array, sig: Uint8Array): StrictEd25519Result => {
  if (sig.length !== 64 || !isStrongEd25519Key(key)) return MALFORMED;
  const r = decode(sig.subarray(0, 32));
  if (typeof r === "string" || isIdentity(times(8n, r))) return MALFORMED;
  if (littleEndian(sig.subarray(32, 64)) >= L) return MALFORMED;
  return { ok: true };
};

/** The precheck, then the runtime's cofactorless Ed25519 verifier (WebCrypto). */
export const strictEd25519Verify = async (key: Uint8Array, sig: Uint8Array, message: Uint8Array): Promise<StrictEd25519Result> => {
  const pre = ed25519SignaturePrecheck(key, sig);
  if (!pre.ok) return pre;
  const publicKey = await crypto.subtle.importKey("raw", Uint8Array.from(key), { name: "Ed25519" }, false, ["verify"]);
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, Uint8Array.from(sig), Uint8Array.from(message));
  return valid ? { ok: true } : { ok: false, refusal: "signature" };
};

const X25519_LOW_ORDER: ReadonlySet<bigint> = new Set([
  0n,
  1n,
  325606250916557431795983626356110631294008115727848805560023387167927233504n,
  39382357235489614581723060781553021112529911719440698176882885853963445705823n,
  P - 1n,
]);

/** A registrable X25519 public key: 32 bytes, top bit clear, canonical u < p, not low order. */
export const isStrongX25519Key = (bytes: Uint8Array): boolean => {
  if (bytes.length !== 32 || ((bytes[31] ?? 0) & 0x80) !== 0) return false;
  const u = littleEndian(bytes);
  return u < P && !X25519_LOW_ORDER.has(u);
};

/** True for an all-zero X25519 shared secret, which a low-order peer key forces; refuse it before derivation. */
export const isZeroSharedSecret = (secret: Uint8Array): boolean => {
  let acc = 0;
  for (const byte of secret) acc |= byte;
  return secret.length === 0 || acc === 0;
};
