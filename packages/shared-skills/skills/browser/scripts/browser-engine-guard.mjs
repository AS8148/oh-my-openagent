import { readFile } from "node:fs/promises"

export const BROWSER_ENGINE_ENV = "OMO_BROWSER_ENGINE"

const TOOLKIT_TOOL = "omo_desktop_toolkit"
const BUILTIN_UNAVAILABLE = {
  unavailable: "this app does not offer its built-in browser to this session",
  timeout: "the app did not answer the request for its built-in browser",
  invalid_grant: "the app answered the request for its built-in browser with something unusable",
}

export class BuiltinBrowserUnavailableError extends Error {
  constructor(reason) {
    super(
      `OmO's built-in browser is not available here: ${BUILTIN_UNAVAILABLE[reason] ?? `the app refused it (${reason})`}. Every other browser works as usual: connectBrowserSkill() for the user's own browser, connectPipe() for a browser of your own.`,
    )
    this.name = "BuiltinBrowserUnavailableError"
    this.code = "browser_builtin_unavailable"
    this.reason = reason
  }
}

/**
 * Inside OmO Desktop (`OMO_BROWSER_ENGINE` set) the library is the terminal's own, unchanged, plus
 * `connectBuiltinBrowser()`: the app's built-in browser for this thread, the tab the user sees beside the chat.
 */
export function guardOmowright(raw, { env = process.env, host } = {}) {
  const engine = env[BROWSER_ENGINE_ENV]
  if (engine === undefined || engine === "") return raw

  const acquireBuiltinBrowser = async () => {
    let details
    try {
      details = (await host?.callTool(TOOLKIT_TOOL, { op: "acquire", toolkit: "browser" }))?.details
    } catch {
      details = undefined
    }
    if (details?.ok !== true) throw new BuiltinBrowserUnavailableError(typeof details?.reason === "string" ? details.reason : "unavailable")
    const token = (await readFile(details.grant.tokenFile, "utf8")).trim()
    return { endpoint: details.grant.endpoint, authorization: `Bearer ${token}` }
  }

  // A CDP endpoint that shows only this thread's tabs. The token is read from the file the grant names, so it never
  // passes through a tool result.
  const connectBuiltinBrowser = async (options = {}) => {
    let current = await acquireBuiltinBrowser()
    const authorizer = {
      async resolveAuthorization({ forceRefresh } = {}) {
        if (forceRefresh) current = await acquireBuiltinBrowser()
        return current.authorization
      },
    }
    return await raw.connect(current.endpoint, { ...options, client: { ...options.client, authorizer } })
  }

  return { ...raw, connectBuiltinBrowser }
}
