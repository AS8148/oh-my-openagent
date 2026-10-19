import type { OmoGitMasterSettings } from "@oh-my-opencode/omo-config-core"
import {
  buildShellAwareGitPrefix,
  injectGitMasterConfig,
} from "@oh-my-opencode/skills-loader-core/opencode-skill-loader/git-master-template-injection"
import { detectShellType, type ShellType } from "@oh-my-opencode/skills-loader-core/shared/shell-env"

import { buildGitMasterAttributionDirective } from "./directive"

export type GitMasterShellType = ShellType

export const detectGitMasterShell: () => GitMasterShellType = detectShellType

export interface GitMasterSkillAdditions {
  readonly rewriteSkillText: (text: string) => string
  readonly directive: string | undefined
}

export function resolveGitMasterSkillAdditions(
  settings: OmoGitMasterSettings,
  shellType: GitMasterShellType,
): GitMasterSkillAdditions | undefined {
  const gitEnvPrefix = settings.git_env_prefix
  const shellPrefix = gitEnvPrefix === "" ? "" : buildShellAwareGitPrefix(gitEnvPrefix, shellType)
  const directive = buildGitMasterAttributionDirective(settings, shellPrefix)
  if (gitEnvPrefix === "" && directive === undefined) return undefined
  return {
    rewriteSkillText:
      gitEnvPrefix === ""
        ? (text) => text
        : (text) => injectGitMasterConfig(text, { commit_footer: false, git_env_prefix: gitEnvPrefix }, shellType),
    directive,
  }
}
