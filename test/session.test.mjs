import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STATE_DIR } from "../dist/name.js";
import { activeScope, discoverScopes } from "../dist/scope.js";
import { newRunDir } from "../dist/session.js";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

/** A home and a working directory under it, both empty temp dirs, so no test reads the real `~`. */
function world() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "soab-home-")));
  const cwd = join(home, "work");
  mkdirSync(cwd);
  return { home, cwd };
}

/** One `soab run` with no key: it writes `status.json` where it would run, and never opens the browser. */
function runCommand({ home, cwd }, ...args) {
  const result = spawnSync("node", [MAIN, "run", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home, TYPESAFE_API_KEY: "" },
  });
  const out = /writing to (.+)\n/.exec(result.stderr)?.[1];
  assert.ok(out, result.stderr);
  return { out, status: JSON.parse(readFileSync(join(out, "status.json"), "utf8")) };
}

test("the active scope is the project's when there is one, else the global", () => {
  const { home, cwd } = world();
  assert.equal(activeScope(discoverScopes({ cwd, home })).dir, join(home, STATE_DIR));
  mkdirSync(join(cwd, STATE_DIR));
  assert.equal(activeScope(discoverScopes({ cwd, home })).dir, join(cwd, STATE_DIR));
});

test("each run gets its own directory under its session, in the order the runs started", () => {
  const scopes = discoverScopes(world());
  const runs = join(scopes.global.dir, "sessions", "checkout", "runs");
  const first = newRunDir(scopes, "checkout", new Date("2026-09-25T10:00:00.000Z"));
  const second = newRunDir(scopes, "checkout", new Date("2026-09-25T10:00:00.000Z"));
  const third = newRunDir(scopes, "checkout", new Date("2026-09-25T10:00:01.000Z"));
  assert.notEqual(first, second);
  for (const dir of [first, second, third]) assert.equal(dirname(dir), runs);
  assert.match(readdirSync(runs).sort().at(-1), /^2026-09-25T10-00-01-000Z-/);
  assert.equal(readdirSync(runs).length, 3);
});

test("a session name that is not one path segment is refused", () => {
  const scopes = discoverScopes(world());
  for (const session of ["", ".", "..", "a/b", "..\\up"]) {
    assert.throws(() => newRunDir(scopes, session), /session/, session);
  }
});

test("two goal runs of one session leave two run directories in the global scope, each named by its own status", () => {
  const world_ = world();
  const first = runCommand(world_, "reach the checkout", "--session", "checkout");
  const second = runCommand(world_, "reach the checkout", "--session", "checkout");
  const runs = join(world_.home, STATE_DIR, "sessions", "checkout", "runs");
  assert.deepEqual(readdirSync(runs).map((name) => join(runs, name)).sort(), [first.out, second.out].sort());
  assert.equal(first.status.out, first.out);
  assert.equal(second.status.out, second.out);
  assert.equal(first.status.status, "failed");
});

test("a walk writes under its session in the project scope when there is one", () => {
  const world_ = world();
  mkdirSync(join(world_.cwd, STATE_DIR));
  const { out, status } = runCommand(world_, "--policy", "errors", "--session", "checkout");
  assert.equal(dirname(out), join(world_.cwd, STATE_DIR, "sessions", "checkout", "runs"));
  assert.equal(status.out, out);
});

test("--out still names the run directory", () => {
  const world_ = world();
  const out = join(world_.home, "elsewhere");
  assert.equal(runCommand(world_, "reach the checkout", "--session", "checkout", "--out", out).out, out);
});
