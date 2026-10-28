import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

// The keychain helper's designated requirement; test/keychain-helper-doctor.test.ts pins it equal to the one the
// helper is built for (packages/omo-native/keychain-helper/build.ts).
export const KEYCHAIN_HELPER_REQUIREMENT =
  'identifier "com.mengmota.omo-keychain-helper" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] ' +
  'and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "523JNR86LZ"'

const verifyWithCodesign = (path) =>
  spawnSync("/usr/bin/codesign", ["--verify", "--strict", `-R=${KEYCHAIN_HELPER_REQUIREMENT}`, path], { stdio: "ignore" }).status === 0

/**
 * The one place a missing or damaged keychain helper is reported (#11262 addendum Q1/row 9): normal output stays silent
 * and sign-in takes the previous path, so this is a warning, never a failure. macOS only.
 */
export function keychainHelperDoctorLines({ packageRoot, platform = process.platform, exists = existsSync, verify = verifyWithCodesign }) {
  if (platform !== "darwin") return []
  const helper = join(packageRoot, "bin", "darwin", "omo-keychain")
  if (!exists(helper))
    return ["WARN keychain helper: missing bin/darwin/omo-keychain; macOS sign-in uses the previous keychain path and may ask for access again. Reinstall omo."]
  if (!verify(helper))
    return ["WARN keychain helper: bin/darwin/omo-keychain failed its signature check and is never run; reinstall omo."]
  return ["PASS keychain helper: bin/darwin/omo-keychain (signed)"]
}
