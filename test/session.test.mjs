import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentBrowser } from "../dist/agent-browser.js";
import { STATE_DIR } from "../dist/name.js";
import { activeScope, discoverScopes } from "../dist/scope.js";
import { newRunDir, resetSession } from "../dist/session.js";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

/** A home and a working directory under it, both empty temp dirs, so no test reads the real `~`. */
function world() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "soab-home-")));
  const cwd = join(home, "work");
  mkdirSync(cwd);
  return { home, cwd };
}

/** One `soab run` with no key and no proxy to add one: it writes `status.json` where it would run, and never opens the browser. */
function runCommand({ home, cwd }, ...args) {
  const result = spawnSync("node", [MAIN, "run", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home, TYPESAFE_API_KEY: "", HTTPS_PROXY: "", https_proxy: "" },
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
  for (const session of ["", ".", "..", ".used.json", "a/b", "..\\up"]) {
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
  assert.match(first.status.reason, /TYPESAFE_API_KEY/);
});

test("a walk writes under its session in the project scope when there is one", () => {
  const world_ = world();
  mkdirSync(join(world_.cwd, STATE_DIR));
  const { out, status } = runCommand(world_, "--policy", "errors", "--session", "checkout");
  assert.equal(dirname(out), join(world_.cwd, STATE_DIR, "sessions", "checkout", "runs"));
  assert.equal(status.out, out);
  assert.equal(status.status, "failed");
  assert.match(status.reason, /TYPESAFE_API_KEY/);
});

test("--out still names the run directory", () => {
  const world_ = world();
  const out = join(world_.home, "elsewhere");
  assert.equal(runCommand(world_, "reach the checkout", "--session", "checkout", "--out", out).out, out);
});

const FAKE_BIN = fileURLToPath(new URL("./bin/", import.meta.url));
const RESET_FIXTURES = fileURLToPath(new URL("./fixtures/session-reset/", import.meta.url));

/** One `soab session reset` over the fake agent-browser, which answers `close` with a recorded reply. */
function resetCommand({ home, cwd }, ...args) {
  return spawnSync("node", [MAIN, "session", "reset", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${FAKE_BIN}:${process.env.PATH}`, JEV_FIXTURES: RESET_FIXTURES },
  });
}

/**
 * The session's agent-browser, keeping each command in `calls`. `state list` names the saved-state directory under
 * `home`, as agent-browser 0.38.1 does; every other command answers with nothing.
 */
function closingBrowser(session, home) {
  const calls = [];
  const browser = agentBrowser(session, false, async (args) => {
    calls.push(args.join(" "));
    return args.join(" ") === "state list" ? { directory: join(home, ".agent-browser", "sessions"), files: [] } : {};
  });
  return Object.assign(browser, { calls });
}

/** Writes agent-browser saved-state files under `home`, as `close` leaves them after a handoff, and returns their paths. */
function savedState(home, ...names) {
  const dir = join(home, ".agent-browser", "sessions");
  mkdirSync(dir, { recursive: true });
  return names.map((name) => {
    writeFileSync(join(dir, name), "{}");
    return join(dir, name);
  });
}

test("reset deletes every run and the sign-in of its session, closes its browser, and leaves other sessions alone", async () => {
  const world_ = world();
  const scopes = discoverScopes(world_);
  const { dir: scopeDir, store } = activeScope(scopes);
  await store.put("sessions/checkout/auth.json", "{}");
  writeFileSync(join(newRunDir(scopes, "checkout"), "status.json"), "{}");
  mkdirSync(join(newRunDir(scopes, "checkout"), "evidence"));
  await store.put("sessions/checkout-repro/auth.json", "{}");
  const handoff = savedState(world_.home, "checkout-checkout.json", "checkout-checkout.json.enc");
  const others = savedState(world_.home, "checkout-repro-checkout-repro.json", "other-other.json");
  const browser = closingBrowser("checkout", world_.home);

  const session = join(scopeDir, "sessions", "checkout");
  assert.deepEqual(await resetSession(scopes, "checkout", browser), { session: "checkout", deleted: [session, ...handoff] });
  assert.deepEqual(browser.calls, ["close", "state list"]);
  assert.equal(existsSync(session), false);
  for (const file of handoff) assert.equal(existsSync(file), false, file);
  for (const file of others) assert.equal(existsSync(file), true, file);
  assert.deepEqual(await store.list("sessions/"), ["sessions/checkout-repro/auth.json"]);
});

test("reset of a session whose only state is agent-browser's saved sign-in deletes that file", async () => {
  const world_ = world();
  const handoff = savedState(world_.home, "checkout-checkout.json");
  const reset = await resetSession(discoverScopes(world_), "checkout", closingBrowser("checkout", world_.home));
  assert.deepEqual(reset, { session: "checkout", deleted: handoff });
  assert.equal(existsSync(handoff[0]), false);
});

test("reset of a session with no state deletes nothing, and still closes its browser", async () => {
  const world_ = world();
  const browser = closingBrowser("never-ran", world_.home);
  assert.deepEqual(await resetSession(discoverScopes(world_), "never-ran", browser), { session: "never-ran", deleted: [] });
  assert.deepEqual(browser.calls, ["close", "state list"]);
});

test("session reset after two runs deletes both and prints the path, and the next run starts with no auth.json and no earlier run", () => {
  const world_ = world();
  mkdirSync(join(world_.cwd, STATE_DIR));
  const session = join(world_.cwd, STATE_DIR, "sessions", "checkout");
  runCommand(world_, "reach the checkout", "--session", "checkout");
  runCommand(world_, "reach the checkout", "--session", "checkout");
  writeFileSync(join(session, "auth.json"), "{}");
  const [handoff] = savedState(world_.home, "checkout-checkout.json");
  assert.equal(readdirSync(join(session, "runs")).length, 2);

  const reset = resetCommand(world_, "checkout");
  assert.equal(reset.status, 0, reset.stderr);
  assert.deepEqual(JSON.parse(reset.stdout), { session: "checkout", deleted: [session, handoff] });
  assert.ok(reset.stderr.includes(`deleted ${session}, ${handoff}`), reset.stderr);
  assert.equal(existsSync(session), false);
  assert.equal(existsSync(handoff), false);

  const next = runCommand(world_, "reach the checkout", "--session", "checkout");
  assert.deepEqual(readdirSync(session), ["runs"]);
  assert.deepEqual(readdirSync(join(session, "runs")).map((name) => join(session, "runs", name)), [next.out]);
});

test("session reset of an unknown session exits 0 and says there was nothing to delete", () => {
  const reset = resetCommand(world(), "never-ran");
  assert.equal(reset.status, 0, reset.stderr);
  assert.deepEqual(JSON.parse(reset.stdout), { session: "never-ran", deleted: [] });
  assert.match(reset.stderr, /never-ran had nothing to delete/);
});

test("session reset takes one session name", () => {
  for (const args of [[], ["a", "b"], ["../up"]]) {
    assert.equal(resetCommand(world(), ...args).status, 1, args.join(" "));
  }
});
