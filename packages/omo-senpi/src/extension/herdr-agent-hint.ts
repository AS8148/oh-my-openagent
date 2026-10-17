// The launcher sets HERDR_AGENT for the interactive engine so herdr can prompt its pane (#10448;
// omo-native bin/lib/herdr-agent-hint.js). herdr reads it from the engine process's exec'd
// environment, which this does not change; removing it here keeps every process the engine starts
// (shell commands, an external editor, child engines) from inheriting it. herdr's own guidance is
// that the hint applies only to the one foreground process it was set for, and an inherited copy
// would let `herdr agent prompt` type into, say, an editor the engine opened in the pane.
export function releaseHerdrAgentHint(env: NodeJS.ProcessEnv = process.env): void {
  delete env.HERDR_AGENT
}
