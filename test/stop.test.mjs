import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { activeScope } from "../dist/scope.js";
import { stopSession } from "../dist/runs.js";
import { isolatedScopes, labRun, scriptedJev } from "./helpers.mjs";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

const STEPS = [
  { operation: "TYPE_TEXT", target: "1", value: "Acme" },
  { operation: "TYPE_TEXT", target: "2", value: "Acme" },
  { operation: "DONE" },
];

/** A Jev that answers from `intents`, and calls `during` once the request of step `at` is in. */
function interrupting(at, during) {
  const jev = scriptedJev(STEPS);
  const ask = jev.ask;
  jev.ask = async (request) => {
    const reply = await ask(request);
    if (jev.requests.length === at) during();
    return reply;
  };
  return jev;
}

function authSaved(scopes) {
  return existsSync(join(activeScope(scopes).dir, "sessions", "lab", "auth.json"));
}

test("soab stop from another shell ends the run stopped after its step, with its sign-in saved (#98)", async (t) => {
  const scopes = isolatedScopes();
  let asked;
  const jev = interrupting(1, () => (asked = stopSession(scopes, "lab")));
  const { result, status, acts } = await labRun(t, ["form-missing", "form-missing-typed"], [], "create an invoice for customer Acme", {
    scopes,
    jev,
  });
  assert.equal(asked.stopping, true);
  assert.equal(result.status, "stopped");
  assert.equal(result.reason, "stopped by soab stop");
  assert.equal(result.steps, 1, "the step in flight finishes, and no other starts");
  assert.deepEqual(acts, ["fill @e2 Acme", "state save <file>"]);
  assert.equal(status.status, "stopped");
  assert.ok(authSaved(scopes), "auth.json is saved");
  assert.ok(!acts.includes("close"), "the browser stays open");
});

test("Ctrl-C ends the run stopped the same way (#98)", async (t) => {
  const scopes = isolatedScopes();
  const signal = new AbortController();
  const jev = interrupting(1, () => signal.abort("SIGINT"));
  const { result } = await labRun(t, ["form-missing", "form-missing-typed"], [], "create an invoice for customer Acme", {
    scopes,
    jev,
    signal: signal.signal,
  });
  assert.equal(result.status, "stopped");
  assert.equal(result.reason, "stopped by SIGINT");
  assert.ok(authSaved(scopes));
});

test("soab stop on a session with no running run exits 0 and says so (#98)", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "soab-home-")));
  const cwd = join(home, "work");
  mkdirSync(cwd);
  const result = spawnSync("node", [MAIN, "stop", "idle"], { cwd, encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { session: "idle", out: null, stopping: false });
  assert.match(result.stderr, /session idle has no running run/);
});
