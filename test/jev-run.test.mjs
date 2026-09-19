import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const PROTOCOL = "agent-browser.plugin.v1";
const BIN = new URL("./bin/stub-plugin.mjs", import.meta.url).pathname;

function invoke(type, request, env = {}) {
  const result = spawnSync("node", [BIN], {
    encoding: "utf8",
    input: JSON.stringify({ protocol: PROTOCOL, type, capability: type, request }),
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

async function settled(runId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const body = invoke("jev.status", { runId });
    if (body.status !== "running") return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run ${runId} never left running`);
}

function clean(t, body) {
  t.after(() => rmSync(body.out, { recursive: true, force: true }));
  return body;
}

function argv(out) {
  return JSON.parse(readFileSync(join(out, "argv.json"), "utf8"));
}

test("jev.run with wait true answers with the finished run, well inside the 60 s timeout", async (t) => {
  const started = Date.now();
  const body = clean(t, invoke("jev.run", { goal: "open the settings page", session: "jev-test", wait: true }));

  assert.equal(body.protocol, PROTOCOL);
  assert.equal(body.success, true);
  assert.match(body.runId, /^jev-run-/);
  assert.equal(body.status, "done");
  assert.equal(body.url, "http://127.0.0.1:8765/settings.html");
  assert.ok(Date.now() - started < 10_000, "the wait ends when the worker ends");
});

test("a run still going when the wait ends is running, and jev.status reports it done later", async (t) => {
  const body = clean(t, invoke("jev.run", { goal: "open the settings page", session: "jev-test", wait: 300 }, { STUB_DELAY_MS: "1500" }));

  assert.equal(body.success, true);
  assert.equal(body.status, "running");
  assert.equal((await settled(body.runId)).status, "done");
});

test("jev.run without wait answers at once and the worker outlives the answer", async (t) => {
  const body = clean(t, invoke("jev.run", { goal: "open the settings page", session: "jev-test" }, { STUB_DELAY_MS: "400" }));

  assert.equal(body.status, "running");
  assert.equal((await settled(body.runId)).status, "done");
});

test("jev.status reads the run by its out directory as well as by its runId", async (t) => {
  const body = clean(t, invoke("jev.run", { goal: "open the settings page", session: "jev-test", wait: true }));
  assert.equal(invoke("jev.status", { out: body.out }).status, "done");
});

test("the request becomes the worker's run flags", async (t) => {
  const body = clean(t, invoke("jev.run", {
    goal: "open the settings page",
    session: "shop",
    url: "http://127.0.0.1:8765/login.html",
    maxSteps: 8,
    allow: ["delete"],
    record: "/tmp/jev-record/plugin.webm",
    human: true,
    wait: true,
  }));

  assert.deepEqual(argv(body.out), [
    "run",
    "open the settings page",
    "--session",
    "shop",
    "--out",
    body.out,
    "--url",
    "http://127.0.0.1:8765/login.html",
    "--max-steps",
    "8",
    "--allow",
    "delete",
    "--record",
    "/tmp/jev-record/plugin.webm",
    "--human",
  ]);
});

test("the session falls back to AGENT_BROWSER_SESSION in the inherited environment", async (t) => {
  const body = clean(t, invoke("jev.run", { goal: "open the settings page", wait: true }, { AGENT_BROWSER_SESSION: "inherited" }));
  assert.deepEqual(argv(body.out).slice(2, 4), ["--session", "inherited"]);
});

test("a run with no session anywhere is a plain error, not a crash", () => {
  const body = invoke("jev.run", { goal: "open the settings page" }, { AGENT_BROWSER_SESSION: "" });
  assert.equal(body.success, false);
  assert.match(body.error, /session/);
});

test("a run with neither a goal nor a policy is a plain error", () => {
  const body = invoke("jev.run", { session: "jev-test" });
  assert.equal(body.success, false);
  assert.match(body.error, /goal/);
});

test("jev.status of a run nobody started is a plain error", () => {
  const body = invoke("jev.status", { runId: "jev-run-nothing" });
  assert.equal(body.success, false);
  assert.match(body.error, /jev-run-nothing/);
});

test("a runId that walks out of the runs directory is refused", () => {
  const body = invoke("jev.status", { runId: "../../etc" });
  assert.equal(body.success, false);
  assert.match(body.error, /runId/);
});

test("a worker that dies without a status is reported failed with what it printed", (t) => {
  const body = clean(t, invoke("jev.run", { goal: "open the settings page", session: "jev-test", wait: true }, { STUB_FAIL: "1" }));

  assert.equal(body.success, true);
  assert.equal(body.status, "failed");
  assert.match(body.reason, /the worker died before the first step/);
});
