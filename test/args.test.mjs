import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunArgs } from "../dist/args.js";

const SESSION = ["--session", "jev-test"];

test("the goal is the one positional argument and the flags bound the run", () => {
  const options = parseRunArgs([
    "open Settings",
    ...SESSION,
    "--url",
    "http://localhost:3000",
    "--max-steps",
    "12",
    "--out",
    "/tmp/jev",
    "--model",
    "jev-1.13",
  ]);
  assert.equal(options.goal, "open Settings");
  assert.equal(options.session, "jev-test");
  assert.equal(options.url, "http://localhost:3000");
  assert.equal(options.maxSteps, 12);
  assert.equal(options.out, "/tmp/jev");
  assert.equal(options.model, "jev-1.13");
  assert.deepEqual(options.allow, new Set());
});

test("--allow takes verbs or all, and refuses anything else", () => {
  assert.deepEqual(parseRunArgs(["g", ...SESSION, "--allow", "delete,send"]).allow, new Set(["delete", "send"]));
  assert.equal(parseRunArgs(["g", ...SESSION, "--allow", "all"]).allow, "all");
  assert.throws(() => parseRunArgs(["g", ...SESSION, "--allow", "drop"]), /unknown verb "drop"/);
});

test("the session falls back to AGENT_BROWSER_SESSION and is required", () => {
  const previous = process.env.AGENT_BROWSER_SESSION;
  delete process.env.AGENT_BROWSER_SESSION;
  assert.throws(() => parseRunArgs(["g"]), /no session/);
  process.env.AGENT_BROWSER_SESSION = "from-env";
  assert.equal(parseRunArgs(["g"]).session, "from-env");
  if (previous === undefined) delete process.env.AGENT_BROWSER_SESSION;
  else process.env.AGENT_BROWSER_SESSION = previous;
});

test("a second goal, an unknown option and a bad step count are usage errors", () => {
  assert.throws(() => parseRunArgs(["one", "two", ...SESSION]), /takes one goal/);
  assert.throws(() => parseRunArgs(["g", ...SESSION, "--wat", "x"]), /unknown option --wat/);
  assert.throws(() => parseRunArgs(["g", ...SESSION, "--max-steps", "-1"]), /whole number/);
  assert.throws(() => parseRunArgs(["g", ...SESSION, "--url"]), /--url needs a value/);
});

test("--max-steps 0 parses, so a policy can judge the current page without moving", () => {
  assert.equal(parseRunArgs(["g", ...SESSION, "--max-steps", "0"]).maxSteps, 0);
});
