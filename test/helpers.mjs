import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ACTS = new Set(["click", "fill", "select", "scroll", "wait"]);

export function pages(name) {
  return JSON.parse(readFileSync(new URL("./fixtures/pages.json", import.meta.url), "utf8"))[name];
}

export function replay(name) {
  return JSON.parse(readFileSync(new URL(`./replay/${name}.json`, import.meta.url), "utf8")).responses;
}

/** An agent-browser that serves saved pages and moves to the next one when a decision acts. */
export function scriptedBrowser(states, advance) {
  const state = { index: 0, calls: [] };
  const step = advance ?? ((args) => (ACTS.has(args[0]) ? state.index + 1 : state.index));
  return {
    state,
    async run(args) {
      state.calls.push(args.join(" "));
      state.index = Math.min(step(args, state), states.length - 1);
      const page = states[state.index];
      switch (args.join(" ")) {
        case "snapshot -i":
          return { origin: page.url, snapshot: page.snapshot };
        case "get title":
          return { title: page.title };
        case "console":
          return { messages: [] };
        case "errors":
          return { errors: [] };
        case "network requests":
          return { requests: [] };
        default:
          return {};
      }
    },
  };
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
