import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "./browser.js";
import { activeScope, type Scopes } from "./scope.js";

/** The store key every piece of a session's state sits under: `sessions/<session>`. */
export function sessionKey(session: string): string {
  if (session === "" || session.startsWith(".") || /[/\\]/.test(session)) {
    throw new Error(`session ${JSON.stringify(session)} names a directory, so it cannot be empty, start with "." or hold a / or \\`);
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

/**
 * `soab session reset <session>`: closes the session's browser, deletes its runs and its `auth.json` from the active
 * scope's store through the same `deleteTree` eviction uses, then the sign-in the browser saved on close. `deleted`
 * lists the session's directory and each saved file it removed, and is empty when the session had no state.
 */
export async function resetSession(
  scopes: Scopes,
  session: string,
  browser: Browser,
): Promise<{ session: string; deleted: string[] }> {
  const key = sessionKey(session);
  await browser.close();
  const { dir, store } = activeScope(scopes);
  const sessionDir = join(dir, key);
  const hadLocalDir = existsSync(sessionDir);
  const keys = await store.deleteTree(`${key}/`);
  const saved = await browser.forgetSaved();
  return { session, deleted: [...(keys.length > 0 || hadLocalDir ? [sessionDir] : []), ...saved] };
}
