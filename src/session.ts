import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { activeScope, type Scopes } from "./scope.js";

/** The store key every piece of a session's state sits under: `sessions/<session>`. */
export function sessionKey(session: string): string {
  if (session === "" || session === "." || session === ".." || /[/\\]/.test(session)) {
    throw new Error(`session ${JSON.stringify(session)} names a directory, so it cannot be empty, "." or ".." or hold a / or \\`);
  }
  return `sessions/${session}`;
}

/** The store key of a session's sign-in: the cookies and storage `Browser.saveState` writes. */
export function authKey(session: string): string {
  return `${sessionKey(session)}/auth.json`;
}

/**
 * Creates `sessions/<session>/runs/<timestamp>-<suffix>/` in the active scope and returns its path. The names sort
 * in the order the runs started, and the suffix keeps two runs in one millisecond apart.
 */
export function newRunDir(scopes: Scopes, session: string, now = new Date()): string {
  const runs = join(activeScope(scopes).dir, sessionKey(session), "runs");
  mkdirSync(runs, { recursive: true });
  return mkdtempSync(join(runs, `${now.toISOString().replace(/[:.]/g, "-")}-`));
}
