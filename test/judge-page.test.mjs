import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgePage } from "../dist/policy/index.js";
import { driven, isolatedScopes } from "./helpers.mjs";

// The orders page of the bug-hunt fixtures: it fetches /api/orders, which answers 500, and logs two console errors.
const FIXTURES = fileURLToPath(new URL("./fixtures/bug-hunt/", import.meta.url));
const FAKE_BIN = fileURLToPath(new URL("./bin/", import.meta.url));
const ORDERS = "http://127.0.0.1:8811/index.html";
const silent = { ask: async () => assert.fail("errors asks Jev nothing") };

function json(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

/** A browser on about:blank that serves the orders page once it is opened. */
function blankUntilOpened() {
  const reply = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")).data;
  const calls = [];
  let opened = false;
  const browser = driven({
    async run(args) {
      calls.push(args.join(" "));
      if (args[0] === "open") opened = args[1] === ORDERS;
      if (!opened) {
        return { "snapshot -i": { origin: "about:blank", snapshot: "" }, "get title": { title: "" }, console: { messages: [] }, errors: { errors: [] }, "network requests": { requests: [] } }[args.join(" ")] ?? {};
      }
      const file = { "snapshot -i": "snapshot-i", snapshot: "snapshot", "get title": "get-title", console: "console", errors: "errors", "network requests": "network-requests" }[args.join(" ")];
      return file === undefined ? {} : reply(file);
    },
  });
  return { browser, calls };
}

test("--max-steps 0 opens --url before it judges, and judges that page (#110, #113)", async (t) => {
  const out = mkdtempSync(join(tmpdir(), "soab-judge-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const { browser, calls } = blankUntilOpened();

  const judged = await judgePage({ session: "judge", policyPath: "errors", out, url: ORDERS, browser, jev: silent, scopes: isolatedScopes() });

  assert.equal(calls[0], `open ${ORDERS}`);
  assert.equal(judged.url, ORDERS);
  assert.deepEqual(judged.findings.map((finding) => finding.title), [
    "GET /api/orders returned 500",
    `${ORDERS} logs orders request failed: 500`,
  ]);
});

test("--max-steps 0 writes findings.json and status.json like any run, and names the file (#110, #114)", async (t) => {
  const out = mkdtempSync(join(tmpdir(), "soab-judge-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const { browser } = blankUntilOpened();

  const judged = await judgePage({ session: "judge", policyPath: "errors", out, url: ORDERS, browser, jev: silent, scopes: isolatedScopes() });

  assert.equal(judged.status, "done");
  assert.equal(judged.findingsFile, join(out, "findings.json"));
  const { findings, summary } = json(out, "findings.json");
  assert.deepEqual(summary, [
    { title: "GET /api/orders returned 500", severity: "high", where: ORDERS },
    { title: `${ORDERS} logs orders request failed: 500`, severity: "medium", where: ORDERS },
  ]);
  assert.equal(findings[0].step, 0);
  const status = json(out, "status.json");
  assert.deepEqual([status.status, status.policy, status.url, status.findings, status.findingsFile], ["done", "errors", ORDERS, 2, judged.findingsFile]);
});

test("with no --out, --max-steps 0 writes findings.json under the session's run directory (#110)", async () => {
  const scopes = isolatedScopes();
  const { browser } = blankUntilOpened();

  const judged = await judgePage({ session: "judge", policyPath: "errors", url: ORDERS, browser, jev: silent, scopes });

  assert.ok(judged.findingsFile.startsWith(join(scopes.global.dir, "sessions", "judge", "runs")), judged.findingsFile);
  assert.ok(existsSync(judged.findingsFile));
});

test("soab run --policy --max-steps 0 --url names its out on stderr, opens the page, and exits 0 (#113, #114)", (t) => {
  const home = mkdtempSync(join(tmpdir(), "soab-judge-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // The fake agent-browser reads a reply per command, named after its words, so `open <url>` is a path under the fixtures.
  const fixtures = join(home, "fixtures");
  cpSync(FIXTURES, fixtures, { recursive: true });
  mkdirSync(join(fixtures, "open-http:", "127.0.0.1:8811"), { recursive: true });
  writeFileSync(join(fixtures, "open-http:", "127.0.0.1:8811", "index.html.json"), JSON.stringify({ success: true, data: {}, error: null }));
  const out = join(home, "out");

  const result = spawnSync(
    "node",
    ["dist/main.js", "run", "--policy", "errors", "--max-steps", "0", "--session", "judge", "--url", ORDERS, "--out", out, "--quiet"],
    { encoding: "utf8", input: "", env: { ...process.env, HOME: home, PATH: `${FAKE_BIN}:${process.env.PATH}`, JEV_FIXTURES: fixtures } },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.startsWith(`soab: writing to ${out}\n`), result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.findingsFile, join(out, "findings.json"));
  assert.equal(json(out, "findings.json").summary.length, 2);
  assert.equal(json(out, "status.json").status, "done");
});

test("soab run --policy --max-steps 0 refuses a flag it does not know, as every run does", () => {
  const result = spawnSync("node", ["dist/main.js", "run", "--policy", "errors", "--max-steps", "0", "--session", "judge", "--bogus", "x"], { encoding: "utf8", input: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option --bogus/);
});
