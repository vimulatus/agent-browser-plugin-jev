import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { observe } from "../dist/observe.js";
import { driven } from "./helpers.mjs";
import { loadPolicy, applyPolicy } from "../dist/policy/index.js";

// A page that logs one console error and fetches an endpoint that answers 500,
// captured from agent-browser 0.38.1 against a local server.
const FIXTURES = fileURLToPath(new URL("./fixtures/orders/", import.meta.url));
const FAKE_BIN = fileURLToPath(new URL("./bin/", import.meta.url));

function reply(command) {
  return JSON.parse(readFileSync(`${FIXTURES}${command}.json`, "utf8")).data;
}

const replies = {
  "snapshot -i": reply("snapshot-i"),
  "get title": reply("get-title"),
  console: reply("console"),
  errors: reply("errors"),
  "network requests": reply("network-requests"),
};

const FINDINGS = [
  {
    title: "GET /api/orders returned 500",
    severity: "high",
    evidence: {
      request: {
        method: "GET",
        url: "http://127.0.0.1:8781/api/orders",
        path: "/api/orders",
        status: 500,
        resourceType: "Fetch",
        mimeType: "application/json",
        timestamp: 1789806645461,
      },
    },
  },
  {
    title: "http://127.0.0.1:8781/index.html logs checkout total is NaN",
    severity: "medium",
    evidence: { console: { type: "error", text: "checkout total is NaN" } },
  },
];

test("the errors policy reports the 500 and the console error, and nothing else", async () => {
  const orders = await observe(driven({ run: async (args) => replies[args.join(" ")] }));
  assert.deepEqual(applyPolicy(loadPolicy("errors"), orders), FINDINGS);
});

test("run --policy errors --max-steps 0 prints those findings as JSON", () => {
  const result = spawnSync(
    "node",
    ["dist/main.js", "run", "--policy", "errors", "--max-steps", "0", "--session", "orders"],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${FAKE_BIN}:${process.env.PATH}`, JEV_FIXTURES: FIXTURES },
    },
  );
  assert.equal(result.stderr, "");
  assert.equal(result.status, 0);
  const printed = JSON.parse(result.stdout);
  assert.ok(
    Number.isInteger(printed.durationMs) && printed.durationMs >= 0,
    `the command printed durationMs ${printed.durationMs}`,
  );
  assert.deepEqual(printed, { findings: FINDINGS, durationMs: printed.durationMs });
});
