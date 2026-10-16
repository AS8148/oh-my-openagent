// Builtin agent names without their prompt-bearing definitions, for the eager extension entry.
// builtin-agents.test.ts keeps this equal to Object.keys(BUILTIN_AGENTS).
export const BUILTIN_AGENT_NAMES: readonly string[] = [
  "explore",
  "librarian",
  "plan-consultant",
  "plan-reviewer",
  "omo-native-code-reviewer",
  "omo-native-qa-executor",
  "omo-native-gate-reviewer",
]
