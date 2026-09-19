import { test } from "node:test";
import assert from "node:assert/strict";
import { agentBrowser } from "../dist/agent-browser.js";

function capturing() {
  const calls = [];
  return {
    calls,
    async exec(file, args) {
      calls.push([file, ...args]);
      return { stdout: JSON.stringify({ success: true, data: {}, error: null }) };
    },
  };
}

test("a human run carries --input-mode human on every call, read or act", async () => {
  const { calls, exec } = capturing();
  const browser = agentBrowser("jev-test", true, exec);
  await browser.run(["snapshot", "-i"]);
  await browser.run(["click", "@e1", "--human"]);

  assert.deepEqual(calls, [
    ["agent-browser", "--session", "jev-test", "--json", "--input-mode", "human", "snapshot", "-i"],
    ["agent-browser", "--session", "jev-test", "--json", "--input-mode", "human", "click", "@e1", "--human"],
  ]);
});

test("a run that did not ask for human input sets no input mode", async () => {
  const { calls, exec } = capturing();
  await agentBrowser("jev-test", false, exec).run(["snapshot", "-i"]);
  assert.deepEqual(calls, [["agent-browser", "--session", "jev-test", "--json", "snapshot", "-i"]]);
});

test("a failed command names the command and the error", async () => {
  const exec = async () => ({ stdout: JSON.stringify({ success: false, data: null, error: "no such element" }) });
  await assert.rejects(
    () => agentBrowser("jev-test", false, exec).run(["click", "@e9"]),
    /click @e9: no such element/,
  );
});
