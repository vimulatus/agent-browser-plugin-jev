import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defaultOut } from "../dist/run.js";
import { actionsBefore, walk } from "../dist/walk.js";
import { lines, replayingJev } from "./helpers.mjs";

const READS = new Set(["snapshot -i", "snapshot", "get title", "get url", "console", "errors", "network requests"]);

function scenario(name) {
  return JSON.parse(readFileSync(new URL(`./replay/${name}.json`, import.meta.url), "utf8"));
}

function walkPages(name) {
  return JSON.parse(readFileSync(new URL("./fixtures/walk-pages.json", import.meta.url), "utf8"))[name];
}

/** An agent-browser over saved pages: `open` goes to the page with that url, and a move table follows each act. */
function walkBrowser(states, moves) {
  const state = { index: 0, calls: [] };
  return {
    state,
    async run(args) {
      const command = args.join(" ");
      state.calls.push(command);
      const opened = args[0] === "open" ? args[1] : null;
      if (opened !== null) {
        const at = states.findIndex((page) => page.url === opened);
        assert.ok(at >= 0, `the walk opened ${opened}, which no saved page serves`);
        state.index = at;
      } else if (moves[`${state.index} ${command}`] !== undefined) {
        state.index = moves[`${state.index} ${command}`];
      }
      const page = states[state.index];
      switch (command) {
        case "snapshot -i":
          return { origin: page.url, snapshot: page.snapshot };
        case "snapshot":
          return { snapshot: page.content ?? page.snapshot };
        case "get title":
          return { title: page.title };
        case "get url":
          return { url: page.url };
        case "console":
          return { messages: page.console ?? [] };
        case "errors":
          return { errors: page.errors ?? [] };
        case "network requests":
          return { requests: page.requests ?? [] };
        default:
          return {};
      }
    },
  };
}

/** A policy Jev that answers from the next recorded reply and refuses a question that reply does not answer. */
function replayingPolicyJev(recorded) {
  const calls = [];
  return {
    calls,
    async ask(state, questions) {
      calls.push({ state, questions });
      const recording = recorded[calls.length - 1];
      assert.ok(recording, `no recorded policy reply for call ${calls.length}`);
      return Object.fromEntries(
        Object.keys(questions).map((id) => {
          assert.ok(id in recording.answers, `no recorded answer for "${id}"`);
          return [id, recording.answers[id]];
        }),
      );
    },
  };
}

const silent = {
  async ask() {
    throw new Error("a policy with no judge section must not call Jev");
  },
};

function acts(browser) {
  return browser.state.calls.filter((call) => !READS.has(call));
}

function json(out, name) {
  return JSON.parse(readFileSync(join(out, name), "utf8"));
}

async function drive(name, { moves = {}, repro = {}, ...overrides } = {}) {
  const recorded = scenario(name);
  const browser = walkBrowser(walkPages(recorded.pages), moves);
  const replay = walkBrowser(walkPages(repro.pages ?? recorded.pages), repro.moves ?? {});
  const jev = replayingJev(recorded.walk ?? recorded.responses);
  const policyJev = recorded.policy === undefined ? silent : replayingPolicyJev(recorded.policy);
  const options = {
    goal: "",
    session: "jev-test",
    maxSteps: 30,
    out: defaultOut(),
    allow: "all",
    model: "jev-latest",
    human: false,
    policy: "errors",
    ...overrides,
  };
  const result = await walk(options, { browser, repro: replay, jev, policyJev });
  return { result, browser, repro: replay, jev, policyJev, out: options.out };
}

test("a walk fills a form from the fixtures, and a field no fixture fits lands in unfilled.json", async (t) => {
  const { result, browser, jev, out } = await drive("walk-signup", {
    url: "http://127.0.0.1:8765/signup.html",
    moves: {
      "0 fill @e2 jev.tester@example.com": 1,
      "1 fill @e3 Test-Passw0rd-42": 2,
      "2 click @e5": 3,
    },
  });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.deepEqual(acts(browser), [
    "open http://127.0.0.1:8765/signup.html",
    "fill @e2 jev.tester@example.com",
    "fill @e3 Test-Passw0rd-42",
    "click @e5",
  ]);
  assert.deepEqual(json(out, "unfilled.json"), [
    { label: "Company", url: "http://127.0.0.1:8765/signup.html" },
  ]);
  assert.equal(result.steps, 4);
  assert.equal(result.actions, 3);
  assert.match(result.reason, /every control the walk found has been tried/);
});

