import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

function userCacheRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (platform === "darwin") return join(home, "Library", "Caches")
  if (platform === "win32") return env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, "AppData", "Local")
  return env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home, ".cache")
}

/**
 * Shell children inherit process.env, so Python run by the agent writes its bytecode under an OmO
 * cache folder instead of next to the script: a bundled skill's __pycache__ inside the signed desktop
 * app breaks its code signature (#11373), while user projects keep cached bytecode. A user who set
 * either variable, even to an empty string, keeps Python's own behaviour.
 */
export function applyPythonCacheDefault(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): void {
  if (env.PYTHONDONTWRITEBYTECODE !== undefined || env.PYTHONPYCACHEPREFIX !== undefined) return
  env.PYTHONPYCACHEPREFIX = join(userCacheRoot(env, platform, home), "omo", "pycache")
}
