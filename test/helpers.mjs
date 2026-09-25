import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentBrowser } from "../dist/agent-browser.js";
import { discoverScopes } from "../dist/scope.js";

const ACTS = new Set(["click", "fill", "select", "scroll", "wait"]);

/** Scopes over an empty temp home and working directory, so a policy by name resolves to the shipped one. */
export function isolatedScopes() {
  const home = mkdtempSync(join(tmpdir(), "soab-home-"));
  const cwd = join(home, "work");
  mkdirSync(cwd);
  return discoverScopes({ cwd, home });
}

export function pages(name) {
  return JSON.parse(readFileSync(new URL("./fixtures/pages.json", import.meta.url), "utf8"))[name];
}

export function replay(name) {
  return JSON.parse(readFileSync(new URL(`./replay/${name}.json`, import.meta.url), "utf8")).responses;
}

/**
 * The real agent-browser adapter over a fake binary: `fake.run` answers each command's argv. The fake's fields land
 * on the browser, so a test reads `browser.state` and can swap `browser.run` mid-test.
 */
export function driven(fake, human = false) {
  const browser = agentBrowser("jev-test", human, (args) => browser.run(args));
  return Object.assign(browser, fake);
}

/** What the fake agent-browser writes for `state save`: the cookies and storage of a signed-in session. */
export const SAVED_STATE = '{"cookies":[{"name":"sid","value":"signed-in"}],"origins":[]}';

/** What a browser agent-browser relaunched on its own serves: no page, no sign-in. */
const BLANK = { url: "about:blank", snapshot: "", title: "" };

/** The mode a command names: `--headed` alone or `--headed true` is headed, `--headed false` headless, none is null. */
function headedFlag(args) {
  const at = args.indexOf("--headed");
  if (at === -1) return null;
  return args[at + 1] !== "false";
}

/**
 * The launches of agent-browser 0.38.1 (#67): after a headed browser closes, the next launch that names no mode is
 * headed again, and the command after it relaunches headless on a fresh browser, which drops what the first held.
 * `state.browser` is the open browser, `{ headed }`, or null; `state.blank` is true once such a relaunch happened.
 */
function launches(state) {
  let lastHeaded = false;
  let inherited = false;
  return (args) => {
    if (args[0] === "close") {
      lastHeaded = state.browser?.headed ?? lastHeaded;
      state.browser = null;
      return;
    }
    const flag = headedFlag(args);
    if (state.browser !== null && inherited) {
      state.browser = { headed: flag ?? false };
      inherited = false;
      state.blank = true;
      return;
    }
    if (state.browser !== null) return;
    state.browser = { headed: flag ?? lastHeaded };
    inherited = flag === null && lastHeaded;
    state.blank = false;
  };
}

/**
 * An agent-browser that serves saved pages and moves to the next one when a decision acts. `state save <path>`
 * writes `SAVED_STATE` to the path, and `state load <path>` keeps what it read in `state.loaded`. It launches and
 * relaunches as `launches` says, and serves `BLANK` from a browser it relaunched on its own.
 */
export function scriptedBrowser(states, advance, human = false) {
  const state = { index: 0, calls: [], loaded: [], browser: null, blank: false };
  const step = advance ?? ((args) => (ACTS.has(args[0]) ? state.index + 1 : state.index));
  const launch = launches(state);
  return driven({
    state,
    async run(args) {
      state.calls.push(args.join(" "));
      launch(args);
      if (args[0] === "state" && args[1] === "save") writeFileSync(args[2], SAVED_STATE);
      if (args[0] === "state" && args[1] === "load") state.loaded.push(readFileSync(args[2], "utf8"));
      state.index = Math.min(step(args, state), states.length - 1);
      const page = state.blank ? BLANK : states[state.index];
      switch (args.join(" ")) {
        case "snapshot -i":
          return { origin: page.url, snapshot: page.snapshot };
        case "get title":
          return { title: page.title };
        case "console":
          return { messages: page.console ?? [] };
        case "errors":
          return { errors: [] };
        case "network requests":
          return { requests: [] };
        default:
          return {};
      }
    },
  }, human);
}

/** A Jev that answers from a recorded file and keeps every request for the test to check. */
export function replayingJev(responses) {
  const requests = [];
  return {
    requests,
    async ask(request) {
      requests.push(request);
      const response = responses[requests.length - 1];
      assert.ok(response, `no recorded Jev response for step ${requests.length}`);
      return response;
    },
  };
}

export function lines(path) {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
