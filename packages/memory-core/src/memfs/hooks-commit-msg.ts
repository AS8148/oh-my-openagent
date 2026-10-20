// Claim receipt guard (#10488, lead ruling on #10498): the `provenance` frontmatter header is written only by the memory
// tool, which re-derives it from a verified claim. A commit that ADDS or CHANGES the header in a memory note must carry
// the memory tool's `Omo-Writer: memory-tool` trailer; otherwise the commit is refused, so a hand-written "user said"
// header cannot enter the repository by text. Unchanged headers (body edits, renames, normalisation), removed headers
// (removal only lowers trust) and a merge that brings in a header exactly as committed on the merged branch pass.
// Memory sync writes with commit-tree and runs no hooks. The trailer is a convention: a deliberate `git commit` that
// forges it still passes; a non-forgeable signal is a tracked follow-up.
// It runs as commit-msg because only that hook sees the message. POSIX sh; no shell `${...}` (this is String.raw).
export const COMMIT_MSG_HOOK_SCRIPT = String.raw`#!/bin/sh
# Refuse a hand-written claim receipt header in memory notes. Installed by omo memory-core; regenerated on startup.
grep -q '^Omo-Writer: memory-tool$' "$1" && exit 0

git_dir=$(git rev-parse --git-dir)
merge_head=""
[ -f "$git_dir/MERGE_HEAD" ] && merge_head=$(head -1 "$git_dir/MERGE_HEAD")
TAB=$(printf '\t')

provenance_of() {
  # $1 = file content. Prints the top-level provenance value, or nothing.
  closing=$(printf '%s\n' "$1" | tail -n +2 | grep -n '^---$' | head -1 | cut -d: -f1)
  [ -z "$closing" ] && return 0
  printf '%s\n' "$1" | tail -n +2 | head -n $((closing - 1)) | grep '^provenance:' | head -1 | cut -d: -f2- | sed 's/^ *//;s/ *$//'
}

refused=$(
  git diff --cached -M --name-status --diff-filter=ACMR |
    while IFS="$TAB" read -r status first second; do
      case "$status" in (R*) old="$first"; file="$second" ;; (*) old="$first"; file="$first" ;; esac
      printf '%s\n' "$file" | grep -qE '^(memory/)?(system|reference|people)/.*\.md$' || continue
      staged=$(provenance_of "$(git show ":$file" 2>/dev/null)")
      [ -z "$staged" ] && continue
      [ "$staged" = "$(provenance_of "$(git show "HEAD:$old" 2>/dev/null)")" ] && continue
      if [ -n "$merge_head" ]; then
        [ "$staged" = "$(provenance_of "$(git show "$merge_head:$file" 2>/dev/null)")" ] && continue
      fi
      printf '  %s: the provenance header is a claim receipt only the memory tool writes; remove that line (or save the note with the memory tool)\n' "$file"
    done
)
if [ -n "$refused" ]; then
  echo "Claim receipt validation failed:"
  printf '%s\n' "$refused"
  exit 1
fi
exit 0
`
