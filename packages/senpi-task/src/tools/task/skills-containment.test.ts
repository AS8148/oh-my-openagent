import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { loadSkillsFromDir } from "@code-yeongyu/senpi"
import { createFsSkillLoader } from "./skills"
import { buildTaskExecute } from "./execute"
import { CTX, createFakeManager, makeDeps } from "./__fixtures__/task-tool-fakes"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "task-skill-containment-"))
  roots.push(root)
  const cwd = join(root, "project")
  const homeDir = join(root, "home")
  const outside = join(root, "outside")
  for (const dir of [cwd, homeDir, outside]) mkdirSync(dir)
  mkdirSync(join(cwd, ".git"))
  writeFileSync(join(outside, "SKILL.md"), "---\nname: indirect\ndescription: fixture\n---\nSYNTHETIC PRIVATE BODY\n")
  return { root, cwd, homeDir, outside }
}

test.each(["folder", "file", "root"])("task direct read blocks an escaping project %s with reason", (layout) => {
  // given
  const f = fixture()
  const skills = join(f.cwd, ".senpi", "skills")
  mkdirSync(dirname(skills), { recursive: true })
  if (layout === "root") symlinkSync(f.outside, skills)
  else {
    mkdirSync(skills)
    if (layout === "folder") symlinkSync(f.outside, join(skills, "escape"))
    else symlinkSync(join(f.outside, "SKILL.md"), join(skills, "escape.md"))
  }
  const loader = createFsSkillLoader({ homeDir: f.homeDir, loadSkillsFromDir })
  // when
  const result = loader([layout === "root" ? "indirect" : "escape"], f.cwd)
  // then
  expect(result.prepend).not.toContain("SYNTHETIC PRIVATE BODY")
  expect(JSON.stringify(result)).toContain("outside the project")
})

test("task discovered read cannot use a project symlink's frontmatter name to escape", () => {
  // given
  const f = fixture()
  const skills = join(f.cwd, ".agents", "skills")
  mkdirSync(skills, { recursive: true })
  symlinkSync(f.outside, join(skills, "alias"))
  const loader = createFsSkillLoader({ homeDir: f.homeDir, loadSkillsFromDir })
  // when
  const result = loader(["indirect"], f.cwd)
  // then: the link's target is never read, so its frontmatter name cannot match and the request stays missing
  // rather than borrowing the "alias" link's block as its reason (#10693 review L1)
  expect(result.resolved).toEqual([])
  expect(result.prepend).not.toContain("SYNTHETIC PRIVATE BODY")
  expect(JSON.stringify(result)).not.toContain("outside the project")
})

test("task reports a nonexistent skill missing instead of another skill's blocked link", () => {
  // given: one escaping link next to the requested name that does not exist (#10693 review L1)
  const f = fixture()
  const skills = join(f.cwd, ".agents", "skills")
  mkdirSync(skills, { recursive: true })
  symlinkSync(f.outside, join(skills, "escape"))
  const loader = createFsSkillLoader({ homeDir: f.homeDir, loadSkillsFromDir })
  // when
  const ghost = loader(["ghost"], f.cwd)
  const escape = loader(["escape"], f.cwd)
  // then
  expect(ghost.resolved).toEqual([])
  expect(JSON.stringify(ghost)).not.toContain("outside the project")
  expect(JSON.stringify(escape)).toContain("outside the project")
})

test("task user discovery retains user scope and unrestricted user links", () => {
  // given
  const f = fixture()
  const userSkills = join(f.homeDir, ".agents", "skills")
  mkdirSync(userSkills, { recursive: true })
  symlinkSync(f.outside, join(userSkills, "alias"))
  const sources: string[] = []
  const loader = createFsSkillLoader({
    homeDir: f.homeDir,
    loadSkillsFromDir: (options) => {
      sources.push(options.source)
      return loadSkillsFromDir(options)
    },
  })
  // when
  const result = loader(["indirect"], f.cwd)
  // then
  expect(result.resolved).toEqual(["indirect"])
  expect(sources).toContain("user")
})

test("task tool result exposes a rejected skill's reason instead of reporting it missing", async () => {
  // given
  const f = fixture()
  const skills = join(f.cwd, ".senpi", "skills")
  mkdirSync(skills, { recursive: true })
  symlinkSync(f.outside, join(skills, "escape"))
  const manager = createFakeManager({
    start: async () => ({ kind: "started", task_id: "st_00000016", status: "running", name: "fixture" }),
  })
  const execute = buildTaskExecute(makeDeps(manager, {
    loadSkills: createFsSkillLoader({ homeDir: f.homeDir, loadSkillsFromDir }),
  }))
  // when
  const result = await execute("blocked-skill", {
    prompt: "synthetic task", category: "quick", load_skills: ["escape"], run_in_background: true,
  }, undefined, undefined, { ...CTX, cwd: f.cwd })
  // then
  const text = result.content[0]?.type === "text" ? result.content[0].text : ""
  expect(text).toContain("outside the project")
  expect(text).not.toContain("Missing skills: escape")
})
