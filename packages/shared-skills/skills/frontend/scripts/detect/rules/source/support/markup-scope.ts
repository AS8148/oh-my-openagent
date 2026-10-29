export function tagAt(text: string, index: number): string {
	for (const m of text.matchAll(/<[a-z][\w:.-]*(?:[^"'`{}>]|"[^"]*"|'[^']*'|`[^`]*`|\{(?:[^{}]|\{[^{}]*\})*\})*>/gi)) {
		if ((m.index ?? 0) <= index && index <= (m.index ?? 0) + m[0].length) return m[0]
	}
	return text
}

export function exclusiveScopes(text: string): readonly string[] {
	let quote = ""
	let depth = 0
	let question = -1
	let targetDepth = 0
	let nested = 0
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (quote) {
			if (ch === "\\") i++
			else if (ch === quote) quote = ""
		} else if (ch === '"' || ch === "'" || ch === "`") quote = ch
		else if (ch === "{" || ch === "(") depth++
		else if (ch === "}" || ch === ")") depth--
		else if (ch === "?" && !/[?.]/.test(text[i - 1] ?? "") && !/[?.]/.test(text[i + 1] ?? "")) {
			if (question < 0) { question = i; targetDepth = depth }
			else if (depth === targetDepth) nested++
		} else if (ch === ":" && question >= 0 && depth === targetDepth) {
			if (nested > 0) { nested--; continue }
			let end = i + 1
			let innerDepth = depth
			let innerQuote = ""
			for (; end < text.length; end++) {
				const c = text[end]
				if (innerQuote) {
					if (c === "\\") end++
					else if (c === innerQuote) innerQuote = ""
				} else if (c === '"' || c === "'" || c === "`") innerQuote = c
				else if (c === "{" || c === "(") innerDepth++
				else if (c === "}" || c === ")") innerDepth--
				else if (c === "," && innerDepth === targetDepth) break
			}
			return [text.slice(question + 1, i), text.slice(i + 1, end)].flatMap((part) => exclusiveScopes(part).map((arm) => text.slice(0, question) + arm + text.slice(end)))
		}
	}
	return [text]
}

export function solidBackground(scope: string, gray = false): string | null {
	for (const m of scope.matchAll(/\bbg-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(\d+)\b/g)) {
		const at = m.index ?? 0
		const prefix = scope.slice(0, at).split(/\s/).at(-1) ?? ""
		const state = /(?:^|:)(?:!?hover|focus(?:-visible|-within)?|active|visited|disabled|checked|open|enabled|invalid|placeholder|group-[^:]*|peer-[^:]*|aria-[^:]*|data-[^:]*):$/.test(prefix)
		if (scope[at + m[0].length] !== "/" && !state && (!gray || Number(m[1]) >= 200)) return m[0]
	}
	return null
}
