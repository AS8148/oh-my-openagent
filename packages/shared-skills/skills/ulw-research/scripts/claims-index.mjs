// claims-index.mjs - deterministic index of claim-graph.md: the one Markdown table whose header
// names claim_id, statement, risk tier, and status, plus the ids listed under the
// `## verified-claims` digest. Pure function of the text; node: builtins only.

const CLAIM_ID = /^C\d+$/
const REQUIRED_COLUMNS = Object.freeze({ claim_id: "claim_id", statement: "statement", risk: "risk tier", status: "status" })

/** Split one table line on unescaped pipes; drops the leading and trailing border cells. */
function splitRow(line) {
	const cells = []
	let current = ""
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index]
		if (char === "\\" && line[index + 1] === "|") {
			current += "|"
			index += 1
		} else if (char === "|") {
			cells.push(current)
			current = ""
		} else current += char
	}
	cells.push(current)
	const trimmed = cells.map((value) => value.trim())
	if (line.trim().startsWith("|")) trimmed.shift()
	if (line.trim().endsWith("|")) trimmed.pop()
	return trimmed
}

function normalizeHeader(value) {
	return value.replace(/`/g, "").trim().toLowerCase().replace(/[\s_]+/g, " ")
}

function columnIndexes(header) {
	const names = header.map(normalizeHeader)
	const indexes = {}
	for (const [key, name] of Object.entries(REQUIRED_COLUMNS)) indexes[key] = names.indexOf(normalizeHeader(name))
	return Object.values(indexes).every((index) => index >= 0) ? indexes : null
}

function isSeparator(line) {
	return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)
}

function verifiedIds(lines) {
	const ids = []
	let inside = false
	for (const line of lines) {
		const heading = /^(#{1,6})\s+(.*)$/.exec(line)
		if (heading) {
			inside = normalizeHeader(heading[2]) === "verified-claims"
			continue
		}
		if (!inside) continue
		for (const match of line.matchAll(/\bC\d+\b/g)) if (!ids.includes(match[0])) ids.push(match[0])
	}
	return ids
}

/** @returns {{ claims: { claim_id: string, statement: string, risk: string, status: string, in_verified: boolean }[], errors: string[] }} */
export function indexClaims(markdown) {
	const lines = markdown.split(/\r?\n/)
	const errors = []
	const headerAt = lines.findIndex((line) => line.trim().startsWith("|") && columnIndexes(splitRow(line)) !== null)
	if (headerAt < 0) {
		return { claims: [], errors: ["no claim table: a Markdown table with claim_id, statement, risk tier, and status columns is required"] }
	}
	const header = splitRow(lines[headerAt])
	const columns = columnIndexes(header)
	if (!isSeparator(lines[headerAt + 1] ?? "")) errors.push(`line ${headerAt + 2}: claim table header must be followed by a separator row`)
	const rows = []
	let tableEnd = headerAt + 2
	for (let index = headerAt + 2; index < lines.length && lines[index].trim().startsWith("|"); index += 1) {
		tableEnd = index + 1
		const cells = splitRow(lines[index])
		const at = `line ${index + 1}`
		if (cells.length !== header.length) {
			errors.push(`${at}: expected ${header.length} cells, found ${cells.length}`)
			continue
		}
		const claimId = cells[columns.claim_id].replace(/`/g, "")
		if (!CLAIM_ID.test(claimId)) {
			errors.push(`${at}: claim_id "${claimId}" must match C<n>`)
			continue
		}
		if (rows.some((row) => row.claim_id === claimId)) {
			errors.push(`${at}: duplicate claim_id ${claimId}`)
			continue
		}
		rows.push({ claim_id: claimId, statement: cells[columns.statement], risk: cells[columns.risk], status: cells[columns.status] })
	}
	const verified = verifiedIds(lines.slice(0, headerAt).concat(lines.slice(tableEnd)))
	for (const id of verified) {
		if (!rows.some((row) => row.claim_id === id)) errors.push(`verified-claims lists ${id}, which has no claim row`)
	}
	const claims = rows.map((row) => ({ ...row, in_verified: verified.includes(row.claim_id) }))
	return { claims, errors }
}
