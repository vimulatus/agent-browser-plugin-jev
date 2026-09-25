import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "./browser.js";
import { NAME } from "./name.js";
import { authKey } from "./session.js";
import type { Store } from "./store.js";

/**
 * The browser reads and writes its state as a file, so each crossing goes through a temp file outside the run
 * directory: a run's evidence gets shared, and the sign-in must not ride along with it.
 */
export async function withStateFile<T>(use: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${NAME}-auth-`));
  try {
    return await use(join(dir, "auth.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Loads the session's saved sign-in into the browser, before its first open, and records it as used, so eviction
 * keeps it longest. A session with none loads nothing.
 */
export async function loadAuth(store: Store, session: string, browser: Browser): Promise<void> {
  const saved = await store.get(authKey(session));
  if (saved === null) return;
  await store.touch(authKey(session));
  await withStateFile(async (path) => {
    await writeFile(path, saved);
    await browser.loadState(path);
  });
}

/** Keeps a file `Browser.saveState` wrote as the session's sign-in, for its next run. */
export async function keepAuth(store: Store, session: string, path: string): Promise<void> {
  await store.put(authKey(session), await readFile(path));
}

/** Saves the browser's cookies and storage as the session's sign-in, for its next run. */
export async function saveAuth(store: Store, session: string, browser: Browser): Promise<void> {
  await withStateFile(async (path) => {
    await browser.saveState(path);
    await keepAuth(store, session, path);
  });
}
