import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "../dist/run.js";
import { newRunDir } from "../dist/session.js";
import { isolatedScopes, lab, lines, scriptedBrowser, scriptedJev } from "./helpers.mjs";

const READS = new Set(["snapshot -i", "snapshot", "get title", "console", "errors", "network requests"]);

/** Runs `goal` over lab pages, one scripted Jev intent per step, with a policy Jev that must never be asked. */
export async function labRun(t, pages, intents, goal, overrides = {}) {
  const scopes = isolatedScopes();
  const options = {
    goal,
    session: "lab",
    maxSteps: 10,
    out: newRunDir(scopes, "lab"),
    allow: new Set(),
    model: "jev-latest",
    human: false,
    handoff: false,
    loginTimeoutMs: 200,
    ...overrides,
  };
  t.after(() => rmSync(options.out, { recursive: true, force: true }));
  const browser = scriptedBrowser(lab(...pages));
  const jev = scriptedJev(intents);
  const policyJev = { ask: async () => assert.fail("no policy") };
  const result = await run(options, { browser, jev, policyJev, scopes });
  const status = JSON.parse(readFileSync(join(options.out, "status.json"), "utf8"));
  const acts = browser.state.calls.filter((call) => !READS.has(call));
  return { result, status, jev, acts, out: options.out };
}

test("a code step the goal has no code for blocks as otp, naming the code field", async (t) => {
  const { result, status } = await labRun(
    t,
    ["otp-single"],
    [{ operation: "TYPE_TEXT", target: "1", kind: "otp" }],
    "sign in to Acme",
  );
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blocker, {
    kind: "otp",
    fields: [{ ref: "e2", label: "One-time code" }],
    reason: "the goal holds no value for One-time code",
  });
  assert.deepEqual(status.blocker, result.blocker, "status.json carries the same blocker");
});

test("an identifier-first sign-in with nothing to type blocks as sign_in, naming the email field", async (t) => {
  const { result } = await labRun(t, ["id-first-login"], [{ operation: "BLOCKED", kind: "sign_in" }], "open my invoices");
  assert.equal(result.blocker.kind, "sign_in");
  assert.deepEqual(result.blocker.fields, [{ ref: "e2", label: "Email" }]);
});

test("a page waiting on a push approval blocks as approval, with no fields", async (t) => {
  const { result } = await labRun(t, ["push-approve"], [{ operation: "BLOCKED", kind: "approval" }], "open my invoices");
  assert.deepEqual(result.blocker, { kind: "approval", fields: [], reason: "no supported operation can make progress" });
});

test("a captcha blocks as captcha, with no fields", async (t) => {
  const { result } = await labRun(t, ["captcha"], [{ operation: "BLOCKED", kind: "captcha" }], "open my invoices");
  assert.equal(result.blocker.kind, "captcha");
  assert.deepEqual(result.blocker.fields, []);
});

test("a form the goal fills only in part blocks as missing_value, naming every empty field (#75 form-missing)", async (t) => {
  const { result, acts } = await labRun(
    t,
    ["form-missing", "form-missing-typed"],
    [
      { operation: "TYPE_TEXT", target: "1", value: "Acme" },
      { operation: "TYPE_TEXT", target: "2", kind: "missing_value" },
    ],
    "create an invoice for customer Acme",
  );
  assert.deepEqual(acts, ["fill @e2 Acme"]);
  assert.equal(result.blocker.kind, "missing_value");
  assert.deepEqual(result.blocker.fields.map((field) => field.label), ["GST number", "PAN", "Due date"]);
});

test("a field the goal holds no value for is missing_value, whatever else Jev judged the page", async (t) => {
  const { result } = await labRun(
    t,
    ["form-missing"],
    [{ operation: "TYPE_TEXT", target: "2", kind: "captcha" }],
    "create an invoice for customer Acme",
  );
  assert.equal(result.blocker.kind, "missing_value");
});

test("a blocker Jev is unsure of is unknown, and so is one it judges nothing", async (t) => {
  const unsure = await labRun(t, ["captcha"], [{ operation: "BLOCKED", kind: "captcha", kindP: 0.4 }], "open my invoices");
  assert.equal(unsure.result.blocker.kind, "unknown");
  const nothing = await labRun(t, ["captcha"], [{ operation: "BLOCKED" }], "open my invoices");
  assert.equal(nothing.result.blocker.kind, "unknown");
});

test("a refused destructive click blocks as permission, and the kind costs no question", async (t) => {
  const { result, jev, acts } = await labRun(
    t,
    ["delete-confirm"],
    [{ operation: "CLICK", target: "2", destructive: 0.95, verb: "delete", kind: "captcha" }],
    'type "DELETE" and delete the 40 records',
  );
  assert.deepEqual(acts, [], "nothing clicked");
  assert.equal(jev.requests.length, 1);
  assert.deepEqual(result.blocker, {
    kind: "permission",
    fields: [],
    reason: "delete is destructive and not in --allow: did not click Delete",
  });
});

test("a run that ends done carries no blocker, and every step logs the blocker probabilities", async (t) => {
  const { result, status, out } = await labRun(
    t,
    ["otp-single", "otp-single-typed", "home"],
    [
      { operation: "TYPE_TEXT", target: "1", value: "482913" },
      { operation: "CLICK", target: "2" },
      { operation: "DONE" },
    ],
    "sign in with the code 482913",
  );
  assert.equal(result.status, "done");
  assert.equal("blocker" in result, false);
  assert.equal("blocker" in status, false);
  const steps = lines(join(out, "inferred.jsonl"));
  assert.equal(steps.length, 3);
  for (const step of steps) assert.equal(step.blockerProbabilities.none, 0.9);
});
