import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "../dist/run.js";
import { parseResumeArgs, resumeOptions } from "../dist/resume.js";
import { isolatedScopes, lab, labRun, lines, scriptedBrowser, scriptedJev } from "./helpers.mjs";

const READS = /^(snapshot|get |console|errors|network requests)/;

/** Resumes the session `lab` with `argv` over `pages`, one scripted Jev intent per step, as `soab resume lab ...` would. */
export async function resume(t, scopes, argv, pages, intents, advance) {
  const options = resumeOptions(scopes, parseResumeArgs(["lab", ...argv]));
  delete options.progress;
  t.after(() => rmSync(options.out, { recursive: true, force: true }));
  const browser = scriptedBrowser(pages, advance);
  const jev = scriptedJev(intents);
  const result = await run(options, { browser, jev, policyJev: { ask: async () => assert.fail("no policy") }, scopes });
  const acts = browser.state.calls.filter((call) => !READS.test(call)).map((call) => call.replace(/^state (save|load) .*/, "state $1 <file>"));
  const status = JSON.parse(readFileSync(join(options.out, "status.json"), "utf8"));
  return { result, acts, jev, status, options };
}

async function blockedOnCode(t) {
  const scopes = isolatedScopes();
  const first = await labRun(t, ["otp-single"], [{ operation: "TYPE_TEXT", target: "1", kind: "otp" }], "sign in to Acme", { scopes });
  assert.equal(first.result.blocker.kind, "otp");
  return { scopes, first };
}

test("resume with a value on an otp block types it, goes on and ends done (#89)", async (t) => {
  const { scopes, first } = await blockedOnCode(t);
  const { result, acts, jev, status, options } = await resume(
    t,
    scopes,
    ["--value", "One-time code=482913"],
    lab("otp-single", "otp-single-typed", "home"),
    [{ operation: "CLICK", target: "2" }, { operation: "DONE" }],
  );
  assert.deepEqual(acts, ["fill @e2 482913", "click @e3", "state save <file>"], "no --url, no sign-in loaded: the same browser goes on");
  assert.equal(result.status, "done");
  assert.equal(jev.requests[0].state.goal, "sign in to Acme", "the goal comes from the blocked run");
  assert.equal(status.resumedFrom, first.out);
  assert.equal(options.maxSteps, 9, "the steps left of the blocked run");
  const [typed] = lines(join(options.out, "inferred.jsonl"));
  assert.deepEqual([typed.label, typed.value, typed.reason], ["One-time code", "•••", "given to resume"]);
  for (const file of ["status.json", "inferred.jsonl", "observed.jsonl"]) {
    assert.doesNotMatch(readFileSync(join(options.out, file), "utf8"), /482913/, `${file} holds the value`);
  }
  assert.doesNotMatch(JSON.stringify(result), /482913/);
});

test("a bare value fills the only field the blocker names (#89)", async (t) => {
  const { scopes } = await blockedOnCode(t);
  const { acts } = await resume(t, scopes, ["--value", "482913"], lab("otp-single", "otp-single-typed"), [{ operation: "BLOCKED" }]);
  assert.equal(acts[0], "fill @e2 482913");
});

test("resume with no value after an approval block goes on, and ends done once the page moved on (#89)", async (t) => {
  const scopes = isolatedScopes();
  await labRun(t, ["push-approve"], [{ operation: "WAIT", kind: "approval" }], "open the home page", { scopes });
  const { result, acts } = await resume(t, scopes, [], lab("home"), [{ operation: "DONE" }]);
  assert.equal(result.status, "done");
  assert.deepEqual(acts, ["state save <file>"]);
});

test("resume on a session whose last run is not blocked exits with why (#89)", async (t) => {
  const scopes = isolatedScopes();
  await labRun(t, ["home"], [{ operation: "DONE" }], "open the home page", { scopes });
  assert.throws(() => resumeOptions(scopes, parseResumeArgs(["lab"])), /last run is done, not blocked or stopped/);
  assert.throws(() => resumeOptions(isolatedScopes(), parseResumeArgs(["lab"])), /session lab has no run to resume/);
});

test("a value for a field the blocker does not name is refused, naming the fields it needs (#89)", async (t) => {
  const { scopes } = await blockedOnCode(t);
  assert.throws(
    () => resumeOptions(scopes, parseResumeArgs(["lab", "--value", "Password=hunter2"])),
    /not blocked on a field "Password"; it needs "One-time code"/,
  );
});

test("resume --allow after a permission block makes the click the run refused, and ends done (#90)", async (t) => {
  const scopes = isolatedScopes();
  const goal = 'type "DELETE" and delete the 40 records';
  const refuse = { operation: "CLICK", target: "2", destructive: 0.95, verb: "delete" };
  const first = await labRun(t, ["delete-confirm"], [refuse], goal, { scopes });
  assert.equal(first.result.blocker.kind, "permission");
  assert.deepEqual(first.status.allow, []);

  const { result, acts, status } = await resume(t, scopes, ["--allow", "delete"], lab("delete-confirm", "deleted"), [refuse, { operation: "DONE" }]);
  assert.deepEqual(acts, ["click @e3", "state save <file>"]);
  assert.equal(result.status, "done");
  assert.deepEqual(status.allow, ["delete"], "the widened allow list is in the new run's status.json");
});
