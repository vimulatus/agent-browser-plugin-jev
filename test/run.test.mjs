import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
    human: false,
    handoff: true,
    loginTimeoutMs: 200,
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

function findings(out) {
  return JSON.parse(readFileSync(join(out, "findings.json"), "utf8"));
}

/** A policy Jev that answers nothing: a policy with no judge section must never reach the paid API. */
function unaskedJev() {
  const calls = [];
  return {
    calls,
    async ask(state, questions) {
      calls.push({ state, questions });
      throw new Error(`no recorded policy answer for ${Object.keys(questions).join(", ")}`);
    },
  };
}

async function drive(name, goal, overrides = {}, advance) {
  const scenario = JSON.parse(readFileSync(new URL(`./replay/${name}.json`, import.meta.url), "utf8"));
  const browser = scriptedBrowser(pages(scenario.pages), advance);
  const jev = replayingJev(replay(name));
  const policyJev = unaskedJev();
  const run_options = options(goal ?? scenario.goal, overrides);
  const result = await run(run_options, { browser, jev, policyJev });
  return { result, browser, jev, policyJev, out: run_options.out };
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

test("a goal run without a policy judges nothing and writes no findings", async (t) => {
  const { result, out } = await drive("login");
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.equal(result.findings, 0);
  assert.equal(status(out).policy, null);
  assert.equal(existsSync(join(out, "findings.json")), false);
  assert.equal(result.findingsFile, undefined, "a run that wrote no findings.json names none");
  assert.equal("findingsFile" in status(out), false);
});

test("a goal run with --policy raises the console error the login page logs", async (t) => {
  const { result, policyJev, out } = await drive("login-policy", null, { policy: "errors" });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const error = "Uncaught TypeError: cannot read properties of null";
  const where = "http://127.0.0.1:8765/login.html";
  assert.equal(result.status, "done");
  assert.equal(result.findings, 1);
  assert.deepEqual(findings(out), {
    findings: [
      {
        title: `${where} logs ${error}`,
        severity: "medium",
        where,
        step: 2,
        evidence: { console: { type: "error", text: error } },
        repeats: [{ step: 3, where }],
      },
    ],
    summary: [{ title: `${where} logs ${error}`, severity: "medium", where }],
  });
  assert.equal(status(out).findings, 1);
  assert.equal(status(out).policy, "errors");
  assert.deepEqual(policyJev.calls, [], "a policy with no judge section asks Jev nothing");
});

test("a goal run with --policy names findings.json, and status.json names the same path", async (t) => {
  const { result, out } = await drive("login-policy", null, { policy: "errors" });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const file = join(out, "findings.json");
  assert.equal(result.findingsFile, file);
  assert.ok(isAbsolute(result.findingsFile), result.findingsFile);
  assert.equal(status(out).findingsFile, file);
});

test("a policy that collects a HAR is refused: a goal run cannot reload the page under itself", async (t) => {
  const run_options = options("log in", { policy: "perf" });
  t.after(() => rmSync(run_options.out, { recursive: true, force: true }));
  await assert.rejects(
    run(run_options, { browser: scriptedBrowser(pages("login")), jev: replayingJev([]), policyJev: unaskedJev() }),
    /policy perf: a HAR is recorded over a reload.*--max-steps 0/,
  );
});

test("the typed password is masked in the run log", async (t) => {
  const { out } = await drive("login");
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const [email, password] = steps(out);
  assert.equal(email.value, "alice@example.com");
  assert.equal(password.label, "Password");
  assert.equal(password.value, "•••");
});

test("each typed step logs the probability of every offered value", async (t) => {
  const { out } = await drive("login");
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const [email, password, click] = steps(out);
  assert.deepEqual(email.valueProbabilities, {
    "alice@example.com": 0.9,
    "password secret": 0.02,
    password: 0.03,
    secret: 0.04,
    NONE: 0.01,
  });
  assert.equal(password.valueProbabilities.secret, 0.84);
  assert.deepEqual(click.valueProbabilities, {});
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

test("a value span under the threshold blocks the run with --no-handoff", async (t) => {
  const { result, browser, out } = await drive("weak-value", null, { handoff: false });
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

test("--record wraps the run in a cursor recording and --human curves every click", async (t) => {
  const record = "/tmp/jev-record/demo.webm";
  const { result, browser, out } = await drive("login", null, { record, human: true });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.deepEqual(acts(browser), [
    `record start ${record} --cursor`,
    "fill @e5 alice@example.com",
    "fill @e6 secret",
    "click @e4 --human",
    "record stop",
  ]);
  assert.equal(result.record, record);
  assert.equal(status(out).record, record);
});

test("--record without --human records the same run with an instant pointer", async (t) => {
  const record = "/tmp/jev-record/instant.webm";
  const { browser, out } = await drive("login", null, { record });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.deepEqual(acts(browser), [
    `record start ${record} --cursor`,
    "fill @e5 alice@example.com",
    "fill @e6 secret",
    "click @e4",
    "record stop",
  ]);
  assert.ok(!browser.state.calls.some((call) => call.includes("--human")));
});

test("a run that throws ends failed in status.json and still stops the recording", async (t) => {
  const record = "/tmp/jev-record/failed.webm";
  const browser = scriptedBrowser(pages("login"));
  const served = browser.run.bind(browser);
  browser.run = async (args) => {
    if (args.join(" ") === "get title") throw new Error("the browser session is gone");
    return served(args);
  };
  const run_options = options("log in", { record });
  t.after(() => rmSync(run_options.out, { recursive: true, force: true }));

  await assert.rejects(run(run_options, { browser, jev: replayingJev([]) }), /the browser session is gone/);
  assert.equal(status(run_options.out).status, "failed");
  assert.match(status(run_options.out).reason, /the browser session is gone/);
  assert.deepEqual(acts(browser), [`record start ${record} --cursor`, "record stop"]);
});

test("the recording starts on the page --url opened, not on the page before it", async (t) => {
  const record = "/tmp/jev-record/opened.webm";
  const { browser, out } = await drive("login", null, { record, url: "http://127.0.0.1:8765/login.html" });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.deepEqual(browser.state.calls.slice(0, 2), [
    "open http://127.0.0.1:8765/login.html",
    `record start ${record} --cursor`,
  ]);
});

test("a goal run carries durationMs, and jev.status reads back the number the run ended on", async (t) => {
  const { result, out } = await drive("login");
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const written = status(out).durationMs;
  assert.ok(Number.isInteger(written) && written >= 0, `status.json holds durationMs ${written}`);
  assert.ok(
    Number.isInteger(result.durationMs) && result.durationMs >= 0,
    `the result holds durationMs ${result.durationMs}`,
  );
  assert.ok(result.durationMs >= written, "the result is measured after the last status write");
  assert.equal(status(out).durationMs, written, "a run that has ended reports the same duration every time");
});

const LOGIN = "http://127.0.0.1:8765/login.html";
const SETTINGS = "http://127.0.0.1:8765/settings.html";
const HEADED = `open ${LOGIN} --restore jev-test --headed`;

/** The person signs in on the window: each poll after the headed open serves the next page in `byPoll`, then the last one stays. */
function signsIn(byPoll) {
  let poll = null;
  return (args, state) => {
    if (args[0] === "open" && args.includes("--headed")) {
      poll = 0;
      return state.index;
    }
    if (poll !== null && poll < byPoll.length && args.join(" ") === "snapshot -i") return byPoll[poll++];
    return state.index;
  };
}

function polls(browser) {
  const { calls } = browser.state;
  return calls.slice(calls.indexOf(HEADED) + 1, calls.lastIndexOf("close"));
}

test("a login page the goal cannot fill is handed to a window, and the run goes on signed in", async (t) => {
  const { result, browser, jev, out } = await drive("handoff", null, {}, signsIn([0, 3]));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.equal(result.status, "done");
  assert.equal(result.url, SETTINGS);
  assert.deepEqual(acts(browser), [
    "auth list",
    "close",
    HEADED,
    "wait --load networkidle",
    "close",
    `open ${SETTINGS} --restore jev-test`,
    "wait --load networkidle",
  ]);
  assert.deepEqual(polls(browser), ["wait --load networkidle", "snapshot -i", "snapshot -i"]);
  const [login, done] = steps(out);
  assert.equal(login.operation, "BLOCKED");
  assert.equal(login.executed, true);
  assert.equal(login.value, "•••");
  assert.equal(login.reason, "signed in by hand in a window");
  assert.equal(jev.requests[1].state.recent_actions[0].pageChanged, true, "Jev is told the login moved the page");
  assert.equal(done.operation, "DONE");
  assert.equal(result.actions, 1);
  assert.deepEqual(result.recordings, []);
  assert.equal(status(out).status, "done");
});

test("status.json reads login with the page while the window is open", async (t) => {
  const run_options = options("open the settings page");
  t.after(() => rmSync(run_options.out, { recursive: true, force: true }));
  const browser = scriptedBrowser(pages("login"), signsIn([0, 3]));
  const served = browser.run.bind(browser);
  const seen = [];
  browser.run = async (args) => {
    if (args.join(" ") === "snapshot -i" && browser.state.calls.includes(HEADED) && seen.length === 0) {
      seen.push(status(run_options.out));
    }
    return served(args);
  };

  await run(run_options, { browser, jev: replayingJev(replay("handoff")), policyJev: unaskedJev() });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, "login");
  assert.equal(seen[0].url, LOGIN);
  assert.equal(status(run_options.out).status, "done");
});

test("a saved auth profile for the page signs in without a window, and the step is logged masked", async (t) => {
  const advance = (args, state) => (args.join(" ") === "auth login acme" ? 3 : state.index);
  const run_options = options("open the settings page");
  t.after(() => rmSync(run_options.out, { recursive: true, force: true }));
  const browser = scriptedBrowser(pages("login"), advance);
  const served = browser.run.bind(browser);
  browser.run = async (args) => {
    const data = await served(args);
    if (args.join(" ") === "auth list") {
      return {
        profiles: [
          { name: "other", url: "http://127.0.0.1:9999/login.html", username: "bob" },
          { name: "acme", url: `${LOGIN}?next=%2Fsettings.html`, username: "alice@example.com" },
        ],
      };
    }
    return data;
  };

  const result = await run(run_options, { browser, jev: replayingJev(replay("handoff")), policyJev: unaskedJev() });
  assert.equal(result.status, "done");
  assert.deepEqual(acts(browser), ["auth list", "auth login acme"]);
  const [login] = steps(run_options.out);
  assert.equal(login.executed, true);
  assert.equal(login.value, "•••");
  assert.equal(login.reason, "signed in with the auth profile acme");
});

test("a password field the goal has no value for takes the same road as a blocked login page", async (t) => {
  const { result, browser, out } = await drive("handoff-password", null, {}, signsIn([3]));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.equal(result.status, "done");
  assert.equal(acts(browser)[0], "auth list");
  const [login] = steps(out);
  assert.equal(login.operation, "TYPE_TEXT");
  assert.equal(login.label, "Password");
  assert.equal(login.value, "•••");
  assert.equal(login.executed, true);
});

test("an SSO page on the way is not taken for the app: the run waits until the person is back on an origin it knows", async (t) => {
  const { result, browser, out } = await drive("handoff-sso", null, {}, signsIn([1, 2]));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.equal(result.status, "done");
  assert.deepEqual(polls(browser), ["wait --load networkidle", "snapshot -i", "snapshot -i"]);
  assert.ok(acts(browser).includes(`open ${SETTINGS} --restore jev-test`));
  assert.ok(!acts(browser).some((call) => call.includes("accounts.example-sso.test")));
});

test("a login nobody completes times out, closes the window and ends the run blocked", async (t) => {
  const { result, browser, out } = await drive("handoff", null, { loginTimeoutMs: 0 }, signsIn([]));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, `the login on ${LOGIN} timed out after 0 s in the window`);
  assert.deepEqual(acts(browser), ["auth list", "close", HEADED, "wait --load networkidle", "close"]);
  assert.deepEqual(polls(browser), ["wait --load networkidle", "snapshot -i"]);
  const [login] = steps(out);
  assert.equal(login.executed, false);
  assert.match(login.reason, /timed out/);
  assert.equal(status(out).status, "blocked");
  assert.equal(status(out).reason, result.reason);
});

test("a recorded run stops the recording for the window and records the rest to a second file", async (t) => {
  const record = "/tmp/jev-record/handoff.webm";
  const { result, browser, out } = await drive("handoff", null, { record }, signsIn([0, 3]));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const second = "/tmp/jev-record/handoff-2.webm";
  assert.deepEqual(acts(browser), [
    `record start ${record} --cursor`,
    "auth list",
    "record stop",
    "close",
    HEADED,
    "wait --load networkidle",
    "close",
    `open ${SETTINGS} --restore jev-test`,
    "wait --load networkidle",
    `record start ${second} --cursor`,
    "record stop",
  ]);
  assert.equal(result.record, record);
  assert.deepEqual(result.recordings, [record, second]);
  assert.deepEqual(status(out).recordings, [record, second]);
});

test("--no-handoff keeps a blocked login page blocked, and touches neither the vault nor the browser", async (t) => {
  const { result, browser, out } = await drive("handoff", null, { handoff: false });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "no supported operation can make progress");
  assert.deepEqual(acts(browser), []);
});

test("a field with no value on a page with no password field is still blocked, not handed off", async (t) => {
  const { result, browser, out } = await drive("no-value");
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.equal(result.status, "blocked");
  assert.match(result.reason, /holds no value for Search/);
  assert.deepEqual(acts(browser), []);
});
