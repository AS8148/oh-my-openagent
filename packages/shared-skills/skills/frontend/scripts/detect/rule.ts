import type { DetectConfig, ElementSnapshot, PageSnapshot, RuleMeta, SourceFile } from "./types"

export type PageHit = {
	readonly element: ElementSnapshot | null
	readonly message: string
	readonly snippet: string
}

export type PageContext = {
	readonly snapshot: PageSnapshot
	readonly config: DetectConfig
}

export type PageRule = {
	readonly meta: RuleMeta & { readonly engine: "page" }
	readonly check: (ctx: PageContext) => readonly PageHit[]
}

export type SourceHit = {
	readonly line: number
	readonly column: number
	readonly message: string
	readonly snippet: string
}

export type SourceContext = {
	readonly file: SourceFile
	readonly config: DetectConfig
}

export type SourceRule = {
	readonly meta: RuleMeta & { readonly engine: "source" }
	/** File extensions (without the dot) this rule reads, e.g. ["css", "scss", "tsx"]. */
	readonly extensions: readonly string[]
	readonly check: (ctx: SourceContext) => readonly SourceHit[]
}

export type Rule = PageRule | SourceRule
