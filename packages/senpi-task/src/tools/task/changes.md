## 2026-10-22 - Preserve project skill discovery rules (#10693)

Project discovery loads SKILL.md per folder and markdown files only at the search
root. It stops at a skill folder, including the search root itself, so nested
README and reference documents are never prepended as skills. Containment checks
still run before reading project paths.
