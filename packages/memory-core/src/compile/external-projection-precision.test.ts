import { describe, expect, it } from "bun:test"
import { groupDirectories } from "./external-projection-dirs"
import { directoryItems, type NamedFile } from "./external-projection-names"

// File names are the hint: hiding a meaningful name is the failure, an unfolded id only costs a few tokens.
// MUST-NOT-FOLD: the review's examples, real names from two memory repositories, and common naming shapes.
const MUST_NOT_FOLD: readonly string[] = [
  "ProjectPlan", "MeetingNote", "DesignSpecs", "project2024", "meeting2025", "roadmap2026", "AcmeCorpUS",
  "GlobexInc1", "InitechLLC", "cafe2026",
  "README", "MEMORY", "TAXONOMY", "USER", "ARCHIVE", "SKILL", "card", "bugwatch-resume-20261023-1400Z",
  "effort-per-model-handoff-20261023-1540Z", "release-progress-20261017-0330KST",
  "senpi-upstream-v1-sync-L1-lane-20261002", "jev-storm-node-capability-axisF-20260921", "delivery-20260920",
  "devday-live-20260930", "pricing-sim-20261013", "auth-incident-20261017", "ops-lessons-20261021",
  "omo-sync-20260926", "bunshin-audit-20260824", "skills-cleanup-20260912", "history-2026-10",
  "bun-144-pin-20261025", "claude-haiku-5-5", "qbt-skill-20260929", "1password", "umask077", "ed25519", "react19",
  "electron44", "fable51", "opus55", "bun143", "fetch128", "bash32", "t3code", "haiku55", "ubuntu26", "node18",
  "2point0", "issue12", "revision2", "phase0", "dori-logo-approved-version-20261027",
  "prompt-cache-ttl-and-seat-affinity-20261026",
  "meetingNotesDraft", "designSpecReview", "ProjectAlphaPlan", "QuarterlyReviewQ3", "project_plan_2026",
  "release_notes_v2", "quarterly-review-2026", "budget-2026-q3", "roadmap2027", "budget2026q3", "deadbeef",
  "facade2024", "decade2026", "deadbeefcafe2026", "beef1234", "OAuth2ClientIDv2", "XMLHttpRequest", "TTSRHtmlTags",
  "HTTPSProxyConfig", "KubernetesCRDv1beta1", "IPv6DualStackPlan", "HTML5CanvasNotes", "GitHubActions2024",
  "iPhone15ProMax", "MacBookProM5Max", "Q4OKRPlanning2026", "readUInt16BE", "readUInt16LE", "readUInt32BE",
  "hkdf32Sha256", "includesCtrlC",
]

