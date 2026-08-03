import { readlinkSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

// Chromium marks a user-data directory as in use with SingletonLock, a symlink
// named "<host>-<pid>". A browser that is killed rather than closed leaves the
// link behind, and the next launch waits forever to hand off to a process that
// no longer exists — which reads exactly like a hung scraper.
const SINGLETON_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

export function parseLockTarget(target) {
  const match = /^(.*)-(\d+)$/.exec(String(target || ""));
  if (!match) return null;
  return { host: match[1], pid: Number.parseInt(match[2], 10) };
}

// Only ever treat a lock as stale when it belongs to this machine and its
// process is gone. A lock from another host (a profile on shared storage) or a
// live browser must be left alone — stealing it corrupts the profile.
export function isStaleLock(target, { host = hostname(), isProcessAlive } = {}) {
  const parsed = parseLockTarget(target);
  if (!parsed) return false;
  if (parsed.host !== host) return false;
  return !isProcessAlive(parsed.pid);
}

function processIsAlive(pid) {
  try {
    // Signal 0 performs the permission and existence check without signalling.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Returns the lock owner when the profile is genuinely busy, or null once the
// directory is safe to launch against.
export function clearStaleProfileLock(profileDir, options = {}) {
  const isProcessAlive = options.isProcessAlive || processIsAlive;
  const lockPath = join(profileDir, "SingletonLock");
  let target;
  try {
    target = readlinkSync(lockPath);
  } catch {
    return null; // No lock, or not a symlink: nothing to clean up.
  }

  if (!isStaleLock(target, { isProcessAlive })) return target;

  for (const name of SINGLETON_FILES) {
    try {
      // Plain unlink: these are usually symlinks to targets that no longer
      // exist, which existsSync reports as absent because it follows links.
      unlinkSync(join(profileDir, name));
    } catch { /* already gone, or never existed */ }
  }
  process.stderr.write(`[INFO] Cleared a stale Chromium profile lock (${target}); its process is no longer running.\n`);
  return null;
}
