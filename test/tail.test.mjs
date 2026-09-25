import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newRunDir } from "../dist/session.js";
import { tail } from "../dist/tail.js";
import { isolatedScopes, labRun } from "./helpers.mjs";

const pause = (ms) => new Promise((wake) => setTimeout(wake, ms));

function step(n, operation, label, value = null) {
  return `${JSON.stringify({ step: n, operation, label, value, confidence: 0.9 })}\n`;
}

test("tail follows a running run, one line per new step, and returns when it ends (#96)", async () => {
  const scopes = isolatedScopes();
  const out = newRunDir(scopes, "lab");
  const status = (state) => writeFileSync(join(out, "status.json"), JSON.stringify({ status: state, goal: "g" }));
  status("running");
  appendFileSync(join(out, "inferred.jsonl"), step(1, "TYPE_TEXT", "Code", "•••"));
  const printed = [];
  const following = tail(scopes, "lab", { json: false, write: (line) => printed.push(line), pollMs: 5 });
  await pause(30);
  assert.deepEqual(printed, ['step 1 · TYPE "Code" ← ••• · 0.90']);
  appendFileSync(join(out, "inferred.jsonl"), `${JSON.stringify({ question: "a policy answer" })}\n`);
  appendFileSync(join(out, "inferred.jsonl"), step(2, "CLICK", "Verify"));
  status("done");
  await following;
  assert.deepEqual(printed, ['step 1 · TYPE "Code" ← ••• · 0.90', 'step 2 · CLICK "Verify" · 0.90']);
});

test("tail of a finished run prints its steps and returns, and --json prints each step as JSON (#96)", async (t) => {
  const { scopes } = await labRun(
    t,
    ["otp-single", "otp-single-typed", "home"],
    [
      { operation: "TYPE_TEXT", target: "1", value: "482913", secret: 0.96 },
      { operation: "CLICK", target: "2" },
      { operation: "DONE" },
    ],
    "sign in with the code 482913",
  );
  const printed = [];
  await tail(scopes, "lab", { json: false, write: (line) => printed.push(line) });
  assert.deepEqual(printed, ['step 1 · TYPE "One-time code" ← ••• · 0.90', 'step 2 · CLICK "Verify" · 0.90', "step 3 · DONE · 0.90"]);

  const objects = [];
  await tail(scopes, "lab", { json: true, write: (line) => objects.push(JSON.parse(line)) });
  assert.deepEqual(objects.map((entry) => entry.operation), ["TYPE_TEXT", "CLICK", "DONE"]);
  assert.equal(objects[0].value, "•••");
});

test("tail of a session with no runs says so", async () => {
  await assert.rejects(tail(isolatedScopes(), "none", { json: false, write: () => {} }), /session none has no runs/);
});
