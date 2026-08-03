import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, existsSync, lstatSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { clearStaleProfileLock, isStaleLock, parseLockTarget } from "../src/profile-lock.js";

test("parses Chromium's <host>-<pid> lock target", () => {
  assert.deepEqual(parseLockTarget("penguin-117128"), { host: "penguin", pid: 117128 });
  assert.deepEqual(parseLockTarget("my-host-name-42"), { host: "my-host-name", pid: 42 });
  assert.equal(parseLockTarget("nonsense"), null);
  assert.equal(parseLockTarget(""), null);
});

test("a lock is stale only when it is ours and its process is gone", () => {
  const dead = { host: "penguin", isProcessAlive: () => false };
  const alive = { host: "penguin", isProcessAlive: () => true };
  assert.equal(isStaleLock("penguin-117128", dead), true);
  assert.equal(isStaleLock("penguin-117128", alive), false);
  // A lock written by a different machine must never be stolen.
  assert.equal(isStaleLock("otherbox-117128", dead), false);
});

function profileWithLock(target) {
  const dir = mkdtempSync(join(tmpdir(), "profile-lock-"));
  symlinkSync(target, join(dir, "SingletonLock"));
  symlinkSync("/tmp/whatever/SingletonSocket", join(dir, "SingletonSocket"));
  writeFileSync(join(dir, "SingletonCookie"), "");
  return dir;
}

test("removes the singleton files when the owning process is dead", () => {
  const dir = profileWithLock(`${hostname()}-999999`);
  const owner = clearStaleProfileLock(dir, { isProcessAlive: () => false });
  assert.equal(owner, null);
  assert.throws(() => lstatSync(join(dir, "SingletonLock")), { code: "ENOENT" });
  assert.equal(existsSync(join(dir, "SingletonCookie")), false);
});

test("leaves a live browser's lock alone and reports the owner", () => {
  const dir = profileWithLock("penguin-1234");
  const owner = clearStaleProfileLock(dir, { isProcessAlive: () => true });
  assert.equal(owner, "penguin-1234");
  // lstat, not existsSync: the lock is a symlink to a target that never exists.
  assert.equal(lstatSync(join(dir, "SingletonLock")).isSymbolicLink(), true);
});

test("a profile with no lock needs no cleanup", () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-lock-"));
  assert.equal(clearStaleProfileLock(dir, { isProcessAlive: () => false }), null);
});
