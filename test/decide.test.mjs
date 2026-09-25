import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide, MAX_TYPE_TEXT_TARGETS } from "../dist/decide.js";
import { parseSnapshot } from "../dist/snapshot.js";
import { valueSpans } from "../dist/spans.js";
import { pages, replay, replayingJev } from "./helpers.mjs";

function observation(text, url = "http://127.0.0.1:8765/login.html") {
  return {
    url,
    title: "Sign in",
    text,
    elements: parseSnapshot(text),
    console: [],
    errors: [],
    requests: [],
    hash: "hash",
  };
}

const LOGIN = pages("login")[0].snapshot;
const GOAL = "log in as alice@example.com with password secret and open Settings";

function ask(answers) {
  return replayingJev([{ model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 2 } }]);
}

function input(jev, overrides = {}) {
  return {
    jev,
    model: "jev-latest",
    goal: GOAL,
    spans: valueSpans(GOAL),
    observation: observation(LOGIN),
    content: LOGIN,
    recent: [],
    allow: new Set(),
    ...overrides,
  };
}

test("one request offers the operation, a target per operation, a value per field and the gate", async () => {
  const jev = replayingJev(replay("login"));
  const decision = await decide(input(jev));
  const [request] = jev.requests;
  assert.deepEqual(Object.keys(request.questions).sort(), [
    "action_is_destructive",
    "click_target",
    "destructive_verb",
    "goal_outcome_visible",
    "operation",
    "type_text_target",
    "type_text_value_1",
    "type_text_value_2",
  ]);
  assert.deepEqual(Object.keys(request.questions.operation.criteria), [
    "CLICK",
    "TYPE_TEXT",
    "SCROLL_UP",
    "SCROLL_DOWN",
    "WAIT",
    "DONE",
    "BLOCKED",
  ]);
  assert.deepEqual(Object.keys(request.questions.click_target.criteria), ["1", "2", "3", "4"]);
  assert.deepEqual(Object.keys(request.questions.type_text_target.criteria), ["1", "2"]);
  assert.deepEqual(Object.keys(request.questions.type_text_value_1.criteria), [
    "alice@example.com",
    "password secret",
    "password",
    "secret",
    "NONE",
  ]);
  assert.equal(request.state.goal, GOAL);
  assert.equal(request.state.elements.length, 4);
  assert.equal(decision.operation, "TYPE_TEXT");
  assert.equal(decision.ref, "e5");
  assert.equal(decision.value, "alice@example.com");
  assert.equal(decision.valueProbability, 0.9);
  assert.equal(decision.valueProbabilities["secret"], 0.04);
});

test("a DONE carries Jev's judgment that the page shows the goal's outcome, and no other operation reads it", async () => {
  const done = replay("login")[3];
  assert.equal(done.answers.operation.choice, "DONE");
  const settings = { observation: observation(pages("login")[3].snapshot, "http://127.0.0.1:8765/settings.html") };
  const decision = await decide(input(replayingJev([done]), settings));
  assert.equal(decision.operation, "DONE");
  assert.equal(decision.outcome, 0.96);

  const typed = await decide(input(replayingJev(replay("login"))));
  assert.equal(typed.outcome, null);

  const { goal_outcome_visible, ...unjudged } = done.answers;
  await assert.rejects(decide(input(ask(unjudged), settings)), /goal_outcome_visible is not a probability/);
});

test("each value question names its own field, and the chosen field's answer is the one read", async () => {
  const jev = replayingJev(replay("login"));
  await decide(input(jev));
  const { type_text_value_1, type_text_value_2 } = jev.requests[0].questions;
  assert.deepEqual(type_text_value_1.instructions.field, {
    element: "[1] Email",
    current_value: "",
    role: "textbox",
  });
  assert.equal(type_text_value_2.instructions.field.element, "[2] Password");
  assert.equal(type_text_value_2.instructions.field.password, true);

  const password = replayingJev(replay("login").slice(1));
  const decision = await decide(input(password));
  assert.equal(decision.target, "2");
  assert.equal(decision.value, "secret");
  assert.equal(decision.valueProbability, 0.84);
});

test("a password field is offered and marked, and its value never reaches the request", async () => {
  const jev = replayingJev(replay("login"));
  await decide(input(jev));
  const field = jev.requests[0].questions.type_text_target.criteria["2"];
  assert.equal(field.password, true);
  assert.equal(field.current_value, "");
  const filled = observation(pages("login")[2].snapshot);
  assert.equal(filled.elements[1].value, "••••••");
  const second = replayingJev(replay("login"));
  await decide(input(second, { observation: filled }));
  assert.equal(second.requests[0].questions.type_text_target.criteria["2"].current_value, "");
});

test("--allow all leaves the destructive questions out of the request", async () => {
  const jev = replayingJev(replay("login"));
  await decide(input(jev, { allow: "all" }));
  assert.deepEqual(Object.keys(jev.requests[0].questions).sort(), [
    "click_target",
    "goal_outcome_visible",
    "operation",
    "type_text_target",
    "type_text_value_1",
    "type_text_value_2",
  ]);
});

