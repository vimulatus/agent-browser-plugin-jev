import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunArgs } from "../dist/args.js";
import { stepLine } from "../dist/progress.js";
import { labRun } from "./helpers.mjs";

test("a step line names the step, the act, the value and Jev's confidence", () => {
  assert.equal(
    stepLine({ step: 4, operation: "TYPE_TEXT", label: "Verification Code", value: "•••", confidence: 0.9 }),
    'step 4 · TYPE "Verification Code" ← ••• · 0.90',
  );
  assert.equal(stepLine({ step: 5, operation: "CLICK", label: "Verify", value: null, confidence: 0.96 }), 'step 5 · CLICK "Verify" · 0.96');
  assert.equal(stepLine({ step: 6, operation: "DONE", label: null, value: null, confidence: 0.99 }), "step 6 · DONE · 0.99");
});

test("a run sends one line per step as it happens, with a secret masked (#95)", async (t) => {
  const lines = [];
  await labRun(
    t,
    ["otp-single", "otp-single-typed", "home"],
    [
      { operation: "TYPE_TEXT", target: "1", value: "482913", secret: 0.96 },
      { operation: "CLICK", target: "2" },
      { operation: "DONE" },
    ],
    "sign in with the code 482913",
    { progress: (line) => lines.push(line) },
  );
  assert.deepEqual(lines, [
    'step 1 · TYPE "One-time code" ← ••• · 0.90',
    'step 2 · CLICK "Verify" · 0.90',
    "step 3 · DONE · 0.90",
  ]);
});

test("the command prints step lines by default, and --quiet turns them off", () => {
  assert.equal(typeof parseRunArgs(["g", "--session", "s"]).progress, "function");
  assert.equal(parseRunArgs(["g", "--session", "s", "--quiet"]).progress, undefined);
});
