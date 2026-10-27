export const MEMORY_TOOL_NAME = "memory"

export const MEMORY_TOOL_DESCRIPTION = [
  "A convenience tool for memories stored in the omo memory repo that automatically commits changes.",
  "",
  "Supported operations: create, str_replace, insert, delete, rename, update_description, and apply_patch.",
  "apply_patch accepts Codex-style multi-file or multi-hunk patches through the input field.",
  "",
  "Memory files are markdown documents with YAML frontmatter. Paths must remain inside the memory repo.",
  "Time-boxed content goes in its own system/ file with frontmatter `expires: <ISO 8601>` (a UTC date like 2026-10-28, or an instant with Z or an offset like 2026-10-27T06:33Z); it stops being projected at that instant. Write it with apply_patch (an Add File whose content starts with the frontmatter, including description and expires). Never mark a section of a larger file as temporary.",
  "read_only blocks cannot be modified. Commits are authored with the bound omo memory identity; the harness will sync after the turn.",
].join("\n")
