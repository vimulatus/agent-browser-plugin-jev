import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { NAME, STATE_DIR } from "../dist/name.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the command is soab, and its state directory is .soab", () => {
  assert.equal(NAME, "soab");
  assert.equal(STATE_DIR, ".soab");
});

test("the package installs one bin, named after the command", () => {
  assert.equal(pkg.name, NAME);
  assert.deepEqual(pkg.bin, { [NAME]: "./dist/main.js" });
});

test("with no arguments the bin prints usage naming itself, to stderr only", () => {
  const result = spawnSync("node", ["dist/main.js"], { encoding: "utf8", input: "" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.startsWith(`${NAME}\n`), result.stderr);
  assert.match(result.stderr, new RegExp(`${NAME} run "<goal>"`));
  assert.doesNotMatch(result.stderr, /\bjev run\b/);
});

test("run with neither a goal nor a policy says what it needs", () => {
  const result = spawnSync("node", ["dist/main.js", "run", "--session", "jev-test"], { encoding: "utf8", input: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run needs a goal or a policy/);
});
