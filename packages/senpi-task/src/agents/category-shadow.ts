import type { OmoConfig } from "@oh-my-opencode/omo-config-core"

import { BUILTIN_AGENT_NAMES } from "./builtin/names"

/**
 * `categories.<name>` keys that equal a known agent name. A `task(subagent_type: <name>)` spawn never
 * reads `categories.*`; only `agents.<name>` reaches agent resolution, so such a key is silently dead
 * for that agent (#10323). Diagnose only: resolution does not alias the category onto the agent.
 * Builtin names come from a prompt-free list so the eager extension entry can call this.
 */
export function categoryShadowedAgentNames(config: OmoConfig, agentNames: Iterable<string> = []): readonly string[] {
  const agents = new Set([...BUILTIN_AGENT_NAMES, ...Object.keys(config.agents ?? {}), ...agentNames])
  return Object.keys(config.categories ?? {}).filter((name) => agents.has(name))
}

export function categoryShadowMessage(name: string): string {
  return `categories."${name}" is not read for subagent_type "${name}" spawns; put its model chain under agents."${name}".models`
}