test("the fixture Choice offers every key and a NONE, and the walk logs the key it used", async (t) => {
  const { jev, out } = await drive("walk-signup", {
    url: "http://127.0.0.1:8765/signup.html",
    moves: { "0 fill @e2 jev.tester@example.com": 1, "1 fill @e3 Test-Passw0rd-42": 2, "2 click @e5": 3 },
  });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const asked = jev.requests[0].questions;
  assert.deepEqual(Object.keys(asked), ["next_element", "fixture_value_1", "fixture_value_2", "fixture_value_3"]);
  assert.deepEqual(Object.keys(asked.fixture_value_1.criteria), [
    "email",
    "password",
    "name",
    "phone",
    "address",
    "NONE",
  ]);
  assert.equal(asked.fixture_value_1.criteria.email, "jev.tester@example.com");

  const steps = lines(join(out, "steps.jsonl"));
  assert.deepEqual(
    steps.map((step) => [step.label, step.fixture, step.value, step.executed]),
    [
      ["Email", "email", "jev.tester@example.com", true],
      ["Password", "password", "•••", true],
      ["Company", null, null, false],
      ["Create account", null, null, true],
    ],
  );
  assert.equal(steps[2].reason, "no fixture value belongs in Company");
  assert.equal(jev.requests.length, 3, "the one control left on the last step is taken without a question");
});

test("the last three actions before a finding are replayable from the run directory", async (t) => {
  const { out } = await drive("walk-signup", {
    url: "http://127.0.0.1:8765/signup.html",
    moves: { "0 fill @e2 jev.tester@example.com": 1, "1 fill @e3 Test-Passw0rd-42": 2, "2 click @e5": 3 },
  });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.deepEqual(
    actionsBefore(out, 5).map((action) => [action.step, action.kind, action.ref, action.label]),
    [
      [1, "TYPE_TEXT", "e2", "Email"],
      [2, "TYPE_TEXT", "e3", "Password"],
      [4, "CLICK", "e5", "Create account"],
    ],
  );
  assert.deepEqual(actionsBefore(out, 2).map((action) => action.label), ["Email"]);
});

const SIGNUP = "http://127.0.0.1:8765/signup.html";
const WELCOME = "http://127.0.0.1:8765/welcome.html";
const FILLED_IN = {
  "0 fill @e2 jev.tester@example.com": 1,
  "1 fill @e3 Test-Passw0rd-42": 2,
};

/** The walk fills the form and lands on a page that logs an error; the replay takes the same three actions. */
function signupRun(reproPages) {
  return {
    url: SIGNUP,
    moves: { ...FILLED_IN, "2 click @e4": 3 },
    repro: { pages: reproPages, moves: { ...FILLED_IN, "2 click @e4 --human": 3 } },
  };
}

test("a finding is replayed on its own session, with a shot per action and the console it printed", async (t) => {
  const { result, browser, repro, out } = await drive("walk-repro", signupRun("signup-bug"));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const evidence = (name) => join(out, "evidence", name);
  assert.deepEqual(acts(repro), [
    "console --clear",
    "errors --clear",
    "network requests --clear",
    "tab new about:blank",
    `record start ${evidence("1.webm")} --cursor`,
    `open ${SIGNUP}`,
    "wait --load networkidle",
    "fill @e2 jev.tester@example.com",
    "wait --load load",
    `screenshot ${evidence("1-1.png")}`,
    "fill @e3 Test-Passw0rd-42",
    "wait --load load",
    `screenshot ${evidence("1-2.png")}`,
    "click @e4 --human",
    "wait --load load",
    `screenshot ${evidence("1-3.png")}`,
    "record stop",
    "tab close",
    "close",
  ]);
  assert.deepEqual(
    acts(browser).filter((call) => /^(record|screenshot|tab|close)/.test(call)),
    [],
    "the walk's own session neither records nor changes tab",
  );

  const { findings, summary } = json(out, "findings.json");
  const [finding] = findings;
  assert.equal(finding.title, `${WELCOME} logs TypeError: order is not defined`);
  assert.equal(finding.reproduced, true);
  assert.equal(finding.recording, evidence("1.webm"));
  assert.deepEqual(finding.repro, [
    { action: 'fill "Email" with "jev.tester@example.com"', url: SIGNUP, screenshot: evidence("1-1.png") },
    { action: 'fill "Password" with "•••"', url: SIGNUP, screenshot: evidence("1-2.png") },
    { action: 'click "Create account"', url: WELCOME, screenshot: evidence("1-3.png") },
  ]);
  assert.deepEqual(finding.console, ["error: TypeError: order is not defined"]);
  assert.deepEqual(finding.errors, []);
  assert.deepEqual(summary, [{ title: finding.title, severity: "medium", where: WELCOME }]);
  assert.equal(result.findings, 1);
});

