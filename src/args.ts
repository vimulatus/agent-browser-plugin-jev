import { resolve } from "node:path";
import { DEFAULT_MODEL } from "./jev.js";
import { LOGIN_TIMEOUT_MS } from "./login.js";
import { NAME, STATE_DIR } from "./name.js";
import { VERBS } from "./questions.js";
import { DEFAULT_MAX_STEPS, type RunOptions } from "./run.js";

export const USAGE = `${NAME}

  ${NAME} run "<goal>" [options]
  ${NAME} run --policy <file> [options]
  ${NAME} init

init creates ./${STATE_DIR}/ with config.json and policies/, and adds ${STATE_DIR}/sessions/
to .gitignore. It is the project scope; ~/${STATE_DIR}/ is the global one.

With a goal it drives the browser to it, one Jev request per step, and prints
{ status, url, steps, snapshot, out } as JSON. Exit 0 when done, 2 when blocked.
With a policy and no goal it walks the app from --url, trying every control
once, and writes findings.json. --max-steps 0 judges the current page instead.

  --url <url>        Open this page before the first step
  --session <name>   agent-browser session; default $AGENT_BROWSER_SESSION
  --max-steps <n>    Stop after n steps; default ${DEFAULT_MAX_STEPS}
  --out <dir>        Run artifacts; default ${STATE_DIR}/sessions/<session>/runs/<timestamp>/
                     in the project scope, else in ~/${STATE_DIR}/
  --allow <verbs>    Let the run ${Object.keys(VERBS).join(", ")}; or all
  --model <name>     System One model; default ${DEFAULT_MODEL}
  --policy <file>    Judge every step against this policy, by path or by name:
                     ./${STATE_DIR}/policies/, then ~/${STATE_DIR}/policies/, then shipped
  --fixtures <file>  Values a walk types into forms; overrides the built-in keys
  --record <file>    Record the run to this .webm or .mp4, cursor included
  --human            Move the pointer along a curve instead of jumping
  --no-handoff       End blocked at a login page instead of opening a window for it
  --login-timeout <s> Seconds to wait for the person to sign in; default ${LOGIN_TIMEOUT_MS / 1000}

Needs TYPESAFE_API_KEY and the agent-browser binary on PATH.
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

function loginTimeoutFrom(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new UsageError("--login-timeout takes a number of seconds");
  return seconds * 1000;
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
    handoff: true,
    loginTimeoutMs: LOGIN_TIMEOUT_MS,
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
    if (flag === "--no-handoff") {
      options.handoff = false;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    if (flag === "--url") options.url = value;
    else if (flag === "--session") options.session = value;
    else if (flag === "--out") options.out = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--policy") options.policy = value;
    else if (flag === "--fixtures") options.fixtures = value;
    else if (flag === "--record") options.record = resolve(value);
    else if (flag === "--allow") options.allow = allowFrom(value);
    else if (flag === "--max-steps") options.maxSteps = stepsFrom(value);
    else if (flag === "--login-timeout") options.loginTimeoutMs = loginTimeoutFrom(value);
    else throw new UsageError(`unknown option ${flag}`);
  }
  if (options.session === "") throw new UsageError("no session: pass --session or set AGENT_BROWSER_SESSION");
  return options;
}
