import type { AgentBrowser } from "./agent-browser.js";
import { pageHash } from "./hash.js";
import { parseSnapshot, type Element } from "./snapshot.js";

export const MAX_TEXT = 6000;

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

/** Everything Jev sees of the page at one moment. `hash` changes when the url or the tree changes. */
export interface Observation {
  url: string;
  title: string;
  text: string;
  elements: Element[];
  console: ConsoleMessage[];
  errors: PageError[];
  requests: Request[];
  hash: string;
}

interface Snapshot {
  origin: string;
  snapshot: string;
}

/** Reads the page through five agent-browser calls and returns one Observation. */
export async function observe(browser: AgentBrowser): Promise<Observation> {
  const snapshot = (await browser.run(["snapshot", "-i"])) as unknown as Snapshot;
  const { title } = (await browser.run(["get", "title"])) as { title: string };
  const { messages } = (await browser.run(["console"])) as { messages: ConsoleMessage[] };
  const { errors } = (await browser.run(["errors"])) as { errors: PageError[] };
  const { requests } = (await browser.run(["network", "requests"])) as { requests: Request[] };

  return {
    url: snapshot.origin,
    title,
    text: snapshot.snapshot.slice(0, MAX_TEXT),
    elements: parseSnapshot(snapshot.snapshot),
    console: messages.map(({ type, text }) => ({ type, text })),
    errors: errors.map(({ text, url, line, column }) => ({ text, url, line, column })),
    requests: requests.map(({ method, url, status, resourceType, mimeType, timestamp }) => ({
      method,
      url,
      status,
      resourceType,
      mimeType,
      timestamp,
    })),
    hash: pageHash(snapshot.origin, snapshot.snapshot),
  };
}
