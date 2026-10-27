import { redactSecretLikeMaterial } from "../sync/redact"

/** One file (or, after a directory merge, one name shared by `files` files) and its newest commit time. */
export interface NamedFile {
  readonly name: string
  readonly time: number
  readonly files: number
}

/** One listed entry of a directory line: a name, a date group, or a pattern standing for hint-free names. */
export interface ProjectionItem {
  readonly text: string
  /** Files the entry stands for. */
  readonly files: number
  /** Newest commit time among those files; items are listed newest first. */
  readonly time: number
}

/** How a listed entry maps back to its file; the block opens with it. */
export const NAME_LEGEND =
  "Names drop \".md\" (a quoted name is exact); {a, b}-20261027 is a-20261027 and b-20261027; "
  + "\"x … y (N files)\" and <id> stand for similar names: read the directory to list them."

const MARKDOWN = ".md"
const DATE = /^(?:19|20)\d{6}$/
const YEAR = /^(?:19|20)\d{2}$/
const MONTH = /^(?:0[1-9]|1[0-2])$/
// A token after a date that names no topic: a number or clock time (0004, 2250z) or a part (p3).
const HINT_FREE = /^(?:\d+[a-z]?|p\d+)$/i
const DATE_SUFFIX = /^(.+)-((?:19|20)\d{6})$/
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const HEX_ID = /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}$/
const GENERATED = /^[A-Za-z0-9]{10,}$/
const MIN_FAMILY = 3
const MIN_RUN = 3
const ID = "<id>"
const naturally = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true })
const newestFirst = (a: ProjectionItem, b: ProjectionItem): number => {
  const delta = b.time - a.time
  return delta !== 0 && !Number.isNaN(delta) ? delta : a.text.localeCompare(b.text)
}

/**
 * The names in `names` that are generated ids: a UUID or a hex digest on their own, or a family of at least three
 * same-length letter-and-digit tokens (16-character random ids). A lone `iPhone15Pro` or `project2024` is never one.
 */
export function generatedIds(names: readonly string[]): ReadonlySet<string> {
  const ids = new Set(names.filter((name) => UUID.test(name) || HEX_ID.test(name)))
  const byLength = new Map<number, string[]>()
  for (const name of names) {
    if (!GENERATED.test(name) || !mixesClasses(name)) continue
    const family = byLength.get(name.length)
    if (family) family.push(name)
    else byLength.set(name.length, [name])
  }
  for (const family of byLength.values()) {
    if (family.length >= MIN_FAMILY) family.forEach((name) => ids.add(name))
  }
  return ids
}

function mixesClasses(name: string): boolean {
  return [/\d/, /[a-z]/, /[A-Z]/].filter((pattern) => pattern.test(name)).length >= 2
}

/** `a.md` lists as `a`; any other file keeps its exact name in quotes. Secret-like text is masked first. */
export function displayName(name: string): string {
  const safe = redactSecretLikeMaterial(name)
  return safe.endsWith(MARKDOWN) ? safe.slice(0, -MARKDOWN.length) : `"${safe}"`
}

/**
 * One directory's files as listed items, newest first. Hint-free runs (a shared prefix plus only a date, month chunk,
 * clock time or part; or generated ids) of at least three fold into one pattern when that is shorter than the list.
 * The other markdown names sharing a `-YYYYMMDD` suffix are grouped as `{a, b}-YYYYMMDD`.
 */
export function directoryItems(files: readonly NamedFile[]): ProjectionItem[] {
  const merged = mergeByName(files)
  const ids = generatedIds(merged.filter(isMarkdown).map((file) => stem(file.name)))
  const runs = new Map<string, NamedFile[]>()
  const plain: NamedFile[] = []
  for (const file of merged) {
    const key = runKey(file.name, ids)
    const run = key === undefined ? undefined : runs.get(key)
    if (key === undefined) plain.push(file)
    else if (run) run.push(file)
    else runs.set(key, [file])
  }
  const items: ProjectionItem[] = []
  for (const [key, members] of runs) {
    const folded = foldRun(key, members)
    if (folded) items.push(folded)
    else plain.push(...members)
  }
  items.push(...dateGroups(plain))
  return items.sort(newestFirst)
}

function mergeByName(files: readonly NamedFile[]): NamedFile[] {
  const byName = new Map<string, NamedFile>()
  for (const file of files) {
    const name = redactSecretLikeMaterial(file.name)
    const seen = byName.get(name)
    byName.set(name, seen
      ? { name, time: Math.max(seen.time, file.time), files: seen.files + file.files }
      : { ...file, name })
  }
  return [...byName.values()]
}

const isMarkdown = (file: NamedFile): boolean => file.name.endsWith(MARKDOWN)
const stem = (name: string): string => name.slice(0, -MARKDOWN.length)
const item = (file: NamedFile): ProjectionItem => ({ text: displayName(file.name), files: file.files, time: file.time })
const newest = (files: readonly { readonly time: number }[]): number => Math.max(...files.map((file) => file.time))
const count = (files: readonly { readonly files: number }[]): number => files.reduce((sum, file) => sum + file.files, 0)

/** What a hint-free name shares with its run (`<id>`, or the words before its date), or `undefined` for a hinted name. */
function runKey(name: string, ids: ReadonlySet<string>): string | undefined {
  if (!name.endsWith(MARKDOWN)) return undefined
  if (ids.has(stem(name))) return ID
  const tokens = stem(name).split("-")
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? ""
    const dateLength = DATE.test(token) ? 1 : YEAR.test(token) && MONTH.test(tokens[index + 1] ?? "") ? 2 : 0
    if (dateLength === 0) continue
    const tail = tokens.slice(index + dateLength)
    if (!tail.every((part) => HINT_FREE.test(part) || DATE.test(part))) return undefined
    return `${tokens.slice(0, index).join("-")}-`
  }
  return undefined
}

function foldRun(key: string, members: readonly NamedFile[]): ProjectionItem | undefined {
  if (members.length < MIN_RUN) return undefined
  const files = count(members)
  const names = members.map((member) => displayName(member.name)).sort(naturally)
  const text = key === ID ? `${ID} (${files} files)` : `${names[0]} … ${names[names.length - 1]} (${files} files)`
  const listed = Buffer.byteLength(names.join(", "))
  return Buffer.byteLength(text) < listed ? { text, files, time: newest(members) } : undefined
}

function dateGroups(files: readonly NamedFile[]): ProjectionItem[] {
  const groups = new Map<string, NamedFile[]>()
  const items: ProjectionItem[] = []
  for (const file of files) {
    const match = isMarkdown(file) && !/[{}]|, /.test(file.name) ? DATE_SUFFIX.exec(stem(file.name)) : null
    const date = match?.[2]
    if (date === undefined) {
      items.push(item(file))
      continue
    }
    const group = groups.get(date)
    if (group) group.push(file)
    else groups.set(date, [file])
  }
  for (const [date, members] of groups) {
    if (members.length < 2) {
      items.push(...members.map(item))
      continue
    }
    const listed = members.map(item).sort(newestFirst).map((entry) => entry.text.slice(0, -date.length - 1))
    items.push({ text: `{${listed.join(", ")}}-${date}`, files: count(members), time: newest(members) })
  }
  return items
}
