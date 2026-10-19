// The legacy `gateway` -> `dori` rename runs once per machine, so it ships as the `#omo-dori-migration-runtime`
// sidecar instead of in the entry bundle. Startup imports it only when a config file the rename would rewrite still
// declares a `gateway` key; once migrated, that key is gone and later startups never load it.

import type { DoriSectionRename } from "@oh-my-opencode/omo-opencode/config-migration"

export type DoriSectionRenameLoader = () => Promise<DoriSectionRename>

export const DORI_MIGRATION_RUNTIME_ARTIFACT = "extensions/omo-dori-migration.js"

/** A cheap textual probe: a `"gateway":` key anywhere means the real rename must decide. */
export const mentionsLegacyGatewayKey = (text: string): boolean => /"gateway"\s*:/u.test(text)

/** Stands in for the rename when no config mentions the old section: the plan stays listed and is skipped. */
export const NO_DORI_SECTION_RENAME: DoriSectionRename = {
  shouldRun: () => false,
  transform: () => ({ diagnostics: [], document: {} }),
}

export const loadDoriSectionRename: DoriSectionRenameLoader = async () =>
  (await import("#omo-dori-migration-runtime")).doriSectionRename
