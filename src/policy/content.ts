import type { Browser } from "../browser.js";
import { MAX_TEXT } from "../observe.js";

/**
 * The text the page shows, from the whole accessibility tree. The observation's own tree comes from
 * an interactive snapshot, which keeps what the page offers to act on and drops every banner and label around it.
 */
export async function readContent(browser: Browser): Promise<string> {
  return (await browser.snapshot(false)).tree.slice(0, MAX_TEXT);
}
