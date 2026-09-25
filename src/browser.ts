import { agentBrowser } from "./agent-browser.js";
import type { Operation } from "./decide.js";

/** What a decision or a walk does to the page, and to which element. `ref` is the one the snapshot gave it. */
export interface Act {
  operation: Operation;
  ref: string | null;
  value: string | null;
}

/**
 * The page as an accessibility tree in the aria snapshot YAML: `- role "name" [attrs, ref=e1]: value`, one node per
 * line. `ref` names an element to `act` on, until the next snapshot.
 */
export interface Snapshot {
  url: string;
  tree: string;
}

export interface ConsoleMessage {
  type: string;
  text: string;
}

export interface PageError {
  text: string;
  url: string | null;
  line: number | null;
  column: number | null;
}

export interface Request {
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  mimeType: string | null;
  timestamp: number;
}

/** A saved login: the page it signs in on, and the name `signIn` takes. */
export interface AuthProfile {
  name: string;
  url: string;
}

/**
 * One browser session, in the terms Jev reads and acts in. A driver implements it over one browser tool;
 * `agent-browser.ts` is the one there is. Every method acts on the session's active tab.
 */
export interface Browser {
  open(url: string): Promise<void>;
  reload(): Promise<void>;
  /** Waits for the load event, or for the network to go quiet. */
  wait(until: "load" | "networkidle"): Promise<void>;
  /** `interactive` keeps only what the page offers to act on, and drops the text around it. */
  snapshot(interactive: boolean): Promise<Snapshot>;
  title(): Promise<string>;
  url(): Promise<string>;
  console(): Promise<ConsoleMessage[]>;
  errors(): Promise<PageError[]>;
  requests(): Promise<Request[]>;
  /** Empties the console, the errors and the requests, so what comes after is read on its own. */
  clearLogs(): Promise<void>;
  /** Runs one act. SCROLL and WAIT need no ref; BLOCKED and DONE are not acts, and throw. */
  act(act: Act): Promise<void>;
  screenshot(path: string): Promise<void>;
  /** Records the tab to a .webm or .mp4, cursor included, until `stopRecording`. */
  record(path: string): Promise<void>;
  stopRecording(): Promise<void>;
  /** Starts a HAR of every request; `stopHar` returns the path of the HAR file it wrote. */
  startHar(): Promise<void>;
  stopHar(): Promise<string>;
  /** Opens a blank tab and makes it active; `closeTab` closes it and returns to the one before. */
  openTab(): Promise<void>;
  closeTab(): Promise<void>;
  /** Cookies and storage, to a file and back, so a second session or a relaunch starts where this browser is. */
  saveState(path: string): Promise<void>;
  /** Loads what `saveState` wrote, for the next `open`. With no browser open, it launches one headless. */
  loadState(path: string): Promise<void>;
  authProfiles(): Promise<AuthProfile[]>;
  signIn(profile: string): Promise<void>;
  /** Closes the browser. What it held is gone unless `saveState` wrote it first. */
  close(): Promise<void>;
  /** Launches a browser in a window on `url`, after `close`. */
  openWindow(url: string): Promise<void>;
}

/**
 * The browser a run drives, on one session. `human` moves the pointer along a curve instead of jumping.
 * agent-browser is the only driver; another one is chosen here, and nothing past this line changes.
 */
export function openBrowser(session: string, human = false): Browser {
  return agentBrowser(session, human);
}
