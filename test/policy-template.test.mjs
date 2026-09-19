import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTemplate, render } from "../dist/policy/template.js";

const facts = {
  page: { url: "http://x/" },
  request: { method: "GET", path: "/api", status: 500 },
  errors: [{ text: "Error: boom", line: null }],
};

test("placeholders take the value at the path; the rest is copied", () => {
  const template = parseTemplate("{{request.method}} {{request.path}} returned {{request.status}}");
  assert.equal(render(template, facts), "GET /api returned 500");
  assert.equal(render(parseTemplate("{{page.url}} throws {{errors[0].text}}"), facts), "http://x/ throws Error: boom");
  assert.equal(render(parseTemplate("plain"), facts), "plain");
});

test("a missing value fails the render and names the path", () => {
  assert.throws(() => render(parseTemplate("{{errors[1].text}}"), facts), /errors\[1\]\.text/);
  assert.throws(() => render(parseTemplate("{{request.missing}}"), facts), /request\.missing/);
});

test("null renders as null and a malformed placeholder is rejected", () => {
  assert.equal(render(parseTemplate("line {{errors[0].line}}"), facts), "line null");
  assert.throws(() => parseTemplate("{{page.url"), /template/);
  assert.throws(() => parseTemplate("{{}}"), /template/);
});
