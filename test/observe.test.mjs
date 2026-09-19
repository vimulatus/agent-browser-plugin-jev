import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { observe } from "../dist/observe.js";
import { pageHash } from "../dist/hash.js";

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

function replaying(overrides = {}) {
  const calls = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      const data = { ...replies, ...overrides }[args.join(" ")];
      assert.ok(data, `unexpected agent-browser call: ${args.join(" ")}`);
      return data;
    },
  };
}

test("observe composes url, title, text, elements, logs and hash from agent-browser", async () => {
  const browser = replaying();
  const page = await observe(browser);
  assert.equal(page.url, "http://127.0.0.1:8765/index.html");
  assert.equal(page.title, "Fixture form");
  assert.equal(page.text, replies["snapshot -i"].snapshot);
  assert.equal(page.elements.find((e) => e.ref === "e5").value, "a@b.c");
  assert.deepEqual(page.console, [
    { type: "log", text: "data loaded" },
    { type: "warning", text: "careful" },
  ]);
  assert.deepEqual(page.errors, [
    { text: "Error: boom\n    at http://127.0.0.1:8765/broken.html:5:40", url: null, line: 4, column: 39 },
  ]);
  assert.equal(page.requests.length, 3);
  assert.deepEqual(page.requests[1], {
    method: "GET",
    url: "http://127.0.0.1:8765/data.json",
    status: 200,
    resourceType: "Fetch",
    mimeType: "application/json",
    timestamp: 1789804879926,
  });
  assert.equal(page.hash, pageHash(page.url, page.text));
  assert.deepEqual(
    browser.calls.map((c) => c.join(" ")),
    ["snapshot -i", "get title", "console", "errors", "network requests"],
  );
});

test("two observations of an unchanged page share a hash; typing changes it", async () => {
  const first = await observe(replaying());
  const second = await observe(replaying());
  const typed = await observe(replaying({ "snapshot -i": fixture("snapshot-login-typed.json") }));
  assert.equal(first.hash, second.hash);
  assert.notEqual(first.hash, typed.hash);
});

test("text is capped at 6000 chars while the hash covers the whole snapshot", async () => {
  const long = { ...replies["snapshot -i"], snapshot: "- button \"x\" [ref=e1]\n".repeat(400) };
  const page = await observe(replaying({ "snapshot -i": long }));
  assert.equal(page.text.length, 6000);
  assert.equal(page.hash, pageHash(page.url, long.snapshot));
});