test("a finding the replay cannot raise again is kept, unreproduced", async (t) => {
  const { result, repro, out } = await drive("walk-repro", signupRun("signup-clean"));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const { findings, summary } = json(out, "findings.json");
  assert.equal(findings.length, 1);
  assert.equal(summary.length, findings.length);
  assert.deepEqual(
    [findings[0].reproduced, findings[0].repro, findings[0].recording],
    [false, undefined, undefined],
  );
  assert.deepEqual(acts(repro).slice(-3), ["record stop", "tab close", "close"]);
  assert.equal(result.findings, 1);
});

test("a control the replay no longer finds on the page makes the finding a one-off", async (t) => {
  const { repro, out } = await drive("walk-repro", signupRun("signup-moved"));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.equal(json(out, "findings.json").findings[0].reproduced, false);
  assert.deepEqual(acts(repro), [
    "console --clear",
    "errors --clear",
    "network requests --clear",
    "tab new about:blank",
    `record start ${join(out, "evidence", "1.webm")} --cursor`,
    `open ${SIGNUP}`,
    "wait --load networkidle",
    "record stop",
    "tab close",
    "close",
  ]);
});

test("a finding from a request the page makes on load is replayed once the fresh tab has settled", async (t) => {
  const orders = "http://127.0.0.1:8765/orders.html";
  const { result, repro, out } = await drive("walk-load-request", {
    url: orders,
    repro: { pages: "orders-500-loading", moves: { "0 wait --load networkidle": 1 } },
  });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const { findings } = json(out, "findings.json");
  assert.equal(result.findings, 1);
  assert.equal(findings[0].title, "GET /api/orders returned 500");
  assert.equal(findings[0].reproduced, true);
  assert.equal(findings[0].recording, join(out, "evidence", "1.webm"));
  assert.deepEqual(findings[0].repro, [], "a finding on the page the walk started from is replayed with no action");

  assert.deepEqual(acts(repro), [
    "console --clear",
    "errors --clear",
    "network requests --clear",
    "tab new about:blank",
    `record start ${join(out, "evidence", "1.webm")} --cursor`,
    `open ${orders}`,
    "wait --load networkidle",
    "record stop",
    "tab close",
    "close",
  ]);
});

test("every control is tried once across pages, and the frontier sends the walk back for the ones it left", async (t) => {
  const { result, browser, out } = await drive("walk-shop", {
    url: "http://127.0.0.1:8765/index.html",
    moves: { "0 click @e2": 1 },
  });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.deepEqual(acts(browser), [
    "open http://127.0.0.1:8765/index.html",
    "click @e2",
    "click @e2",
    "open http://127.0.0.1:8765/index.html",
    "click @e3",
  ]);
  assert.deepEqual(
    json(out, "frontier.json").map((entry) => [entry.path, entry.role, entry.label, entry.tried]),
    [
      ["/index.html", "link", "Orders", true],
      ["/index.html", "button", "Refresh", true],
      ["/orders.html", "button", "Save", true],
    ],
  );
  assert.equal(result.steps, 3);
  assert.equal(result.actions, 3);
});

