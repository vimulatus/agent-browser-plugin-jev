import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("with no envelope and no arguments the bin prints usage to stderr only", () => {
  const result = spawnSync("node", ["dist/main.js"], { encoding: "utf8", input: "" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /agent-browser-plugin-jev/);
});
