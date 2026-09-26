import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeScope, type Scopes } from "./scope.js";
import { sessionKey } from "./session.js";

/** The file `soab stop` writes into a running run's directory; the run checks for it before each step. */
export const STOP_FILE = "stop";

/** A run's `status.json`, as another command reads it. */
export interface RunState {
  status: string;
  [key: string]: unknown;
}

/** The directory of the session's newest run in the active scope, or null when it has none. Run names sort by start. */
export function latestRun(scopes: Scopes, session: string): string | null {
  const runs = join(activeScope(scopes).dir, sessionKey(session), "runs");
  if (!existsSync(runs)) return null;
  const newest = readdirSync(runs).sort().at(-1);
  return newest === undefined ? null : join(runs, newest);
}

/**
 * The session's newest run that wrote a `status.json`, with it, or null when none did. A directory with none is a run
 * that never started, such as one an older `resume` made before refusing its value.
 */
export function latestState(scopes: Scopes, session: string): { from: string; state: RunState } | null {
  const runs = join(activeScope(scopes).dir, sessionKey(session), "runs");
  if (!existsSync(runs)) return null;
  for (const name of readdirSync(runs).sort().reverse()) {
    const state = readState(join(runs, name));
    if (state !== null) return { from: join(runs, name), state };
  }
  return null;
}

export function readState(dir: string): RunState | null {
  const path = join(dir, "status.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RunState) : null;
}

/** Whether a run is still going: it writes `running`, or `login` while a window waits for the person. */
export function going(state: RunState | null): boolean {
  return state?.status === "running" || state?.status === "login";
}

/**
 * `soab stop <session>`: asks the session's running run to stop, through a file in its directory that the run reads
 * before its next step. `stopping` is false, and nothing is written, when no run of the session is going.
 */
export function stopSession(scopes: Scopes, session: string): { session: string; out: string | null; stopping: boolean } {
  const out = latestRun(scopes, session);
  if (out === null || !going(readState(out))) return { session, out, stopping: false };
  writeFileSync(join(out, STOP_FILE), `${new Date().toISOString()}\n`);
  return { session, out, stopping: true };
}
