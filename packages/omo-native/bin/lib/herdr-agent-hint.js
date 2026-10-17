// herdr names the agent that owns a pane from the pane's foreground process (#10448). The engine
// runs as `bun …/cli.js` (or `node …/cli.js`), which herdr cannot place, so `herdr agent prompt`
// refused every OmO pane. HERDR_AGENT is the hint herdr reads from that process's environment; OmO
// is a pi-family agent to herdr, which already lists these panes as `pi`.
//
// The hint is only for the interactive engine a user sees in the pane: a print or protocol run
// does not take prompts there. An explicit HERDR_AGENT the user set is left alone. The plugin
// removes the hint from the engine's own environment once it loads, so the processes the engine
// starts never inherit it (herdr reads the hint from the exec'd environment, which that does not
// change).

const NON_INTERACTIVE_FLAGS = new Set(["-p", "--print", "--mode"])

export const HERDR_AGENT_LABEL = "pi"

export function withHerdrAgentHint(env, args) {
  if (env.HERDR_ENV !== "1") return env
  if (env.HERDR_AGENT !== undefined && env.HERDR_AGENT !== "") return env
  if (args.some((arg) => NON_INTERACTIVE_FLAGS.has(arg) || arg.startsWith("--mode="))) return env
  env.HERDR_AGENT = HERDR_AGENT_LABEL
  return env
}
