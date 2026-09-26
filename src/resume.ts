import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { allowFrom, canShowWindow, loginTimeoutFrom, stepsFrom, UsageError } from "./args.js";
import type { Blocker } from "./blocker.js";
import type { Allow } from "./decide.js";
import { DEFAULT_MODEL } from "./jev.js";
import { LOGIN_TIMEOUT_MS } from "./login.js";
import { DEFAULT_MAX_STEPS, type Resume, type RunOptions } from "./run.js";
import { latestState, readState, type RunState } from "./runs.js";
import type { Scopes } from "./scope.js";
import { newRunDir } from "./session.js";

/** One value for `resume` as the command line gives it: `--value "<label>=<v>"`, or a bare `--value <v>`. */
export interface Given {
  label: string | null;
  value: string;
}

/** The `resume` command line: the session, what it gives the blocked run, and the flags a run takes. */
export interface ResumeArgs {
  session: string;
  given: Given[];
  allow: Allow;
  open?: string;
  maxSteps?: number;
  out?: string;
  quiet: boolean;
  handoff: boolean;
  loginTimeoutMs: number;
  human: boolean;
  record?: string;
}

/** Splits `<label>=<v>` at the first `=`; with no `=`, the value is bare and fills the only field. */
export function givenFrom(text: string): Given {
  const at = text.indexOf("=");
  return at <= 0 ? { label: null, value: text } : { label: text.slice(0, at), value: text.slice(at + 1) };
}

/** `--value-env "<label>=<VAR>"`: the value is the variable's, so it stays out of shell history and the process list. */
function fromEnv(text: string, env: NodeJS.ProcessEnv): Given {
  const { label, value: name } = givenFrom(text);
  const value = env[name];
  if (value === undefined || value === "") throw new UsageError(`--value-env: the environment variable ${name} is not set`);
  return { label, value };
}

/** `--value-file "<label>=<path>"`: the value is the file's contents, trimmed. */
function fromFile(text: string): Given {
  const { label, value: path } = givenFrom(text);
  if (!existsSync(path)) throw new UsageError(`--value-file: no file at ${path}`);
  return { label, value: readFileSync(path, "utf8").trim() };
}