test("the same console error on two pages is one finding with a repeat per sighting", async (t) => {
  const { result, jev, out } = await drive("walk-shop", {
    url: "http://127.0.0.1:8765/index.html",
    moves: { "0 click @e2": 1 },
  });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const { findings, summary } = json(out, "findings.json");
  assert.equal(findings.length, 1);
  assert.equal(summary.length, findings.length);
  assert.equal(result.findings, 1);
  assert.deepEqual(
    [findings[0].title, findings[0].severity, findings[0].where, findings[0].step],
    [
      "http://127.0.0.1:8765/index.html logs TypeError: cart is not defined",
      "medium",
      "http://127.0.0.1:8765/index.html",
      1,
    ],
  );
  assert.deepEqual(
    findings[0].repeats.map((repeat) => repeat.where),
    [
      "http://127.0.0.1:8765/orders.html",
      "http://127.0.0.1:8765/orders.html",
      "http://127.0.0.1:8765/index.html",
      "http://127.0.0.1:8765/index.html",
    ],
  );
  assert.deepEqual(Object.keys(jev.requests[1].questions), ["same_as_finding_0"]);
  assert.equal(jev.requests[1].state.findings.length, 1);
});

test("a destructive control is marked tried and never activated without --allow", async (t) => {
  const { result, browser, out } = await drive("walk-dashboard", {
    url: "http://127.0.0.1:8765/index.html",
    allow: new Set(),
    moves: { "0 click @e3": 1 },
  });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const [denied] = lines(join(out, "steps.jsonl"));
  assert.equal(denied.label, "Delete account");
  assert.equal(denied.executed, false);
  assert.equal(denied.reason, "delete is destructive and not in --allow");
  assert.deepEqual(denied.destructive, { probability: 0.96, verb: "delete" });
  assert.equal(json(out, "frontier.json")[0].tried, true, "a denied control is not offered again");
  assert.equal(result.actions, 1);
});

test("a click that leaves the start origin is undone before the next step", async (t) => {
  const { browser, out } = await drive("walk-dashboard", {
    url: "http://127.0.0.1:8765/index.html",
    allow: new Set(),
    moves: { "0 click @e3": 1 },
  });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.deepEqual(acts(browser), [
    "open http://127.0.0.1:8765/index.html",
    "click @e3",
    "open http://127.0.0.1:8765/index.html",
  ]);
});

test("the policy is told which control the walk clicked, and each new finding is judged for severity", async (t) => {
  const { result, jev, policyJev, out } = await drive("walk-bug", {
    url: "http://127.0.0.1:8765/orders.html",
    policy: "bug-hunt",
  });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  assert.deepEqual(Object.keys(policyJev.calls[0].questions), ["page_shows_error_to_user", "stuck_loading"]);
  assert.equal(
    policyJev.calls[3].questions.outcome_matches_action.instructions.question,
    'The user just did CLICK on "Save". Does the page now show what that promises?',
  );
  assert.match(policyJev.calls[0].state.page.text, /Something went wrong/);

  const { findings, summary } = json(out, "findings.json");
  assert.equal(summary.length, findings.length);
  assert.deepEqual(
    findings.map((finding) => [finding.title, finding.severity, finding.step, finding.repeats.length]),
    [
      ["/orders.html shows the user an error", "medium", 1, 1],
      ["Clicking Save on /orders.html does nothing", "high", 2, 0],
    ],
  );
  assert.equal(result.findings, 2);
  assert.deepEqual(Object.keys(jev.requests[1].questions), ["same_as_finding_0", "same_as_finding_1"]);
  assert.equal(jev.requests[1].state.finding.title, "/orders.html shows the user an error");
  assert.deepEqual(
    actionsBefore(out, findings[1].step).map((action) => [action.kind, action.ref]),
    [["CLICK", "e2"]],
  );
});

test("a walk carries durationMs, in its result and in status.json", async (t) => {
  const { result, out } = await drive("walk-signup", {
    url: "http://127.0.0.1:8765/signup.html",
    moves: {
      "0 fill @e2 jev.tester@example.com": 1,
      "1 fill @e3 Test-Passw0rd-42": 2,
      "2 click @e5": 3,
    },
  });
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const written = json(out, "status.json").durationMs;
  assert.ok(Number.isInteger(written) && written >= 0, `status.json holds durationMs ${written}`);
  assert.ok(
    Number.isInteger(result.durationMs) && result.durationMs >= 0,
    `the result holds durationMs ${result.durationMs}`,
  );
  assert.ok(result.durationMs >= written, "the result is measured after the last status write");
});

test("a policy that records a HAR cannot drive a walk", async () => {
  await assert.rejects(
    drive("walk-shop", { policy: "perf", url: "http://127.0.0.1:8765/index.html" }),
    /judge one page with --max-steps 0/,
  );
});
