/** The per-repo changelog-gate config: the only file that differs between repos. */
export const GATE_CONFIG = {
  releaseBranchPattern: /^release\//,
  releaseActors: ["release-bot[bot]"],
  userFacingRoots: ["packages/", "crates/", "bin/", "script/"],
} as const;
