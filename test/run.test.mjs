import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defaultOut, run } from "../dist/run.js";
import { lines, pages, replay, replayingJev, scriptedBrowser } from "./helpers.mjs";

const READS = new Set(["snapshot -i", "get title", "console", "errors", "network requests"]);

function options(goal, overrides = {}) {
  return {
    goal,
    session: "jev-test",
    maxSteps: 60,
    out: defaultOut(),
    allow: new Set(),
    model: "jev-latest",
    ...overrides,
  };
}

function acts(browser) {
  return browser.state.calls.filter((call) => !READS.has(call));
}

function steps(out) {
  return lines(join(out, "inferred.jsonl"));
}

function status(out) {
  return JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
}

async function drive(name, goal, overrides = {}, advance) {
  const scenario = JSON.parse(readFileSync(new URL(`./replay/${name}.json`, import.meta.url), "utf8"));
  const browser = scriptedBrowser(pages(scenario.pages), advance);
  const jev = replayingJev(replay(name));
  const run_options = options(goal ?? scenario.goal, overrides);
  const result = await run(run_options, { browser, jev });
  return { result, browser, jev, out: run_options.out };
}

test("a goal walk types from the goal, clicks through and lands done", async (t) => {
  const { result, browser, jev, out } = await drive("login");
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.equal(result.status, "done");
  assert.equal(result.url, "http://127.0.0.1:8765/settings.html");
  assert.equal(result.steps, 4);
  assert.equal(result.actions, 3);
  assert.deepEqual(acts(browser), ["fill @e5 alice@example.com", "fill @e6 secret", "click @e4"]);
  assert.equal(jev.requests.length, 4, "one Jev request per step");
  assert.deepEqual(
    jev.requests[2].state.recent_actions.map((action) => action.operation),
    ["TYPE_TEXT", "TYPE_TEXT"],
  );
  assert.equal(jev.requests[2].state.recent_actions[0].pageChanged, true);
  assert.equal(status(out).status, "done");
  assert.equal(lines(join(out, "observed.jsonl")).length, 4);
});

test("the typed password is masked in the run log", async (t) => {
  const { out } = await drive("login");
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const [email, password] = steps(out);
  assert.equal(email.value, "alice@example.com");
  assert.equal(password.label, "Password");
  assert.equal(password.value, "•••");
});

test("a destructive target is skipped without --allow", async (t) => {
  const { result, browser, out } = await drive("destructive");
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.equal(result.status, "blocked");
  assert.equal(result.actions, 0);
  assert.deepEqual(acts(browser), []);
  const [skipped] = steps(out);
  assert.equal(skipped.executed, false);
  assert.match(skipped.reason, /delete is destructive and not in --allow/);
  assert.equal(skipped.destructive.probability, 0.96);
});

test("--allow all runs the same click and stops asking whether it is destructive", async (t) => {
  const { result, browser, jev, out } = await drive("destructive", null, { allow: "all" });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.deepEqual(acts(browser), ["click @e4"]);
  assert.equal(result.actions, 1);
  assert.ok(!("action_is_destructive" in jev.requests[0].questions));
  assert.equal(steps(out)[0].executed, true);
});

test("a page that moves between the decision and the act is re-decided, not executed", async (t) => {
  let snapshots = 0;
  const { result, browser, out } = await drive("stale", null, {}, (args, state) => {
    if (args.join(" ") !== "snapshot -i") return state.index;
    snapshots += 1;
    return snapshots >= 2 ? 1 : 0;
  });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.deepEqual(acts(browser), []);
  assert.equal(result.status, "done");
  assert.equal(result.steps, 2);
  const [stale] = steps(out);
  assert.equal(stale.executed, false);
  assert.match(stale.reason, /page changed between the decision and the act/);
});

test("three acts that change nothing stop the run", async (t) => {
  const { result, browser, out } = await drive("stuck");
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.equal(result.status, "blocked");
  assert.equal(result.steps, 3);
  assert.equal(acts(browser).length, 3);
  assert.match(result.reason, /left the page unchanged/);
  assert.equal(status(out).reason, result.reason);
});

test("a field with no value in the goal blocks the run and types nothing", async (t) => {
  const { result, browser, out } = await drive("no-value");
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.equal(result.status, "blocked");
  assert.match(result.reason, /holds no value for Search/);
  assert.deepEqual(acts(browser), []);
});

test("a value span under the threshold blocks the run", async (t) => {
  const { result, browser, out } = await drive("weak-value");
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.equal(result.status, "blocked");
  assert.match(result.reason, /holds no value for Password/);
  assert.deepEqual(acts(browser), []);
});

test("--url opens the start page before the first step", async (t) => {
  const { browser, out } = await drive("login", null, { url: "http://127.0.0.1:8765/login.html" });
  t.after(() => rmSync(out, { recursive: true, force: true }));
  assert.equal(browser.state.calls[0], "open http://127.0.0.1:8765/login.html");
});
