import type { Browser, ConsoleMessage, PageError, Request } from "./browser.js";
import { pageHash } from "./hash.js";
import { parseSnapshot, type Element } from "./snapshot.js";

export type { ConsoleMessage, PageError, Request };

export const MAX_TEXT = 6000;

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

/** The hash alone, from one snapshot, to check the page has not moved under a decision. */
export async function snapshotHash(browser: Browser): Promise<string> {
  const snapshot = await browser.snapshot(true);
  return pageHash(snapshot.url, snapshot.tree);
}

/** Reads the page through five browser calls and returns one Observation. */
export async function observe(browser: Browser): Promise<Observation> {
  const snapshot = await browser.snapshot(true);
  return {
    url: snapshot.url,
    title: await browser.title(),
    text: snapshot.tree.slice(0, MAX_TEXT),
    elements: parseSnapshot(snapshot.tree),
    console: await browser.console(),
    errors: await browser.errors(),
    requests: await browser.requests(),
    hash: pageHash(snapshot.url, snapshot.tree),
  };
}
