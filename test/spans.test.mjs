import { test } from "node:test";
import assert from "node:assert/strict";
import { valueSpans } from "../dist/spans.js";

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
