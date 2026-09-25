import { withStateFile } from "./auth.js";
import type { Browser } from "./browser.js";
import { parseSnapshot, type Element } from "./snapshot.js";

/** How long a run holds the window open for the person to sign in. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 1000;

function password(element: Element): boolean {
  return element.password === true;
}

/** The same page under a different query or hash, so `/login?next=/billing` still matches a profile saved on `/login`. */
function samePage(a: string, b: string): boolean {
  const x = new URL(a);
  const y = new URL(b);
  return x.origin === y.origin && x.pathname === y.pathname;
}

/** The saved `auth` profile for this page, or null when none is saved for it. */
export async function authProfileFor(browser: Browser, url: string): Promise<string | null> {
  return (await browser.authProfiles()).find((profile) => samePage(profile.url, url))?.name ?? null;
}

export interface Handoff {
  browser: Browser;
  /** The login page the run hands over. */
  url: string;
  /** Every origin the run has been on. The person is signed in once they land on one of them, so an SSO page on the way is not taken for the app. */
  origins: Set<string>;
  timeoutMs: number;
  /** Runs once the window is open, so the run can report `status: "login"`. */
  opened(): Promise<void>;
  /** Runs once the person has landed, with the file their sign-in was saved to from the window, so the run can keep it. */
  signedIn(state: string): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}

/** The first read after a relaunch can race the page and throw, so the run lets it load first. A page that never goes quiet times the wait out, and the run goes on. */
async function settle(browser: Browser): Promise<void> {
  await browser.wait("networkidle").catch(() => undefined);
}

/** The URL the person landed on: off the login page, on an origin the run knows, with no password field left. Null when the wait ran out. */
async function landing({ browser, url, origins, timeoutMs }: Handoff): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await browser.snapshot(true);
    const here = snapshot.url;
    if (here !== url && origins.has(new URL(here).origin) && !parseSnapshot(snapshot.tree).some(password)) return here;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await sleep(Math.min(POLL_MS, left));
  }
}

/**
 * Hands the login to the person: closes the headless browser, opens a window on the login page, and polls the page
 * until they are signed in. Then it saves the window's cookies and storage, closes it, and loads them into a headless
 * browser on the page where they landed. A wait that runs out goes back the same way, to the login page.
 * Returns where the person landed, or null when the wait ran out.
 */
export async function handoff(input: Handoff): Promise<string | null> {
  const { browser, url } = input;
  await browser.close();
  await browser.openWindow(url);
  await input.opened();
  await settle(browser);
  const landed = await landing(input);
  return withStateFile(async (state) => {
    await browser.saveState(state);
    if (landed !== null) await input.signedIn(state);
    await browser.close();
    await browser.loadState(state);
    await browser.open(landed ?? url);
    await settle(browser);
    return landed;
  });
}
