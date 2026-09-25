import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { observe } from "../dist/observe.js";
import { driven, isolatedScopes } from "./helpers.mjs";
import { applyPolicy, judge, judgeFindings, judgePage, loadPolicy } from "../dist/policy/index.js";

// An orders page that answers 500 on load, shows a "Something went wrong" banner and has a Save button that only
// logs, captured from agent-browser 0.38.1 against a local server right after clicking Save.
const FIXTURES = fileURLToPath(new URL("./fixtures/bug-hunt/", import.meta.url));
const FAKE_BIN = fileURLToPath(new URL("./bin/", import.meta.url));

// Four replies in the shape the System One API answers with. Written by hand: no TYPESAFE_API_KEY was readable
// when this was built, and tests never call the paid API.
const RECORDED = JSON.parse(readFileSync(new URL("./replay/bug-hunt.json", import.meta.url), "utf8"));

function reply(command) {
  return JSON.parse(readFileSync(`${FIXTURES}${command}.json`, "utf8")).data;
}

const replies = {
  "snapshot -i": reply("snapshot-i"),
  snapshot: reply("snapshot"),
  "get title": reply("get-title"),
  console: reply("console"),
  errors: reply("errors"),
  "network requests": reply("network-requests"),
};

/** A Jev that answers each call from the next recorded reply, and refuses a question that reply does not answer. */
function replay(...recorded) {
  const calls = [];
  return {
    calls,
    ask: async (state, questions) => {
      calls.push({ state, questions });
      const { answers } = recorded[calls.length - 1];
      return Object.fromEntries(
        Object.keys(questions).map((id) => {
          if (!(id in answers)) throw new Error(`no recorded answer for "${id}"`);
          return [id, answers[id]];
        }),
      );
    },
  };
}

const policy = await loadPolicy("bug-hunt", isolatedScopes());
const orders = await observe(driven({ run: async (args) => replies[args.join(" ")] }));
const content = replies.snapshot.snapshot;
const previous = { hash: orders.hash, action: { kind: "CLICK", label: "Save" } };

/** One step of the walk: judge the page, apply the policy, then judge the severity of what it found. */
async function step(gathered, jev) {
  const inferences = await judge(policy, orders, gathered, jev);
  const applied = applyPolicy(policy, orders, { ...gathered, inferences });
  const judged = await judgeFindings(policy, orders, gathered, applied, jev);
  return { findings: judged.findings, inferences: [...inferences, ...judged.inferences] };
}

const jev = replay(RECORDED.step, RECORDED.step_findings);
const judged = await step({ content, previous }, jev);

test("the page pass asks the three page questions, and names the control the walk clicked", () => {
  assert.deepEqual(Object.keys(jev.calls[0].questions), [
    "page_shows_error_to_user",
    "outcome_matches_action",
    "stuck_loading",
  ]);
  assert.deepEqual(jev.calls[0].questions.outcome_matches_action.instructions, {
    question: 'The user just did CLICK on "Save". Does the page now show what that promises?',
    subject: "`page`",
  });
  assert.deepEqual(Object.keys(jev.calls[0].questions.outcome_matches_action.criteria), [
    "expected",
    "nothing",
    "wrong",
  ]);
});

test("collecting content puts the text the user reads in front of Jev, which snapshot -i leaves out", () => {
  assert.match(jev.calls[0].state.page.text, /Something went wrong/);
  assert.doesNotMatch(orders.text, /Something went wrong/);
});

test("the dead Save button, the 500, the console error and the banner come out as four findings", () => {
  assert.deepEqual(
    judged.findings.map((finding) => finding.title),
    [
      "Clicking Save on /index.html does nothing",
      "GET /api/orders returned 500",
      "/index.html logs orders request failed: 500",
      "/index.html shows the user an error",
    ],
  );
});

test("the severity of each finding comes from the Choice, one question per finding", () => {
  assert.deepEqual(Object.keys(jev.calls[1].questions), ["severity#0", "severity#1", "severity#2", "severity#3"]);
  assert.deepEqual(jev.calls[1].questions["severity#1"].instructions, {
    question: "What does this finding cost the person using the app?",
    subject: "`findings[1]`",
  });
  assert.deepEqual(jev.calls[1].state.findings[0], {
    title: "Clicking Save on /index.html does nothing",
    evidence: judged.findings[0].evidence,
  });
  assert.deepEqual(
    judged.findings.map((finding) => finding.severity),
    ["high", "critical", "medium", "medium"],
  );
});

test("every answer of both passes is an inference with what it judged", () => {
  assert.deepEqual(
    judged.inferences.map((inference) => [inference.question, inference.over, inference.index, inference.answer]),
    [
      ["page_shows_error_to_user", "page", 0, 0.96],
      ["outcome_matches_action", "page", 0, "nothing"],
      ["stuck_loading", "page", 0, 0.04],
      ["severity", "finding", 0, "high"],
      ["severity", "finding", 1, "critical"],
      ["severity", "finding", 2, "medium"],
      ["severity", "finding", 3, "medium"],
    ],
  );
  assert.deepEqual(judged.inferences[4].probabilities, { critical: 0.69, high: 0.27, medium: 0.03, low: 0.01 });
  const rated = judged.findings[1];
  assert.deepEqual(judged.inferences[4].item, { title: rated.title, evidence: rated.evidence });
});

