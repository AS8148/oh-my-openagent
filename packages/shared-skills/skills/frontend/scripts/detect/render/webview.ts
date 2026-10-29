import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { collectPageSnapshot, SCRIPT_ERROR_PROBE } from "../snapshot/collect"
import { STYLE_PROPS } from "../snapshot/style-props"
import type { PageSnapshot } from "../types"
import { CONTENT_STRESS_SCRIPT, RenderError, type RenderRequest, type Renderer } from "./renderer"

const MAX_ELEMENTS = 20_000

function withProbe(html: string): string {
	const probe = `<script>${SCRIPT_ERROR_PROBE}</script>`
	if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${probe}`)
	return `${probe}${html}`
}

function isSnapshot(value: unknown): value is PageSnapshot {
	return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "elements"))
}

/** A renderer backed by Bun.WebView (system WebKit on macOS, installed Chrome/Chromium elsewhere). One view per request. */
export function createWebViewRenderer(options: { readonly backend?: "webkit" | "chrome" } = {}): Renderer {
	const scratch = mkdtempSync(join(tmpdir(), "frontend-detect-"))
	let counter = 0
	return {
		async render(request: RenderRequest): Promise<PageSnapshot> {
			const label = request.target.kind === "url" ? request.target.url : "inline html"
			const view = new Bun.WebView({
				width: request.viewport.width,
				height: request.viewport.height,
				...(options.backend ? { backend: options.backend } : {}),
			})
			try {
				if (request.target.kind === "url") await view.navigate(request.target.url)
				else {
					const file = join(scratch, `page-${counter++}.html`)
					writeFileSync(file, withProbe(request.target.html))
					await view.navigate(pathToFileURL(file).href)
				}
				await view.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true")
				if (request.contentStress) await view.evaluate(CONTENT_STRESS_SCRIPT)
				const snapshot: unknown = await view.evaluate(`(${collectPageSnapshot.toString()})(${JSON.stringify(STYLE_PROPS)}, ${MAX_ELEMENTS})`)
				if (!isSnapshot(snapshot)) throw new Error("the page did not return a snapshot")
				return snapshot
			} catch (error) {
				throw new RenderError(label, error)
			} finally {
				await view.close()
			}
		},
		async close(): Promise<void> {
			rmSync(scratch, { recursive: true, force: true })
		},
	}
}
