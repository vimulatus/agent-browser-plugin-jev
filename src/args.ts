import { resolve } from "node:path";
import { DEFAULT_MODEL } from "./jev.js";
import { VERBS } from "./questions.js";
import { DEFAULT_MAX_STEPS, type RunOptions } from "./run.js";

export const USAGE = `agent-browser-plugin-jev

  agent-browser-plugin-jev run "<goal>" [options]

Drives the browser to the goal, one Jev request per step, and prints
{ status, url, steps, snapshot, out } as JSON. Exit 0 when done, 2 when blocked.

  --url <url>        Open this page before the first step
  --session <name>   agent-browser session; default $AGENT_BROWSER_SESSION
  --max-steps <n>    Stop after n steps; default ${DEFAULT_MAX_STEPS}
  --out <dir>        Run artifacts; default a fresh directory under the temp dir
  --allow <verbs>    Let the run ${Object.keys(VERBS).join(", ")}; or all
  --model <name>     System One model; default ${DEFAULT_MODEL}
  --record <file>    Record the run to this .webm or .mp4, cursor included
  --human            Move the pointer along a curve instead of jumping

Needs TYPESAFE_API_KEY and the agent-browser binary on PATH.
With no arguments it answers plugin.manifest, jev.run and jev.status on stdin,
over agent-browser.plugin.v1. Register it with
  agent-browser plugin add vimulatus/agent-browser-plugin-jev
`;

export class UsageError extends Error {}

function allowFrom(value: string): RunOptions["allow"] {
  if (value === "all") return "all";
  const verbs = value.split(",").map((verb) => verb.trim()).filter(Boolean);
  for (const verb of verbs) {
    if (!(verb in VERBS)) throw new UsageError(`--allow: unknown verb "${verb}"`);
  }
  return new Set(verbs);
}

function stepsFrom(value: string): number {
  const steps = Number(value);
  if (!Number.isInteger(steps) || steps < 0) throw new UsageError("--max-steps takes a whole number of steps");
  return steps;
}

/** The `run` command line: one goal, and the flags that bound the run. */
export function parseRunArgs(argv: string[]): RunOptions {
  const options: RunOptions = {
    goal: "",
    session: process.env.AGENT_BROWSER_SESSION ?? "",
    maxSteps: DEFAULT_MAX_STEPS,
    out: "",
    allow: new Set<string>(),
    model: process.env.TYPESAFE_MODEL ?? DEFAULT_MODEL,
    human: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) {
      if (options.goal !== "") throw new UsageError(`run takes one goal, not also "${flag}"`);
      options.goal = flag;
      continue;
    }
    if (flag === "--human") {
      options.human = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    if (flag === "--url") options.url = value;
    else if (flag === "--session") options.session = value;
    else if (flag === "--out") options.out = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--record") options.record = resolve(value);
    else if (flag === "--allow") options.allow = allowFrom(value);
    else if (flag === "--max-steps") options.maxSteps = stepsFrom(value);
    else throw new UsageError(`unknown option ${flag}`);
  }
  if (options.session === "") throw new UsageError("no session: pass --session or set AGENT_BROWSER_SESSION");
  return options;
}