test("a form with many fields offers the first MAX_TYPE_TEXT_TARGETS, each with its own value question", async () => {
  const fields = Array.from({ length: 30 }, (_, i) => `- textbox "Field ${i}" [ref=f${i}]`).join("\n");
  const jev = ask({
    operation: {
      type: "choice",
      choice: "BLOCKED",
      probabilities: {
        CLICK: 0.05,
        TYPE_TEXT: 0.07,
        SCROLL_UP: 0.02,
        SCROLL_DOWN: 0.02,
        WAIT: 0.02,
        DONE: 0.04,
        BLOCKED: 0.78,
      },
      confidence: 0.78,
    },
  });
  await decide(input(jev, { observation: observation(fields), allow: "all" }));
  const { questions } = jev.requests[0];
  const values = Object.keys(questions).filter((key) => key.startsWith("type_text_value_"));
  assert.equal(values.length, MAX_TYPE_TEXT_TARGETS);
  const fieldsAsked = values.map((key) => key.replace("type_text_value_", "")).sort();
  assert.deepEqual(Object.keys(questions.type_text_target.criteria).sort(), fieldsAsked);
  assert.equal(Object.keys(questions.click_target.criteria).length, 30, "only the typeable targets are capped");
});

test("a goal with no value span does not offer TYPE_TEXT", async () => {
  const jev = ask({
    operation: {
      type: "choice",
      choice: "CLICK",
      probabilities: { CLICK: 0.9, SCROLL_UP: 0.02, SCROLL_DOWN: 0.02, WAIT: 0.02, DONE: 0.02, BLOCKED: 0.02 },
      confidence: 0.9,
    },
    click_target: { type: "choice", choice: "3", probabilities: { 1: 0.1, 2: 0.1, 3: 0.7, 4: 0.1 }, confidence: 0.7 },
    action_is_destructive: { type: "noul", noul: 0.1 },
  });
  const decision = await decide(input(jev, { goal: "open the report", spans: [] }));
  const criteria = jev.requests[0].questions.operation.criteria;
  assert.ok(!("TYPE_TEXT" in criteria));
  assert.ok(!Object.keys(jev.requests[0].questions).some((key) => key.startsWith("type_text_value")));
  assert.equal(decision.operation, "CLICK");
  assert.deepEqual(decision.destructive, { probability: 0.1, verb: null });
});

test("a select offers one target per option, keyed element:option", async () => {
  const text = readFileSync(new URL("./fixtures/snapshot-login.json", import.meta.url), "utf8");
  const snapshot = JSON.parse(text).data.snapshot;
  const jev = ask({
    operation: {
      type: "choice",
      choice: "BLOCKED",
      probabilities: {
        CLICK: 0.1,
        TYPE_TEXT: 0.1,
        SELECT: 0.1,
        SCROLL_UP: 0.02,
        SCROLL_DOWN: 0.02,
        WAIT: 0.02,
        DONE: 0.04,
        BLOCKED: 0.6,
      },
      confidence: 0.6,
    },
  });
  await decide(input(jev, { observation: observation(snapshot), allow: "all" }));
  assert.deepEqual(Object.keys(jev.requests[0].questions.select_target.criteria), ["4:1", "4:2"]);
});

test("an answer that is not over the offered options is refused, and nothing acts", async () => {
  const outside = ask({
    operation: { type: "choice", choice: "FLY", probabilities: { FLY: 1 }, confidence: 1 },
  });
  await assert.rejects(decide(input(outside)), /operation chose FLY, which was not offered/);

  const short = ask({
    operation: {
      type: "choice",
      choice: "DONE",
      probabilities: { CLICK: 0.1, TYPE_TEXT: 0.1, SCROLL_UP: 0, SCROLL_DOWN: 0, WAIT: 0, DONE: 0.3, BLOCKED: 0 },
      confidence: 0.3,
    },
  });
  await assert.rejects(decide(input(short)), /do not sum to 1/);
});

test("a long dropdown is capped, because a Choice takes at most 255 options", async () => {
  const options = Array.from({ length: 300 }, (_, i) => `  - option "o${i}" [ref=o${i}]`).join("\n");
  const jev = ask({
    operation: {
      type: "choice",
      choice: "BLOCKED",
      probabilities: { SELECT: 0.1, SCROLL_UP: 0.02, SCROLL_DOWN: 0.02, WAIT: 0.02, DONE: 0.04, BLOCKED: 0.8 },
      confidence: 0.8,
    },
  });
  const text = `- combobox "Plan" [expanded=false, ref=e1]: o0\n${options}`;
  await decide(input(jev, { observation: observation(text), spans: [], allow: "all" }));
  assert.equal(Object.keys(jev.requests[0].questions.select_target.criteria).length, 250);
});
