import type { AgentBrowser } from "../agent-browser.js";
import { MAX_TEXT } from "../observe.js";

/**
 * The text the page shows, from the whole accessibility tree. The observation's own tree comes from
 * `snapshot -i`, which keeps what the page offers to act on and drops every banner and label around it.
 */
export async function readContent(browser: AgentBrowser): Promise<string> {
  const { snapshot } = (await browser.run(["snapshot"])) as unknown as { snapshot: string };
  return snapshot.slice(0, MAX_TEXT);
}
