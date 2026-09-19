import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { observe } from "../dist/observe.js";
import { parsePolicy, loadPolicy, applyPolicy } from "../dist/policy/index.js";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).data;
}

const replies = {
  "snapshot -i": fixture("snapshot-login.json"),
  console: fixture("console.json"),
  errors: fixture("errors.json"),
  "network requests": fixture("requests.json"),
  "get title": fixture("title.json"),
};

const login = await observe({ run: async (args) => replies[args.join(" ")] });
const errors = loadPolicy(fileURLToPath(new URL("../policies/errors.yaml", import.meta.url)));

test("the errors policy loads with its four collections, one measure and three rules", () => {
  assert.equal(errors.name, "errors");
  assert.deepEqual(errors.collect, ["console", "errors", "requests", "snapshot"]);
  assert.deepEqual(Object.keys(errors.measures), ["http_status"]);
  assert.deepEqual(
    errors.rules.map((r) => r.severity),
    ["high", "high", "medium"],
  );
});

test("on the login fixture the errors policy reports the thrown error and nothing else", () => {
  assert.deepEqual(applyPolicy(errors, login), [
    {
      title: "http://127.0.0.1:8765/index.html throws Error: boom\n    at http://127.0.0.1:8765/broken.html:5:40",
      severity: "high",
      evidence: {
        error: { text: "Error: boom\n    at http://127.0.0.1:8765/broken.html:5:40", url: null, line: 4, column: 39 },
      },
    },
  ]);
});

test("a per-request rule fires once per matching request with that request as evidence", () => {
  const policy = parsePolicy(`
collect: [requests]
measure:
  http_status: { ok: "<400", client_error: "400-499", server_error: ">=500" }
report:
  - when: http_status != ok
    title: "{{request.method}} {{request.path}} returned {{request.status}}"
    severity: low
`);
  assert.deepEqual(applyPolicy(policy, login), [
    {
      title: "GET /favicon.ico returned 404",
      severity: "low",
      evidence: {
        request: {
          method: "GET",
          url: "http://127.0.0.1:8765/favicon.ico",
          path: "/favicon.ico",
          status: 404,
          resourceType: "Other",
          mimeType: "text/html",
          timestamp: 1789804879927,
        },
      },
    },
  ]);
});

test("a request without a status falls in no bucket", () => {
  const policy = parsePolicy(`
collect: [requests]
measure:
  http_status: { ok: "<400", failed: ">=400" }
report:
  - { when: http_status == ok, title: "ok {{request.path}}", severity: low }
  - { when: http_status == failed, title: "failed {{request.path}}", severity: low }
`);
  const pending = { ...login, requests: [{ ...login.requests[0], status: null }] };
  assert.deepEqual(applyPolicy(policy, pending), []);
});

test("page-level rules fire once, with the first item of the collection they read as evidence", () => {
  const policy = parsePolicy(`
collect: [console, snapshot]
report:
  - when: console.warnings.any
    title: "{{page.title}} warns {{console.warnings[0].text}}"
    severity: low
  - when: console.messages.any and not console.errors.any
    title: "{{page.url}} is quiet"
    severity: low
`);
  assert.deepEqual(applyPolicy(policy, login), [
    { title: "Fixture form warns careful", severity: "low", evidence: { console: { type: "warning", text: "careful" } } },
    { title: "http://127.0.0.1:8765/index.html is quiet", severity: "low", evidence: { console: { type: "log", text: "data loaded" } } },
  ]);
});

test("a policy that reads what it does not collect is rejected at load", () => {
  assert.throws(
    () => parsePolicy("collect: [console]\nreport:\n  - { when: errors.any, title: x, severity: low }"),
    /errors.*collect/,
  );
  assert.throws(
    () => parsePolicy("collect: [console]\nreport:\n  - { when: console.errors.any, title: '{{page.url}}', severity: low }"),
    /page.*collect/,
  );
  assert.throws(
    () => parsePolicy("collect: [console]\nmeasure:\n  http_status: { ok: '<400' }\nreport: []"),
    /http_status.*requests/,
  );
});

test("unknown names are rejected at load: collections, measures, buckets, sections and fields", () => {
  assert.throws(() => parsePolicy("collect: [cookies]\nreport: []"), /cookies/);
  assert.throws(() => parsePolicy("collect: [requests]\nmeasure:\n  latency: { fast: '<100' }\nreport: []"), /latency/);
  assert.throws(
    () =>
      parsePolicy(
        "collect: [requests]\nmeasure:\n  http_status: { ok: '<400' }\nreport:\n  - { when: http_status == okay, title: x, severity: low }",
      ),
    /okay/,
  );
  assert.throws(() => parsePolicy("collect: [console]\nreport:\n  - { when: console.errors.any, title: x }"), /severity/);
  assert.throws(() => parsePolicy("collect: [console]\nreport:\n  - { when: console.errors.any, title: x, severity: low, extra: 1 }"), /extra/);
  assert.throws(() => parsePolicy("collect: [console]"), /report/);
  assert.throws(() => parsePolicy("report: []"), /collect/);
});

const judging = (judge, report = "[]") => `collect: [har, snapshot]\njudge:\n${judge}\nreport: ${report}`;

test("a judge question is rejected when its type, its criteria or what it runs over do not hold together", () => {
  assert.throws(() => parsePolicy(judging("  kind: { type: score, over: request, instructions: how bad }")), /choice.*noul/);
  assert.throws(() => parsePolicy(judging("  kind: { type: choice, over: request }")), /instructions/);
  assert.throws(() => parsePolicy(judging("  kind: { type: choice, over: session, instructions: x }")), /over/);
  assert.throws(() => parsePolicy(judging("  kind: { type: choice, over: request, instructions: x }")), /criteria/);
  assert.throws(
    () => parsePolicy(judging("  kind: { type: choice, over: request, instructions: x, criteria: { only: one } }")),
    /two options/,
  );
  assert.throws(
    () => parsePolicy(judging("  stuck: { type: noul, over: page, instructions: x, criteria: { a: b } }")),
    /no criteria/,
  );
  assert.throws(
    () => parsePolicy("collect: [snapshot]\njudge:\n  kind: { type: noul, over: request, instructions: x }\nreport: []"),
    /"requests" or "har"/,
  );
  assert.throws(() => parsePolicy(judging("  page: { type: noul, over: page, instructions: x }")), /already a name/);
  assert.throws(
    () =>
      parsePolicy(
        "collect: [har]\nmeasure:\n  latency: { bad: '>1000' }\njudge:\n  latency: { type: noul, over: page, instructions: x }\nreport: []",
      ),
    /already a name/,
  );
});

test("a rule reading a judged name runs over that name's items and compares with its criteria", () => {
  const policy = parsePolicy(
    judging("  kind: { type: choice, over: request, instructions: x, criteria: { api: a, asset: b } }", [
      '\n  - { when: kind == api, title: "{{request.path}}", severity: low }',
    ]),
  );
  assert.deepEqual(policy.judgments, [
    { name: "kind", type: "choice", over: "request", instructions: "x", criteria: { api: "a", asset: "b" } },
  ]);
  assert.equal(policy.rules[0].scope, "request");
  assert.throws(
    () =>
      parsePolicy(
        judging("  kind: { type: choice, over: request, instructions: x, criteria: { api: a, asset: b } }", [
          "\n  - { when: kind == script, title: x, severity: low }",
        ]),
      ),
    /script.*api, asset/,
  );
});
