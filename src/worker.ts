import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/** agent-browser kills a plugin at 60 s (cli/src/plugins.rs:847), so jev.run answers before that. */
const WAIT_CAP_MS = 55_000;
/** One file per run, holding its out directory, so jev.status finds a run whose --out went anywhere. */
const RUNS = join(tmpdir(), "jev-runs");

export interface RunRequest {
  goal?: string;
  policy?: string;
  url?: string;
  session?: string;
  maxSteps?: number;
  allow?: string | string[];
  fixtures?: string;
  record?: string;
  human?: boolean;
  /** `false` ends the run blocked at a login page instead of opening a window for it. */
  handoff?: boolean;
  /** Seconds the window stays open for the person to sign in. */
  loginTimeout?: number;
  out?: string;
  /** `true` waits up to 55 s for the run to end, a number waits that many milliseconds. A window opened for a login ends the wait too. */
  wait?: boolean | number;
}

export interface StatusRequest {
  runId?: string;
  out?: string;
}

/** A run as jev.run and jev.status report it: its status file, plus the handles onto it. */
export type RunState = { runId?: string; out: string; status: string } & Record<string, unknown>;

function runArgs(request: RunRequest, session: string, out: string): string[] {
  const args = ["run"];
  if (request.goal !== undefined) args.push(request.goal);
  args.push("--session", session, "--out", out);
  if (request.policy !== undefined) args.push("--policy", request.policy);
  if (request.url !== undefined) args.push("--url", request.url);
  if (request.maxSteps !== undefined) args.push("--max-steps", String(request.maxSteps));
  if (request.allow !== undefined) {
    args.push("--allow", Array.isArray(request.allow) ? request.allow.join(",") : request.allow);
  }
  if (request.fixtures !== undefined) args.push("--fixtures", request.fixtures);
  if (request.record !== undefined) args.push("--record", request.record);
  if (request.human === true) args.push("--human");
  if (request.handoff === false) args.push("--no-handoff");
  if (request.loginTimeout !== undefined) args.push("--login-timeout", String(request.loginTimeout));
  return args;
}

/**
 * Starts this same bin's `run` command in its own process group, writing to `<out>/worker.log`.
 * agent-browser reads the answer from the plugin's stdout until end of file (cli/src/plugins.rs:229),
 * so the worker inherits neither stdout nor stderr: it outlives the answer.
 */
function startWorker(args: string[], out: string): { worker: ChildProcess; ended: Promise<void> } {
  const log = openSync(join(out, "worker.log"), "a");
  const worker = spawn(process.execPath, [process.argv[1], ...args], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const ended = new Promise<void>((done) => {
    worker.once("exit", () => done());
    worker.once("error", () => done());
  });
  return { worker, ended };
}

function waitMsOf(wait: RunRequest["wait"]): number {
  if (wait === undefined || wait === false) return 0;
  if (wait === true) return WAIT_CAP_MS;
  return Math.min(Math.max(wait, 0), WAIT_CAP_MS);
}

function loginOpen(out: string): boolean {
  const path = join(out, "status.json");
  return existsSync(path) && (JSON.parse(readFileSync(path, "utf8")) as RunState).status === "login";
}

/**
 * Whether the run settled within the wait: it ended, or it opened a window for a login. The window is the
 * person's to act on, so the caller hears about it at once instead of after the wait.
 */
function settlesWithin(ended: Promise<void>, out: string, waitMs: number): Promise<boolean> {
  return new Promise((done) => {
    const finish = (settled: boolean) => {
      clearTimeout(timer);
      clearInterval(poll);
      done(settled);
    };
    const timer = setTimeout(() => finish(false), waitMs);
    const poll = setInterval(() => {
      if (loginOpen(out)) finish(true);
    }, 100);
    ended.then(() => finish(true));
  });
}

function lastLine(path: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  return text === "" ? null : text.split("\n").at(-1) ?? null;
}

/** The run's own status, or what it printed before it died without writing one. */
function stateOf(out: string): RunState {
  const status = join(out, "status.json");
  if (existsSync(status)) return { ...(JSON.parse(readFileSync(status, "utf8")) as RunState), out };
  const died = lastLine(join(out, "worker.log"));
  if (died !== null) return { out, status: "failed", reason: died };
  throw new Error(`no run at ${out}`);
}

function outOf(request: StatusRequest): string {
  if (request.out !== undefined) return resolve(request.out);
  const { runId } = request;
  if (runId === undefined) throw new Error("jev.status needs a runId or an out");
  if (runId !== basename(runId)) throw new Error(`runId "${runId}" is not a run`);
  const pointer = join(RUNS, runId);
  if (!existsSync(pointer)) throw new Error(`no run ${runId}`);
  return readFileSync(pointer, "utf8");
}

/**
 * `jev.run`: starts the run as a detached worker and answers at once with `status: "running"`.
 * With `wait` it answers with the run's final status instead, when the run ends in time, or with
 * `status: "login"` and the page's URL when the run opened a window for a login.
 */
export async function startRun(request: RunRequest): Promise<RunState> {
  if (request.goal === undefined && request.policy === undefined) throw new Error("jev.run needs a goal or a policy");
  const session = request.session ?? process.env.AGENT_BROWSER_SESSION ?? "";
  if (session === "") throw new Error("no session: pass session or set AGENT_BROWSER_SESSION");

  const runId = `jev-run-${randomBytes(5).toString("hex")}`;
  const out = request.out === undefined ? join(tmpdir(), runId) : resolve(request.out);
  mkdirSync(out, { recursive: true });
  mkdirSync(RUNS, { recursive: true });
  writeFileSync(join(RUNS, runId), out);

  const { worker, ended } = startWorker(runArgs(request, session, out), out);
  const waitMs = waitMsOf(request.wait);
  const finished = waitMs > 0 && (await settlesWithin(ended, out, waitMs));
  worker.unref();
  return finished ? { runId, ...stateOf(out) } : { runId, out, status: "running" };
}

/** `jev.status`: the run named by its runId, or by the out directory it writes to. */
export function runStatus(request: StatusRequest): RunState {
  const state = stateOf(outOf(request));
  return request.runId === undefined ? state : { runId: request.runId, ...state };
}
