import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWhen, evaluate, pathsOf } from "../dist/policy/expression.js";

const facts = {
  page: { url: "http://x/", title: "X" },
  errors: [{ text: "boom" }],
  console: { errors: [], warnings: [{ text: "careful" }] },
  request: { method: "GET", status: 500 },
  http_status: "server_error",
};

const holds = (text) => evaluate(parseWhen(text), facts);

test("a bare path is true when it holds a value, false when it is empty or missing", () => {
  assert.equal(holds("errors.any"), true);
  assert.equal(holds("console.errors.any"), false);
  assert.equal(holds("console.warnings.any"), true);
  assert.equal(holds("page.url"), true);
  assert.equal(holds("page.missing"), false);
  assert.equal(holds("judge.slow"), false);
});

test("== and != compare a path with a bare word, a quoted string or a number", () => {
  assert.equal(holds("http_status == server_error"), true);
  assert.equal(holds("http_status != server_error"), false);
  assert.equal(holds("http_status == ok"), false);
  assert.equal(holds('request.method == "GET"'), true);
  assert.equal(holds("request.status == 500"), true);
  assert.equal(holds("request.status == 200"), false);
  assert.equal(holds("errors[0].text == boom"), true);
});

test("not, and, or bind in that order and parentheses override", () => {
  assert.equal(holds("not errors.any"), false);
  assert.equal(holds("errors.any and console.errors.any"), false);
  assert.equal(holds("errors.any or console.errors.any"), true);
  assert.equal(holds("console.errors.any or errors.any and http_status == ok"), false);
  assert.equal(holds("(console.errors.any or errors.any) and http_status == server_error"), true);
  assert.equal(holds("not console.errors.any and errors.any"), true);
  assert.equal(holds("not (console.errors.any and errors.any)"), true);
});

test("a malformed expression is rejected", () => {
  for (const bad of ["", "errors.any and", "== 5", "errors.any or (", "errors.any errors.any", "a == b == c"]) {
    assert.throws(() => parseWhen(bad), /when/);
  }
});

test("pathsOf lists every path the expression reads", () => {
  assert.deepEqual(
    pathsOf(parseWhen("http_status == server_error and not (errors.any or console.errors[0].text == x)")),
    [["http_status"], ["errors", "any"], ["console", "errors", 0, "text"]],
  );
});
