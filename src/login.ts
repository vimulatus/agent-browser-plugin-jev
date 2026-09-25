import type { Browser } from "./browser.js";
import type { Observation } from "./observe.js";
import { parseSnapshot, type Element } from "./snapshot.js";

/** How long a run holds the window open for the person to sign in. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 1000;

function password(element: Element): boolean {
  return element.password === true;
}

/** A page that shows a password field is a login page. */
export function loginPage(page: Observation): boolean {
  return page.elements.some(password);
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
  /** Runs once the person has landed, on the window they signed in on, so the run can save the sign-in. */
  signedIn(): Promise<void>;
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
 * Hands the login to the person: closes the headless browser, reopens the session in a window on the login page,
 * and polls the page until they are signed in. Then the window closes, which saves its cookies and storage under
 * the session, and the session reopens headless where they landed. On agent-browser 0.38.1 the first command after
 * that reopen relaunches a blank browser (#67), so the run saves the sign-in from the window, not after it.
 * Returns where the person landed, or null when the wait ran out and the window was closed.
 */
export async function handoff(input: Handoff): Promise<string | null> {
  const { browser, url } = input;
  await browser.close();
  await browser.reopen(url, true);
  await input.opened();
  await settle(browser);
  const landed = await landing(input);
  if (landed !== null) await input.signedIn();
  await browser.close();
  if (landed === null) return null;
  await browser.reopen(landed, false);
  await settle(browser);
  return landed;
}
