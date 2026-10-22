import type { Provenance } from "./types"

/** The worker boundary also serves JavaScript callers, not just typed engine requests. */
export function isProvenance(value: unknown): value is Provenance {
  if (typeof value !== "object" || value === null) return false
  return "workspace" in value && typeof value.workspace === "string" && value.workspace.trim().length > 0
    && "project" in value && typeof value.project === "string" && value.project.trim().length > 0
    && (!("lane" in value) || value.lane === undefined || typeof value.lane === "string")
    && (!("session" in value) || value.session === undefined || typeof value.session === "string")
}

/** Insert-only: existing JSON remains readable and receivers can update historical delivery state. */
export const PROVENANCE_MIGRATION = [
  `CREATE TRIGGER deliveries_require_provenance BEFORE INSERT ON deliveries
    WHEN CASE WHEN json_valid(NEW.envelope) THEN
      coalesce(json_type(NEW.envelope, '$.provenance'), '') != 'object'
      OR coalesce(json_type(NEW.envelope, '$.provenance.workspace'), '') != 'text'
      OR coalesce(length(trim(json_extract(NEW.envelope, '$.provenance.workspace'))), 0) = 0
      OR coalesce(json_type(NEW.envelope, '$.provenance.project'), '') != 'text'
      OR coalesce(length(trim(json_extract(NEW.envelope, '$.provenance.project'))), 0) = 0
      OR coalesce(json_type(NEW.envelope, '$.provenance.lane'), 'text') != 'text'
      OR coalesce(json_type(NEW.envelope, '$.provenance.session'), 'text') != 'text'
    ELSE 1 END
    BEGIN SELECT RAISE(ABORT, 'delivery provenance is required'); END`,
  "INSERT INTO extension_objects (type, name, owner) VALUES ('trigger', 'deliveries_require_provenance', NULL)",
] as const
