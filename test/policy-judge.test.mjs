import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { observe } from "../dist/observe.js";
import { applyPolicy, judge, loadPolicy, parsePolicy, readHar } from "../dist/policy/index.js";

const PERF = fileURLToPath(new URL("./fixtures/perf/", import.meta.url));

function reply(dir, command) {
  return JSON.parse(readFileSync(`${dir}${command}.json`, "utf8")).data;
}

function browser(replies) {
  return { run: async (args) => replies[args.join(" ")] };
}

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

// The Jev reply recorded from jev-1.13.0 for exactly these questions. Tests never call the paid API.
const RECORDED = JSON.parse(readFileSync(new URL("./replay/perf.json", import.meta.url), "utf8"));

function replay(answers) {
  const asked = {};
  return {
    asked,
    ask: async (state, questions) => {
      Object.assign(asked, { state, questions });
      return answers;
    },
  };
}

const perf = loadPolicy(fileURLToPath(new URL("../policies/perf.yaml", import.meta.url)));
const products = await observe(
  browser({
    "snapshot -i": reply(PERF, "snapshot-i"),
    "get title": reply(PERF, "get-title"),
    console: reply(PERF, "console"),
    errors: reply(PERF, "errors"),
    "network requests": reply(PERF, "network-requests"),
  }),
);
const har = readHar(`${PERF}capture.har`);

const jev = replay(RECORDED.answers);
const inferences = await judge(perf, products, har, jev);

test("over: request asks one question per request and over: page asks one about the page", () => {
  assert.deepEqual(Object.keys(jev.asked.questions), [
    "request_kind#0",
    "request_kind#1",
    "request_kind#2",
    "request_kind#3",
    "stuck_loading",
  ]);
});

test("each fanned-out question names its item by its path in the state, so the item is sent once", () => {
  assert.deepEqual(jev.asked.questions["request_kind#2"], {
    type: "choice",
    instructions: {
      question: "What does this request fetch for the page the user is looking at?",
      subject: "`requests[2]`",
    },
    criteria: {
      content_for_this_page: "data the page shows now",
      asset: "script, style, font or image",
      analytics: "tracking or telemetry",
      third_party: "a domain the app does not own",
    },
  });
  assert.deepEqual(jev.asked.questions.stuck_loading, {
    type: "noul",
    instructions: {
      question: "Does the page show a spinner or a skeleton with no content in its place?",
      subject: "`page`",
    },
  });
});

test("the state carries the page and the lists the questions fan out over, and nothing else", () => {
  assert.deepEqual(Object.keys(jev.asked.state), ["page", "requests"]);
  assert.deepEqual(jev.asked.state.page, {
    url: "http://127.0.0.1:8791/index.html",
    title: "Products",
    text: '- heading "Products" [level=1, ref=e3]',
  });
  assert.deepEqual(jev.asked.state.requests[3], {
    method: "GET",
    url: "http://127.0.0.1:8791/api/products",
    resourceType: "Fetch",
    mimeType: "application/json",
  });
});

test("an inference carries the item it judged, the answer and its probabilities", () => {
  assert.deepEqual(inferences[3], {
    question: "request_kind",
    over: "request",
    index: 3,
    item: {
      method: "GET",
      url: "http://127.0.0.1:8791/api/products",
      resourceType: "Fetch",
      mimeType: "application/json",
    },
    type: "choice",
    answer: "content_for_this_page",
    probabilities: { content_for_this_page: 1, analytics: 0, asset: 0, third_party: 0 },
    confidence: 1,
  });
  assert.deepEqual(inferences[4], {
    question: "stuck_loading",
    over: "page",
    index: 0,
    item: {
      url: "http://127.0.0.1:8791/index.html",
      title: "Products",
      text: '- heading "Products" [level=1, ref=e3]',
    },
    type: "noul",
    answer: 0.11,
  });
});

test("the perf policy reports the slow API and not the slow analytics beacon", () => {
  assert.deepEqual(applyPolicy(perf, products, { har, inferences }), [
    {
      title: "GET /api/products took 2504 ms",
      severity: "high",
      evidence: {
        request: {
          method: "GET",
          url: "http://127.0.0.1:8791/api/products",
          path: "/api/products",
          status: 200,
          resourceType: "Fetch",
          mimeType: "application/json",
          timestamp: 1789807725753,
          time: 2504,
        },
      },
    },
  ]);
});

test("a policy with no judge section makes no Jev call", async () => {
  const refuse = {
    ask: async () => {
      throw new Error("the errors policy must not ask Jev anything");
    },
  };
  assert.deepEqual(await judge(loadPolicy("errors"), products, undefined, refuse), []);
});

test("over: element asks one question per element of the snapshot", async () => {
  const policy = parsePolicy(`
collect: [snapshot]
judge:
  is_destructive:
    type: noul
    over: element
    instructions: Would activating this control delete or send something the user cannot undo?
report:
  - when: is_destructive > 0.7
    title: "{{element.label}} is destructive"
    severity: high
`);
  const login = await observe(
    browser({
      "snapshot -i": reply(FIXTURES, "snapshot-login"),
      "get title": reply(FIXTURES, "title"),
      console: reply(FIXTURES, "console"),
      errors: reply(FIXTURES, "errors"),
      "network requests": reply(FIXTURES, "requests"),
    }),
  );
  const answers = Object.fromEntries(
    login.elements.map((element, index) => [`is_destructive#${index}`, { type: "noul", noul: element.role === "button" ? 0.9 : 0.01 }]),
  );
  const asked = replay(answers);
  const judged = await judge(policy, login, undefined, asked);

  assert.equal(Object.keys(asked.asked.questions).length, login.elements.length);
  assert.deepEqual(Object.keys(asked.asked.state), ["page", "elements"]);
  assert.deepEqual(asked.asked.state.elements[0], {
    index: login.elements[0].index,
    role: login.elements[0].role,
    label: login.elements[0].label,
    value: login.elements[0].value,
  });
  assert.deepEqual(
    applyPolicy(policy, login, { inferences: judged }),
    login.elements.filter((e) => e.role === "button").map((e) => ({
      title: `${e.label} is destructive`,
      severity: "high",
      evidence: { element: e },
    })),
  );
});
