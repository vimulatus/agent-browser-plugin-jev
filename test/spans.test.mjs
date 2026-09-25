import { test } from "node:test";
import assert from "node:assert/strict";
import { valueSpans, valueVote } from "../dist/spans.js";

test("the login goal offers the email and the password as separate spans", () => {
  const spans = valueSpans("log in as alice@example.com with password secret and open Settings");
  assert.ok(spans.includes("alice@example.com"));
  assert.ok(spans.includes("secret"));
  assert.ok(spans.includes("password secret"));
  assert.ok(!spans.includes("Settings"));
});

test("a quoted string is one span, punctuation and all", () => {
  const spans = valueSpans('search for "red running shoes" and open the first result');
  assert.equal(spans[0], "red running shoes");
});

test("numbers and multi-word phrases survive, keywords do not", () => {
  const spans = valueSpans("book a table for 4 people to Anna Smith");
  assert.ok(spans.includes("4 people"));
  assert.ok(spans.includes("Anna Smith"));
  assert.ok(spans.includes("4"));
  assert.ok(!spans.includes("to"));
});

test("a goal with no value yields no span, so TYPE_TEXT is never offered", () => {
  assert.deepEqual(valueSpans("open the report"), []);
});

test("spans are unique and bounded", () => {
  const many = Array.from({ length: 60 }, (_, i) => `v${i}`).join(" ");
  const spans = valueSpans(`go to ${many}`);
  assert.equal(spans.length, 40);
  assert.equal(new Set(spans).size, spans.length);
});

test("a span and the phrase around it count as one value, typed as the span Jev ranks first", () => {
  const vote = valueVote({ "one-time code 123456": 0.17, "one-time": 0.02, code: 0.02, 123456: 0.42, NONE: 0.37 });
  assert.equal(vote.value, "123456");
  assert.ok(Math.abs(vote.probability - 0.59) < 1e-9);
});

test("merged spans can outvote a NONE that beat each of them alone", () => {
  const vote = valueVote({ "Ada Lovelace": 0.3, Ada: 0.25, Lovelace: 0.05, NONE: 0.4 });
  assert.equal(vote.value, "Ada Lovelace");
  assert.ok(Math.abs(vote.probability - 0.6) < 1e-9);
});

test("spans that share no whole words do not merge, and NONE wins over what is left", () => {
  assert.deepEqual(valueVote({ 2024: 0.3, 4: 0.3, NONE: 0.4 }), { value: null, probability: 0.4 });
  const vote = valueVote({ "alice@example.com": 0.4, "password secret": 0.1, password: 0.05, secret: 0.1, NONE: 0.35 });
  assert.deepEqual(vote, { value: "alice@example.com", probability: 0.4 });
});
