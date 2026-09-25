import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lab, labRun, labRunPages, lines } from "./helpers.mjs";

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
  assert.deepEqual(result.blocker, {
    kind: "approval",
    fields: [],
    reason: "the page waits for the user to approve on another device",
  });
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
    [{ operation: "TYPE_TEXT", target: "2", kind: "error_page" }],
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
    [{ operation: "CLICK", target: "2", destructive: 0.95, verb: "delete", kind: "unknown" }],
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

test("a page whose document returned 500 blocks as error_page, before any Jev request or click (#86)", async (t) => {
  const { result, jev, acts } = await labRun(t, ["error-500"], [], "open my invoices");
  assert.equal(jev.requests.length, 0, "no model call for a server error");
  assert.deepEqual(acts, []);
  assert.equal(result.steps, 0);
  assert.deepEqual(result.blocker, { kind: "error_page", fields: [], reason: "the page returned HTTP 500" });
});

test("a page whose document returned 429 blocks as rate_limit, with its Retry-After (#86)", async (t) => {
  const { result, jev, acts } = await labRun(t, ["rate-limit"], [], "open my invoices");
  assert.equal(jev.requests.length, 0);
  assert.deepEqual(acts, [], "it does not click Try again");
  assert.deepEqual(result.blocker, {
    kind: "rate_limit",
    fields: [],
    reason: "the page returned HTTP 429, retry after 30 s",
    retryAfter: 30,
  });
});

test("a magic-link page blocks at step 1 as sign_in, and Resend link is never clicked (#87)", async (t) => {
  const { result, acts } = await labRun(
    t,
    ["magic-link"],
    [{ operation: "CLICK", target: "1", kind: "sign_in" }],
    "open my invoices",
  );
  assert.deepEqual(acts, []);
  assert.equal(result.steps, 1);
  assert.deepEqual(result.blocker, {
    kind: "sign_in",
    fields: [],
    reason: "the page asks to sign in, and the goal holds nothing to sign in with",
  });
});

test("a captcha page blocks at step 1 as captcha, and the box is never ticked (#87)", async (t) => {
  const { result, acts } = await labRun(t, ["captcha"], [{ operation: "CLICK", target: "1", kind: "captcha" }], "open my invoices");
  assert.deepEqual(acts, []);
  assert.equal(result.steps, 1);
  assert.equal(result.blocker.kind, "captcha");
});

test("a push-approval page blocks at step 1 as approval, even on a WAIT (#87)", async (t) => {
  const { result, acts } = await labRun(t, ["push-approve"], [{ operation: "WAIT", kind: "approval" }], "open my invoices");
  assert.deepEqual(acts, []);
  assert.equal(result.blocker.kind, "approval");
});

test("an identifier-first sign-in whose email is in the goal goes on and ends done (#87)", async (t) => {
  const [login, home] = lab("id-first-login", "home");
  const typed = { ...login, snapshot: login.snapshot.replace('"Email" [ref=e2]', '"Email" [ref=e2]: alice@example.com') };
  const { result, acts } = await labRunPages(
    t,
    [login, typed, home],
    [
      { operation: "TYPE_TEXT", target: "1", value: "alice@example.com", kind: "sign_in" },
      { operation: "CLICK", target: "2", kind: "sign_in" },
      { operation: "DONE" },
    ],
    "sign in as alice@example.com and open the home page",
  );
  assert.deepEqual(acts, ["fill @e2 alice@example.com", "click @e3", "state save <file>"]);
  assert.equal(result.status, "done");
});

test("a one-time code Jev judges secret appears in no run file and not on stdout (#78)", async (t) => {
  const { result, out } = await labRun(
    t,
    ["otp-single", "otp-single-typed", "otp-single-typed"],
    [
      { operation: "TYPE_TEXT", target: "1", value: "482913", secret: 0.96 },
      { operation: "CLICK", target: "2" },
      { operation: "DONE", outcome: 0.1 },
    ],
    "sign in with the code 482913",
  );
  assert.equal(result.status, "blocked", "the page still shows the code step");
  for (const file of ["status.json", "inferred.jsonl", "observed.jsonl"]) {
    assert.doesNotMatch(readFileSync(join(out, file), "utf8"), /482913/, `${file} holds the code`);
  }
  assert.doesNotMatch(JSON.stringify(result), /482913/, "stdout holds the code");
  assert.match(result.snapshot, /textbox "One-time code" \[ref=e2\]: •••/);
  const [typed] = lines(join(out, "inferred.jsonl"));
  assert.equal(typed.value, "•••");
});

test("a code Jev judges an ordinary value is logged as typed", async (t) => {
  const { out } = await labRun(
    t,
    ["otp-single", "otp-single-typed"],
    [{ operation: "TYPE_TEXT", target: "1", value: "482913" }, { operation: "BLOCKED" }],
    "sign in with the code 482913",
  );
  assert.equal(lines(join(out, "inferred.jsonl"))[0].value, "482913");
});

/** The otp-no-advance page stays put while its boxes are filled, shows them full after the last, and moves on at Verify. */
function boxesAdvance(args, state) {
  if (args[0] === "fill" && args[1] === "@e7") return 1;
  if (args[0] === "click") return 2;
  return state.index;
}

test("a code over six boxes that do not move focus gets one character per box, then Verify (#100)", async (t) => {
  const { result, acts, out, jev } = await labRun(
    t,
    ["otp-no-advance", "otp-no-advance-typed", "home"],
    [
      { operation: "TYPE_TEXT", target: "1", value: "123456", secret: 0.95 },
      { operation: "CLICK", target: "7" },
      { operation: "DONE" },
    ],
    "enter the code 123456 and verify",
    { advance: boxesAdvance },
  );
  assert.deepEqual(acts, [
    "fill @e2 1",
    "fill @e3 2",
    "fill @e4 3",
    "fill @e5 4",
    "fill @e6 5",
    "fill @e7 6",
    "click @e8",
    "state save <file>",
  ]);
  assert.equal(result.status, "done");
  assert.deepEqual(
    jev.requests[1].state.recent_actions.map(({ target, value }) => [target, value]),
    [1, 2, 3, 4, 5, 6].map((digit) => [`Digit ${digit} of 6`, "•••"]),
    "Jev is told each box was typed, not the whole code into the first",
  );
  const observed = readFileSync(join(out, "observed.jsonl"), "utf8");
  assert.doesNotMatch(observed, /"value":"[1-6]"/, "each box's digit is masked");
});

test("a value whose length differs from the box count is typed as it is (#100)", async (t) => {
  const { acts } = await labRun(
    t,
    ["otp-no-advance", "otp-no-advance-typed"],
    [{ operation: "TYPE_TEXT", target: "1", value: "12345" }, { operation: "BLOCKED" }],
    "enter the code 12345 and verify",
    { advance: boxesAdvance },
  );
  assert.deepEqual(acts, ["fill @e2 12345"]);
});
