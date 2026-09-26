import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../dist/run.js";
import { parseResumeArgs, resumeOptions } from "../dist/resume.js";
import { isolatedScopes, lab, labRun, labRunPages, lines, scriptedBrowser, scriptedJev } from "./helpers.mjs";

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

test("resume --open follows a magic link in the session's browser, ends done, and the link lands in no file (#91)", async (t) => {
  const scopes = isolatedScopes();
  await labRun(t, ["magic-link"], [{ operation: "CLICK", target: "1", kind: "sign_in" }], "open the home page", { scopes });
  const link = "http://127.0.0.1:8792/auth/callback?token=s3cr3t-magic-token";
  const opened = (args, state) => (args[0] === "open" ? 1 : state.index);
  const { result, acts, options } = await resume(t, scopes, ["--open", link], lab("magic-link", "home"), [{ operation: "DONE" }], opened);
  assert.deepEqual(acts, [`open ${link}`, "state save <file>"]);
  assert.equal(result.status, "done");
  for (const file of ["status.json", "inferred.jsonl", "observed.jsonl"]) {
    assert.doesNotMatch(readFileSync(join(options.out, file), "utf8"), /s3cr3t-magic-token/, `${file} holds the link`);
  }
  assert.doesNotMatch(JSON.stringify(result), /s3cr3t-magic-token/);
});

test("resume takes a value from an env var or a file, types it and ends done, masked everywhere (#93)", async (t) => {
  const file = join(mkdtempSync(join(tmpdir(), "soab-code-")), "code.txt");
  writeFileSync(file, "482913\n");
  for (const argv of [["--value-env", "One-time code=LAB_CODE"], ["--value-file", `One-time code=${file}`], ["--value-env", "LAB_CODE"]]) {
    const { scopes } = await blockedOnCode(t);
    process.env.LAB_CODE = "482913";
    try {
      const { result, acts, options } = await resume(t, scopes, argv, lab("otp-single", "otp-single-typed", "home"), [
        { operation: "CLICK", target: "2" },
        { operation: "DONE" },
      ]);
      assert.equal(acts[0], "fill @e2 482913", argv.join(" "));
      assert.equal(result.status, "done");
      for (const name of ["status.json", "inferred.jsonl", "observed.jsonl"]) {
        assert.doesNotMatch(readFileSync(join(options.out, name), "utf8"), /482913/);
      }
      assert.doesNotMatch(JSON.stringify(result), /482913/);
    } finally {
      delete process.env.LAB_CODE;
    }
  }
});

test("an unset variable or a missing file is refused by name, and no value is printed (#93)", () => {
  assert.throws(() => parseResumeArgs(["lab", "--value-env", "Code=NOT_SET_ANYWHERE"], {}), /environment variable NOT_SET_ANYWHERE is not set/);
  assert.throws(() => parseResumeArgs(["lab", "--value-file", "Code=/nowhere/code.txt"], {}), /no file at \/nowhere\/code.txt/);
});

/** Six boxes that all read "Verification Code" and set no maxlength, as a real sign-in page drew them; then the boxes full. */
function sameLabelBoxes() {
  return lab("otp-no-advance", "otp-no-advance-typed").map(({ attrs, ...page }) => ({
    ...page,
    snapshot: page.snapshot.replace(/Digit \d of 6/g, "Verification Code"),
    full: page.full.replace(/Digit \d of 6/g, "Verification Code"),
  }));
}

async function blockedOnBoxes(t) {
  const scopes = isolatedScopes();
  const [boxes] = sameLabelBoxes();
  const first = await labRunPages(t, [boxes], [{ operation: "TYPE_TEXT", target: "1", kind: "otp" }], "sign in to Acme", { scopes });
  assert.equal(first.result.blocker.kind, "otp");
  assert.equal(first.result.blocker.fields.length, 6);
  return { scopes, first };
}

test("a code over six boxes that share one label goes in one character a box, bare or under the label", async (t) => {
  for (const argv of [["--value", "792316"], ["--value", "Verification Code=792316"]]) {
    const { scopes } = await blockedOnBoxes(t);
    const { acts, options } = await resume(t, scopes, argv, sameLabelBoxes(), [{ operation: "BLOCKED" }], (args, state) =>
      args[0] === "fill" && args[1] === "@e7" ? 1 : state.index,
    );
    assert.deepEqual(acts.slice(0, 6), ["fill @e2 7", "fill @e3 9", "fill @e4 2", "fill @e5 3", "fill @e6 1", "fill @e7 6"], argv.join(" "));
    assert.doesNotMatch(readFileSync(join(options.out, "inferred.jsonl"), "utf8"), /792316/);
  }
});

test("a value refused on a code block names the label once, says a bare code works, and leaves the run to resume", async (t) => {
  const { scopes, first } = await blockedOnBoxes(t);
  assert.throws(
    () => resumeOptions(scopes, parseResumeArgs(["lab", "--value", "otp=792316"])),
    /^Error: the run is not blocked on a field "otp"; it needs "Verification Code", or the 6-character code as a bare --value$/,
  );
  const options = resumeOptions(scopes, parseResumeArgs(["lab", "--value", "792316"]));
  t.after(() => rmSync(options.out, { recursive: true, force: true }));
  assert.equal(options.resume.from, first.out);
});

test("a resume that failed can be tried again, from the run it went on from", async (t) => {
  const { scopes, first } = await blockedOnCode(t);
  await assert.rejects(resume(t, scopes, ["--value", "482913"], lab("home"), []), /the page has no field "One-time code"/);
  const options = resumeOptions(scopes, parseResumeArgs(["lab", "--value", "482913"]));
  t.after(() => rmSync(options.out, { recursive: true, force: true }));
  assert.equal(options.resume.from, first.out);
});

test("a run directory with no status.json, as an older resume left one, does not hide the blocked run", async (t) => {
  const { scopes, first } = await blockedOnCode(t);
  const empty = join(first.out, "..", "9999-empty");
  mkdirSync(empty);
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const options = resumeOptions(scopes, parseResumeArgs(["lab", "--value", "482913"]));
  t.after(() => rmSync(options.out, { recursive: true, force: true }));
  assert.equal(options.resume.from, first.out);
});