test("a page whose hash moved after the click is not a dead control", async () => {
  const moved = { content, previous: { hash: "0".repeat(64), action: previous.action } };
  const inferences = await judge(policy, orders, moved, replay(RECORDED.step));
  assert.deepEqual(
    applyPolicy(policy, orders, { ...moved, inferences }).map((finding) => finding.title),
    ["GET /api/orders returned 500", "/index.html logs orders request failed: 500", "/index.html shows the user an error"],
  );
});

test("before the walk has acted, the question that names the action is not asked", async () => {
  const first = replay(RECORDED.page_only, RECORDED.page_only_findings);
  const judgedFirst = await step({ content }, first);
  assert.deepEqual(Object.keys(first.calls[0].questions), ["page_shows_error_to_user", "stuck_loading"]);
  assert.deepEqual(
    judgedFirst.findings.map((finding) => [finding.title, finding.severity]),
    [
      ["GET /api/orders returned 500", "critical"],
      ["/index.html logs orders request failed: 500", "medium"],
      ["/index.html shows the user an error", "medium"],
    ],
  );
});

test("run --policy bug-hunt --max-steps 0 collects the content, judges twice and writes both passes", async () => {
  process.env.PATH = `${FAKE_BIN}:${process.env.PATH}`;
  process.env.JEV_FIXTURES = FIXTURES;
  const out = mkdtempSync(join(tmpdir(), "jev-bug-hunt-"));
  const jevPage = replay(RECORDED.page_only, RECORDED.page_only_findings);

  const result = await judgePage({ session: "bug-hunt", policyPath: "bug-hunt", out, jev: jevPage, scopes: isolatedScopes() });

  assert.equal(jevPage.calls.length, 2);
  assert.deepEqual(
    result.findings.map((finding) => [finding.title, finding.severity]),
    [
      ["GET /api/orders returned 500", "critical"],
      ["/index.html logs orders request failed: 500", "medium"],
      ["/index.html shows the user an error", "medium"],
    ],
  );
  const inferred = readFileSync(result.inferred, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    inferred.map((inference) => [inference.question, inference.index]),
    [
      ["page_shows_error_to_user", 0],
      ["stuck_loading", 0],
      ["severity", 0],
      ["severity", 1],
      ["severity", 2],
    ],
  );
});

test("with no --out, --max-steps 0 writes its answers under the session, like every other run", async () => {
  process.env.PATH = `${FAKE_BIN}:${process.env.PATH}`;
  process.env.JEV_FIXTURES = FIXTURES;
  const scopes = isolatedScopes();
  const jev = replay(RECORDED.page_only, RECORDED.page_only_findings);

  const result = await judgePage({ session: "bug-hunt", policyPath: "bug-hunt", jev, scopes });

  assert.equal(dirname(dirname(result.inferred)), join(scopes.global.dir, "sessions", "bug-hunt", "runs"));
});

/** A page that loads with nothing wrong on its face, and the page questions answered that way. */
function quietPage({ errors = [], messages = [] }) {
  const run = async (args) =>
    ({
      "snapshot -i": { origin: "http://127.0.0.1:8765/cart.html", snapshot: '- button "Checkout" [ref=e1]' },
      "get title": { title: "Cart" },
      console: { messages },
      errors: { errors },
      "network requests": { requests: [] },
    })[args.join(" ")];
  return observe(driven({ run }));
}

const QUIET = { answers: { page_shows_error_to_user: { type: "noul", noul: 0.04 }, stuck_loading: { type: "noul", noul: 0.03 } } };
const HIGH = {
  answers: {
    "severity#0": { type: "choice", choice: "high", confidence: 0.7, probabilities: { critical: 0.1, high: 0.7, medium: 0.15, low: 0.05 } },
  },
};

async function hunt(page) {
  const jev = replay(QUIET, HIGH);
  const inferences = await judge(policy, page, {}, jev);
  const applied = applyPolicy(policy, page, { inferences });
  return (await judgeFindings(policy, page, {}, applied, jev)).findings.map((finding) => [finding.title, finding.severity]);
}

test("bug-hunt reports a page that throws on load, as errors does (#111)", async () => {
  const page = await quietPage({ errors: [{ text: "TypeError: Cannot read properties of undefined (reading 'xyz')", url: "http://127.0.0.1:8765/cart.html", line: 3, column: 9 }] });
  assert.deepEqual(await hunt(page), [["/cart.html throws TypeError: Cannot read properties of undefined (reading 'xyz')", "high"]]);
});

test("bug-hunt reports a page that logs a console error, as errors does (#111)", async () => {
  const page = await quietPage({ messages: [{ type: "error", text: "cart total is NaN" }, { type: "log", text: "cart ready" }] });
  assert.deepEqual(await hunt(page), [["/cart.html logs cart total is NaN", "high"]]);
});

// A title says what the user can see happening. What made it happen is the reader's job, not Jev's.
const CAUSAL = [/because/i, /due to/i, /caused by/i, /bug in/i];

test("every title of every shipped policy names a behaviour and none names a cause", async () => {
  const scopes = isolatedScopes();
  const policies = await Promise.all(["bug-hunt", "errors", "perf"].map((name) => loadPolicy(name, scopes)));
  const titles = policies.flatMap((policy) =>
    policy.rules.map((rule) => rule.title.filter((part) => typeof part === "string").join(" ")),
  );
  assert.equal(titles.length, 12);
  for (const title of titles) for (const cause of CAUSAL) assert.doesNotMatch(title, cause);
});
