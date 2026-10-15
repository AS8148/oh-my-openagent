// Insert-only text merge (sync-design §3 adoption): the result is a common supersequence
// of the base and the incoming text — the base's characters are never deleted, and the
// incoming text's novel characters are inserted where an LCS alignment places them.
// Identical inputs return the base unchanged ("identical adoption adds nothing").
// Placement adapts to how alike the texts are: near-copies of one text merge at code-point
// granularity so a small edit lands in place, while mostly disjoint texts (two files
// folding into one item) merge at line granularity so each side's lines stay intact. The
// DPs run under a cell budget; past it, lines; past that, plain concatenation — always a
// common supersequence.

export function isOrderedSubsequence(needle: string, haystack: string): boolean {
  const n = [...needle]
  let i = 0
  for (const ch of haystack) {
    if (i < n.length && ch === n[i]) i++
  }
  return i === n.length
}

const DEFAULT_MAX_CELLS = 16_000_000

export function mergeInsertions(base: string, incoming: string, maxCells = DEFAULT_MAX_CELLS): string {
  if (base === incoming) return base
  if (base === "") return incoming
  if (incoming === "") return base
  const a = [...base]
  const b = [...incoming]
  if ((a.length + 1) * (b.length + 1) <= maxCells) {
    let pre = 0
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
    let suf = 0
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
    const anchors = lcs(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf))
    const shared = pre + anchors.length + suf
    if (2 * shared >= Math.min(a.length, b.length)) {
      const middle = supersequence(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf), anchors)
      return a.slice(0, pre).join("") + middle.join("") + a.slice(a.length - suf).join("")
    }
  }
  const la = splitLines(base)
  const lb = splitLines(incoming)
  if ((la.length + 1) * (lb.length + 1) <= maxCells) return supersequence(la, lb, lcs(la, lb)).join("")
  return base + incoming
}

function splitLines(text: string): string[] {
  if (text === "") return []
  return text.split(/(?<=\n)/)
}

function supersequence(a: readonly string[], b: readonly string[], anchors: readonly string[]): string[] {
  const out: string[] = []
  let i = 0
  let j = 0
  for (const anchor of anchors) {
    while (i < a.length && a[i] !== anchor) out.push(a[i++] ?? "")
    while (j < b.length && b[j] !== anchor) out.push(b[j++] ?? "")
    out.push(anchor)
    i++
    j++
  }
  while (i < a.length) out.push(a[i++] ?? "")
  while (j < b.length) out.push(b[j++] ?? "")
  return out
}

function lcs(a: readonly string[], b: readonly string[]): string[] {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  const at = (i: number, j: number) => dp[i * w + j] ?? 0
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const x = a[i]
    if (x !== undefined && x === b[j]) {
      out.push(x)
      i++
      j++
    } else if (at(i + 1, j) >= at(i, j + 1)) i++
    else j++
  }
  return out
}