// MUST-FOLD: the routine id directories of a real memory mirror, UUIDs, and long hex digests.
const MUST_FOLD: readonly string[] = [
  "WiTJd7hdMOcvppAY", "Y2Gw9vTZ9pnH2K5a", "87U3F2ZseCw7bLMz", "2Fc9uTN3x7DPCCxs", "wcjyAab9yeccko3U",
  "soGao0XSJE6wRt0J", "lBaLsRBYTlx6LgRs", "5IcMoSJd5PnXvx3h", "t4HAYklcxHCYXK7o", "lkXkxLlNrXTOtxtG",
  "OGA3sYRWtReI3rZZ", "xiiIFULqBVxtbvvl", "NW2sUpGrIeaGKIet", "9TuPENCX913g7lMs", "uRCVxrAwHN6uzlWR",
  "5GgEzKLiPiC0txrs", "EUn01XmAFeVHMXui", "adiADzIITRSbT264", "DnOBaqeqU2l9yBXd", "4g8zrKAnzJXW6PNY",
  "86rPvoSqCh92A54c", "QXwpL6fxh3RJCbJm", "8MdLdx02RRWqpQ80", "NonmDnfGsX2x0u76", "7IvF7P0RTcuLoPc4",
  "JTU7hjKLyqNhOQix", "7BMNGMTjN0dwgu8k", "HameqnJzxQWWoRL4", "M35Vc9W5nguYFMnx", "qwdbxHvtIPOQO4NY",
  "OoaxGpI6dEs9BEj4", "fQxEpdDAeAIOaa0D", "PjEeqWh6In4nwpk7", "njD7LhUhjyNtsc6c", "XpTHKRroIBYxc5em",
  "P3hWjRcYBMJpa4S2", "3xT5c4MqchOt5NKk", "NaNpOQ9AEw6UIr5m", "Fm59REYMOXsdmN5i", "kGbLtm46xxJ5c4U9",
  "WjckScSNxcNWMxW5", "tbrSF5f952JL5e3E", "JpgmrwwY8hF8o1dB", "QCNhgVrxYEa33HnY", "c5trARx5LbMePCh3",
  "06fwU9k5LQcSBvGR", "WceEXlx1ALVinBQZ", "niUfhbca7qbqLQz3", "hG55maxi5Q1owqjm", "Qs4sKVqMY5rVVuk1",
  "4Lpb8C0sk9eCPze5", "LRZ6vjz79mDkSa0H", "NPJEpvFBOVsV0qV8", "YWIvPoWolGY89IFm", "hJWq1KDBNNvxs6kH",
  "aFiiSahlrfT1GI1W", "yVfZCw3LOB1mmcF6", "dIqOyg3U0XlIvNzP", "ofEsS41pHazZDJ6W", "t1fAfVXpiHIDC5Nh",
  "jG8YULIYj1IETsQ8", "uK2VQLc2nR49jehL", "gQEsaXD1YHF61biV", "sy87P7rObQpW6YJ0", "t36xoxkrQ8Z9AyIz",
  "a8bEQHp3IYAwZllJ", "nMQlomHnfCqCuvnl", "lzX031Co8XPKa11v", "rddRlSayfp2Q1AZs", "jIvbHnW6ERuhTn9r",
  "Ii29wfPbNGyzOMlG", "9xEN9l0kW9S79kkE",
  "0b6e3c1a-2d4f-4e8a-9b1c-3d5e7f9a1b2c", "1c7f4d2b-3e5a-4f9b-8c2d-4e6f8a0b2c3d",
  "2d8a5e3c-4f6b-4a0c-9d3e-5f7a9b1c3d4e",
  "2898cea8ffefb2554d95f3a3b96424f574f3eee9", "9e107d9d372bb6826bd81d3542a419d6", "a0e94eed4f0da066",
]

const files = (names: readonly string[]): NamedFile[] => names.map((name) => ({ name: `${name}.md`, time: 0, files: 1 }))
const byName = (a: string, b: string): number => a.localeCompare(b)

describe("generated-id fold precision", () => {
  const table: ReadonlyArray<{ readonly column: string; readonly names: readonly string[]; readonly items: readonly string[]; readonly dirs: readonly string[] }> = [
    { column: "MUST-NOT-FOLD", names: MUST_NOT_FOLD, items: MUST_NOT_FOLD, dirs: MUST_NOT_FOLD.map((name) => `ids/${name}/`) },
    { column: "MUST-FOLD", names: MUST_FOLD, items: [`<id> (${MUST_FOLD.length} files)`], dirs: [`ids/<id>/ (${MUST_FOLD.length} dirs)`] },
  ]

  for (const row of table) {
    it(`#given the ${row.column} names in one directory #when listed as files #then the items are exact`, () => {
      // given
      const listed = files(row.names)

      // when
      const items = directoryItems(listed).map((item) => item.text)

      // then
      expect([...items].sort(byName)).toEqual([...row.items].sort(byName))
    })

    it(`#given the ${row.column} names as sibling directories #when grouped #then the line labels are exact`, () => {
      // given
      const paths = row.names.map((name, index) => `ids/${name}/note-${index}.md`)

      // when
      const labels = groupDirectories(paths, undefined).map((group) => group.label)

      // then
      expect([...labels].sort(byName)).toEqual([...row.dirs].sort(byName))
    })
  }
})
