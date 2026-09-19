import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgePage, recordHar } from "../dist/policy/index.js";

// A page whose /api/products takes 2.5 s and whose analytics beacon takes 1.2 s,
// captured from agent-browser 0.38.1 against a local server, with the Jev reply jev-1.13.0 gave for it.
const FIXTURES = fileURLToPath(new URL("./fixtures/perf/", import.meta.url));
const FAKE_BIN = fileURLToPath(new URL("./bin/", import.meta.url));
const RECORDED = JSON.parse(readFileSync(new URL("./replay/perf.json", import.meta.url), "utf8"));

process.env.PATH = `${FAKE_BIN}:${process.env.PATH}`;
process.env.JEV_FIXTURES = FIXTURES;

test("run --policy perf --max-steps 0 reports the slow API, not the slow beacon, and writes every answer", async () => {
  const out = mkdtempSync(join(tmpdir(), "jev-perf-"));
  const judged = await judgePage({
    session: "perf",
    policyPath: "perf",
    out,
    jev: { ask: async () => RECORDED.answers },
  });

  assert.deepEqual(
    judged.findings.map((finding) => finding.title),
    ["GET /api/products took 2504 ms"],
  );
  assert.equal(judged.inferred, join(out, "inferred.jsonl"));

  const inferred = readFileSync(judged.inferred, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    inferred.map((i) => [i.question, i.index, i.answer]),
    [
      ["request_kind", 0, "content_for_this_page"],
      ["request_kind", 1, "asset"],
      ["request_kind", 2, "analytics"],
      ["request_kind", 3, "content_for_this_page"],
      ["stuck_loading", 0, 0.11],
    ],
  );
});

test("a reload that fails still stops the recording, so the next run can start one", async () => {
  const commands = [];
  const browser = {
    run: async (args) => {
      commands.push(args.join(" "));
      if (args[0] === "reload") throw new Error("navigation failed");
      return { path: `${FIXTURES}capture.har` };
    },
  };
  await assert.rejects(recordHar(browser), /navigation failed/);
  assert.deepEqual(commands, ["network har start", "reload", "network har stop"]);
});

test("a policy with no judge section writes no inferred.jsonl", async () => {
  const judged = await judgePage({
    session: "perf",
    policyPath: fileURLToPath(new URL("./fixtures/perf-latency-only.yaml", import.meta.url)),
    jev: {
      ask: async () => {
        throw new Error("a policy with no judge section must not ask Jev anything");
      },
    },
  });
  assert.equal(judged.inferred, undefined);
  assert.deepEqual(
    judged.findings.map((finding) => finding.title),
    ["POST /analytics/beacon took 1202 ms", "GET /api/products took 2504 ms"],
  );
});
