import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { copyRepo, runKnip, unusedExports } from "./knip-run.ts";

// Next.js route-segment config exports are read by the framework from the app directory's special files, so knip must
// not report them, while a genuinely unused export of the same file must still be reported. The recognition is scoped
// (script/knip-next-route-segment-exports.ts, configured in knip.jsonc preprocessorOptions.nextRouteSegmentExports), so
// this test adds a NEW page to a repo copy rather than relying on a file named in any ignore list.

const KNIP_TIMEOUT_MS = 600_000;
const PROBE = "packages/web/app/design/zz-knip-route-segment-probe/page.tsx";
const SOURCE = [
  "export const revalidate = 60;",
  'export const dynamic = "force-dynamic";',
  "export const zzUnusedProbe = 1;",
  "export default function Page() {",
  "  return null;",
  "}",
  "",
].join("\n");

describe("knip recognises Next.js route-segment config exports", () => {
  test(
    "a new page's revalidate is not reported, an unrelated unused export of the same page still is",
    async () => {
      const copy = await copyRepo();
      try {
        mkdirSync(dirname(join(copy, PROBE)), { recursive: true });
        await Bun.write(join(copy, PROBE), SOURCE);
        const { stdout, stderr } = await runKnip(copy, ["--reporter", "json"]);
        const unused = unusedExports(copy, stdout, stderr);
        expect(unused.has(`${PROBE}#zzUnusedProbe`)).toBe(true);
        expect([...unused].filter((row) => row === `${PROBE}#revalidate` || row === `${PROBE}#dynamic`)).toEqual([]);
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    },
    KNIP_TIMEOUT_MS,
  );
});
