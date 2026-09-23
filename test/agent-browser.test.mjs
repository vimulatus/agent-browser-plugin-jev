import { test } from "node:test";
import assert from "node:assert/strict";
import { agentBrowser, agentBrowserCli } from "../dist/agent-browser.js";

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
  const browser = agentBrowser("jev-test", true, agentBrowserCli("jev-test", true, exec));
  await browser.snapshot(true);
  await browser.act({ operation: "CLICK", ref: "e1", value: null });

  assert.deepEqual(calls, [
    ["agent-browser", "--session", "jev-test", "--json", "--input-mode", "human", "snapshot", "-i"],
    ["agent-browser", "--session", "jev-test", "--json", "--input-mode", "human", "click", "@e1", "--human"],
  ]);
});

test("a run that did not ask for human input sets no input mode", async () => {
  const { calls, exec } = capturing();
  await agentBrowserCli("jev-test", false, exec)(["snapshot", "-i"]);
  assert.deepEqual(calls, [["agent-browser", "--session", "jev-test", "--json", "snapshot", "-i"]]);
});

test("a failed command names the command and the error", async () => {
  const exec = async () => ({ stdout: JSON.stringify({ success: false, data: null, error: "no such element" }) });
  await assert.rejects(
    () => agentBrowserCli("jev-test", false, exec)(["click", "@e9"]),
    /click @e9: no such element/,
  );
});

/** The adapter over a binary that answers every command with `data`, keeping each argv. */
function recording(data = {}, human = false) {
  const calls = [];
  const browser = agentBrowser("jev-test", human, async (args) => {
    calls.push(args.join(" "));
    return data;
  });
  return { browser, calls };
}

test("each act runs the agent-browser command for it, on the ref the snapshot gave", async () => {
  const { browser, calls } = recording();
  await browser.act({ operation: "CLICK", ref: "e1", value: null });
  await browser.act({ operation: "TYPE_TEXT", ref: "e2", value: "alice@example.com" });
  await browser.act({ operation: "SELECT", ref: "e3", value: "Admin" });
  await browser.act({ operation: "SCROLL_DOWN", ref: null, value: null });
  await browser.act({ operation: "WAIT", ref: null, value: null });
  assert.deepEqual(calls, [
    "click @e1",
    "fill @e2 alice@example.com",
    "select @e3 Admin",
    "scroll down",
    "wait --load networkidle",
  ]);
});

test("a human browser clicks along a curve", async () => {
  const { browser, calls } = recording({}, true);
  await browser.act({ operation: "CLICK", ref: "e1", value: null });
  assert.deepEqual(calls, ["click @e1 --human"]);
});

test("DONE and BLOCKED are not acts", async () => {
  const { browser, calls } = recording();
  await assert.rejects(browser.act({ operation: "DONE", ref: null, value: null }), /DONE is not an act/);
  assert.deepEqual(calls, []);
});

test("reopen restores the session, in a window only when headed", async () => {
  const { browser, calls } = recording();
  await browser.reopen("http://127.0.0.1:8765/login.html", true);
  await browser.reopen("http://127.0.0.1:8765/settings.html", false);
  assert.deepEqual(calls, [
    "open http://127.0.0.1:8765/login.html --restore jev-test --headed",
    "open http://127.0.0.1:8765/settings.html --restore jev-test",
  ]);
});

test("a snapshot names its page by the origin agent-browser reports", async () => {
  const { browser, calls } = recording({ origin: "http://127.0.0.1:8765/", snapshot: '- button "Save" [ref=e1]' });
  assert.deepEqual(await browser.snapshot(true), { url: "http://127.0.0.1:8765/", tree: '- button "Save" [ref=e1]' });
  await browser.snapshot(false);
  assert.deepEqual(calls, ["snapshot -i", "snapshot"]);
});