export function parseResumeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ResumeArgs {
  const args: ResumeArgs = {
    session: env.AGENT_BROWSER_SESSION ?? "",
    given: [],
    allow: new Set(),
    quiet: false,
    handoff: true,
    loginTimeoutMs: LOGIN_TIMEOUT_MS,
    human: false,
  };
  let named = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) {
      if (named) throw new UsageError(`resume takes one session, not also "${flag}"`);
      args.session = flag;
      named = true;
      continue;
    }
    if (flag === "--quiet") args.quiet = true;
    else if (flag === "--no-handoff") args.handoff = false;
    else if (flag === "--human") args.human = true;
    else {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${flag} needs a value`);
      if (flag === "--value") args.given.push(givenFrom(value));
      else if (flag === "--value-env") args.given.push(fromEnv(value, env));
      else if (flag === "--value-file") args.given.push(fromFile(value));
      else if (flag === "--allow") args.allow = allowFrom(value);
      else if (flag === "--open") args.open = value;
      else if (flag === "--max-steps") args.maxSteps = stepsFrom(value);
      else if (flag === "--out") args.out = value;
      else if (flag === "--login-timeout") args.loginTimeoutMs = loginTimeoutFrom(value);
      else if (flag === "--record") args.record = resolve(value);
      else throw new UsageError(`unknown option ${flag}`);
    }
  }
  if (args.session === "") throw new UsageError("no session: resume <session>, or set AGENT_BROWSER_SESSION");
  return args;
}

function allowOf(saved: unknown): Allow {
  return saved === "all" ? "all" : new Set(Array.isArray(saved) ? (saved as string[]) : []);
}

function widened(saved: Allow, added: Allow): Allow {
  return saved === "all" || added === "all" ? "all" : new Set([...saved, ...added]);
}

/**
 * Each value with the label of the field it goes into: its own label, which must be one the blocker named, or the only
 * field's. On a code split over boxes, one value as long as the boxes are many is the whole code: bare or under any
 * box's label, it goes into the first box and on over the rest, whatever the boxes are labelled.
 */
function labelled(given: Given[], blocker: Blocker | undefined): Resume["values"] {
  const fields = [...new Set(blocker?.fields.map((field) => field.label) ?? [])];
  const boxes = blocker?.kind === "otp" ? blocker.fields : [];
  if (given.length === 1 && boxes.length > 1 && given[0].value.length === boxes.length && (given[0].label === null || fields.includes(given[0].label))) {
    return [{ label: boxes[0].label, value: given[0].value, code: true }];
  }
  return given.map(({ label, value }) => {
    if (label === null) {
      if (fields.length !== 1) {
        throw new Error(`a bare --value fills the only field, and the run is blocked on ${fields.length} (${fields.join(", ") || "none"}): pass --value "<label>=<value>"`);
      }
      return { label: fields[0], value };
    }
    if (!fields.includes(label)) {
      const code = boxes.length > 1 ? `, or the ${boxes.length}-character code as a bare --value` : "";
      throw new Error(`the run is not blocked on a field "${label}"; it needs ${fields.map((field) => `"${field}"`).join(", ") || "no field"}${code}`);
    }
    return { label, value };
  });
}

/**
 * The run `resume` goes on from: the session's newest, or when that one is a resume that failed, the run it went on
 * from, so a resume that failed can be tried again.
 */
function resumable(scopes: Scopes, session: string): { from: string; state: RunState } | null {
  let last = latestState(scopes, session);
  while (last?.state.status === "failed" && typeof last.state.resumedFrom === "string") {
    const from = last.state.resumedFrom;
    const state = readState(from);
    last = state === null ? null : { from, state };
  }
  return last;
}

/**
 * The run `resume` starts: the goal, the allow list, the model and the steps left of the session's last run, which
 * must have ended blocked or stopped, widened by `--allow`, and going on from the page it ended on with the values,
 * written to a new run directory under the same session.
 */
export function resumeOptions(scopes: Scopes, args: ResumeArgs): RunOptions {
  const last = resumable(scopes, args.session);
  if (last === null) throw new Error(`session ${args.session} has no run to resume`);
  const { from, state } = last;
  if (state.status !== "blocked" && state.status !== "stopped") {
    throw new Error(`session ${args.session}'s last run is ${state.status}, not blocked or stopped: nothing to resume`);
  }
  const maxSteps = typeof state.maxSteps === "number" ? state.maxSteps : DEFAULT_MAX_STEPS;
  const taken = typeof state.steps === "number" ? state.steps : 0;
  // A walk numbers its steps on from the one it resumes, so its budget counts them; a goal run starts its count again.
  const walk = typeof state.goal !== "string";
  const left = args.maxSteps ?? Math.max(0, maxSteps - taken);
  // Checked before the run directory exists: an empty one would be the session's newest run, and hide this one.
  const values = labelled(args.given, state.blocker as Blocker | undefined);
  return {
    goal: walk ? "" : (state.goal as string),
    ...(walk && typeof state.policy === "string" ? { policy: state.policy } : {}),
    ...(walk && typeof state.fixtures === "string" ? { fixtures: state.fixtures } : {}),
    session: args.session,
    maxSteps: walk ? taken + left : left,
    out: args.out ?? newRunDir(scopes, args.session),
    allow: widened(allowOf(state.allow), args.allow),
    model: typeof state.model === "string" ? state.model : DEFAULT_MODEL,
    human: args.human,
    handoff: args.handoff,
    display: canShowWindow(),
    loginTimeoutMs: args.loginTimeoutMs,
    ...(args.record === undefined ? {} : { record: args.record }),
    ...(args.quiet ? {} : { progress: (line: string) => process.stderr.write(`${line}\n`) }),
    resume: {
      from,
      ...(args.open === undefined ? {} : { open: args.open }),
      values,
    },
  };
}
