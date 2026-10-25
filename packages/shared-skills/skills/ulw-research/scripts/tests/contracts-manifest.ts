import { SCHEMA_VERSION } from "../contracts.mjs"

export function sampleManifest() {
	return {
		schemaVersion: SCHEMA_VERSION,
		sessionDir: "/tmp/session/20260101-120000",
		startedAt: "2026-01-01T12:00:00.000Z",
		finishedAt: null,
		elapsedMinutes: null,
		lane: "no-format",
		interview: null,
		deliverables: [
			{ format: "pdf", status: "pending", promised: true, updatedAt: "2026-01-01T12:00:00.000Z" },
		],
		renders: [],
		gates: { static: "not_run", fidelity: "not_run", layout: "not_run", visual: "not_run", proofread: "not_run" },
		residualDefects: [],
		repair: null,
		sources: null,
	}
}
