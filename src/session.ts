import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "./browser.js";
import { activeScope, type Scopes } from "./scope.js";

/** The store key every piece of a session's state sits under: `sessions/<session>`. */
export function sessionKey(session: string): string {
  if (session === "" || session === "." || session === ".." || /[/\\]/.test(session)) {
    throw new Error(`session ${JSON.stringify(session)} names a directory, so it cannot be empty, "." or ".." or hold a / or \\`);
  }
  return `sessions/${session}`;
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
 * `soab session reset <session>`: closes the session's browser, then deletes its runs and its `auth.json` from the
 * active scope's store. `deleted` is the session's directory, or null when it had no state.
 */
export async function resetSession(
  scopes: Scopes,
  session: string,
  browser: Browser,
): Promise<{ session: string; deleted: string | null }> {
  const key = sessionKey(session);
  await browser.close();
  const { dir, store } = activeScope(scopes);
  const keys = await store.list(`${key}/`);
  for (const stored of keys) await store.delete(stored);
  const sessionDir = join(dir, key);
  const hadLocalDir = existsSync(sessionDir);
  await rm(sessionDir, { recursive: true, force: true });
  return { session, deleted: keys.length > 0 || hadLocalDir ? sessionDir : null };
}
