import type { PluginInput } from "@opencode-ai/plugin"
import { HOOK_NAME, BLOCKED_TOOLS, PATCH_TOOLS, PLANNING_CONSULT_WARNING, PLANNING_CONTEXT_OPEN, PROMETHEUS_WORKFLOW_REMINDER } from "./constants"
import { log } from "../../shared/logger"
import { replaceToolArgs } from "../../shared/replace-tool-args"
import { getAgentDisplayName } from "../../shared/agent-display-names"
import { getAgentFromSession } from "./agent-resolution"
import { isPrometheusAgent } from "./agent-matcher"
import { resolveAllowedFile } from "./path-policy"

const TASK_TOOLS = ["task", "call_omo_agent"]

// Mirror OpenCode's LF splitting and prefix/slice/trim semantics, not JS regex line terminators:
// https://github.com/anomalyco/opencode/blob/32f278b48f1a495611165d8a9f1ace0b512933e2/packages/opencode/src/patch/index.ts#L66-L96
// parsePatch splits on "\n" at L187; CR, U+2028 and U+2029 remain part of the header remainder.
const PATCH_PATH_HEADERS = ["*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:"]

/**
 * Every path an apply_patch body touches (added, updated, deleted and move targets), or undefined
 * when a body or mutation header cannot be classified, which the caller treats as blocked.
 */
function patchedPaths(args: Record<string, unknown>) {
  const field = ["patchText", "input", "patch"].find(key => typeof args[key] === "string")
  if (field === undefined) return undefined
  const paths: { path: string; line: number; prefix: string }[] = []
  const lines = (args[field] as string).trim().split("\n")
  let inUpdateBody = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Only an unindented "***" ends executor Update chunks; leading spaces are context.
    if (inUpdateBody && !line.startsWith("***")) continue
    inUpdateBody = false
    const header = PATCH_PATH_HEADERS.find((prefix) => line.startsWith(prefix))
    if (header !== undefined) {
      const path = line.slice(header.length).trim()
      if (!path) return undefined
      paths.push({ path, line: i, prefix: header })
      if (header === "*** Update File:") {
        inUpdateBody = true
        if (lines[i + 1]?.startsWith("*** Move to:")) {
          const destination = lines[++i].slice("*** Move to:".length).trim()
          if (!destination) return undefined
          paths.push({ path: destination, line: i, prefix: "*** Move to:" })
        }
      }
    } else if (
      line.trimStart().startsWith("***") &&
      !["*** Begin Patch", "*** End Patch", "*** End of File"].includes(line.trim())
    ) {
      // Includes indented headers: the executor does not classify them, so fail closed.
      return undefined
    }
  }
  return { field, lines, paths }
}

/** The file a write/edit-class call targets plus a hashline `rename` destination, or undefined. */
function writeTargets(args: Record<string, unknown>) {
  const field = ["filePath", "file_path", "path", "file"].find(
    key => typeof args[key] === "string" && (args[key] as string).length > 0,
  )
  if (field === undefined) return undefined
  const paths = [{ field, path: args[field] as string }]
  if (typeof args.rename === "string" && args.rename.length > 0) paths.push({ field: "rename", path: args.rename })
  return paths
}

function blockedWriteError(path: string): Error {
  return new Error(
    `[${HOOK_NAME}] Prometheus is a planning agent. File operations restricted to .omo/*.md plan files only. ` +
    `Do NOT route this change through a subagent either - delegated implementation is still implementation. ` +
    `Record the intended change as a todo in the plan; implementation starts only when the user runs /ulw-execute. ` +
    `Attempted to modify: ${path}.`
  )
}

export function createPrometheusMdOnlyHook(ctx: PluginInput) {
  return {
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown>; message?: string }
    ): Promise<void> => {
      const agentName = await getAgentFromSession(input.sessionID, ctx.directory, ctx.client)

      if (!isPrometheusAgent(agentName)) {
        return
      }

      const toolName = input.tool

      // Inject planning-only warning for task tools called by Prometheus
       if (TASK_TOOLS.includes(toolName)) {
         const prompt = output.args.prompt as string | undefined
         if (prompt && !prompt.includes(PLANNING_CONTEXT_OPEN)) {
           replaceToolArgs(output, { prompt: PLANNING_CONSULT_WARNING + prompt })
          log(`[${HOOK_NAME}] Injected planning warning to ${toolName}`, {
            sessionID: input.sessionID,
            tool: toolName,
            agent: agentName,
          })
        }
        return
      }

      const isPatchTool = PATCH_TOOLS.includes(toolName)
      if (!isPatchTool && !BLOCKED_TOOLS.includes(toolName)) {
        return
      }

      // Fail closed: a file-writing call whose target this guard cannot read is blocked, never let through.
      const patch = isPatchTool ? patchedPaths(output.args) : undefined
      const targets = isPatchTool ? patch?.paths : writeTargets(output.args)
      const resolved = targets?.map(target => ({
        target,
        path: resolveAllowedFile(target.path, ctx.directory),
      }))
      const blockedPath =
        resolved === undefined ? "(unrecognized file argument)" : resolved.find(entry => entry.path === undefined)?.target.path
      if (blockedPath !== undefined) {
        log(`[${HOOK_NAME}] Blocked: Prometheus can only write to .omo/*.md`, {
          sessionID: input.sessionID,
          tool: toolName,
          filePath: blockedPath,
          agent: agentName,
        })
        throw blockedWriteError(blockedPath)
      }
      const replacements: Record<string, string> = {}
      for (const entry of resolved ?? []) {
        if (entry.path === undefined) throw blockedWriteError(entry.target.path)
        if ("line" in entry.target && patch) {
          patch.lines[entry.target.line] = entry.target.prefix + entry.path
        } else if ("field" in entry.target) {
          replacements[entry.target.field] = entry.path
        }
      }
      if (patch) replacements[patch.field] = patch.lines.join("\n")
      replaceToolArgs(output, replacements)
      if (isPatchTool) return
      const filePath = targets?.[0]?.path ?? ""

      const normalizedPath = filePath.toLowerCase().replace(/\\/g, "/")
      if (normalizedPath.includes(".omo/plans/") || normalizedPath.includes(".omo\\plans\\")) {
        log(`[${HOOK_NAME}] Injecting workflow reminder for plan write`, {
          sessionID: input.sessionID,
          tool: toolName,
          filePath,
          agent: agentName,
        })
        output.message = (output.message || "") + PROMETHEUS_WORKFLOW_REMINDER
      }

      log(`[${HOOK_NAME}] Allowed: .omo/*.md write permitted`, {
        sessionID: input.sessionID,
        tool: toolName,
        filePath,
        agent: agentName,
      })
    },
  }
}
