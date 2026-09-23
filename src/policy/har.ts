import { readFileSync } from "node:fs";
import type { Browser } from "../browser.js";
import type { RequestFact } from "./facts.js";

interface Entry {
  startedDateTime: string;
  time: number;
  _resourceType?: string;
  request: { method: string; url: string };
  response: { status: number; content?: { mimeType?: string } };
}

const SETTLE_INTERVAL = 100;
const SETTLE_TIMEOUT = 15_000;

/** The requests of a HAR the browser wrote, with the duration of each. A request that never answered has neither. */
export function readHar(path: string): RequestFact[] {
  const { log } = JSON.parse(readFileSync(path, "utf8")) as { log: { entries: Entry[] } };
  return log.entries.map((entry) => {
    const answered = entry.response.status > 0;
    return {
      method: entry.request.method,
      url: entry.request.url,
      path: new URL(entry.request.url).pathname,
      status: answered ? entry.response.status : null,
      resourceType: entry._resourceType ?? "Other",
      mimeType: entry.response.content?.mimeType ?? null,
      timestamp: Date.parse(entry.startedDateTime),
      time: answered ? Math.round(entry.time) : null,
    };
  });
}

/** Reloads the page under a HAR recording, so every request the page makes is timed. */
export async function recordHar(browser: Browser): Promise<RequestFact[]> {
  await browser.startHar();
  try {
    await browser.reload();
    await settle(browser);
  } catch (failure) {
    await stop(browser);
    throw failure;
  }
  return stop(browser);
}

async function stop(browser: Browser): Promise<RequestFact[]> {
  return readHar(await browser.stopHar());
}

/** Reads the request log until nothing is in flight. A request that never answers ends the wait at the timeout. */
async function settle(browser: Browser): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT;
  for (;;) {
    const requests = await browser.requests();
    if (requests.every((request) => typeof request.status === "number")) return;
    if (Date.now() >= deadline) return;
    await new Promise((waited) => setTimeout(waited, SETTLE_INTERVAL));
  }
}
