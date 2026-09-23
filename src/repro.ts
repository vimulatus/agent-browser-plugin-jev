import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "./browser.js";
import { pageHash } from "./hash.js";
import { observe, type Observation } from "./observe.js";
import type { Previous } from "./policy/index.js";
import { parseSnapshot, type Operation } from "./snapshot.js";

/** What the replay needs of one action the walk took. A ref dies with its snapshot, so the role and the label find it again. */
export interface Replayable {
  step: number;
  kind: Operation;
  role: string;
  label: string;
  value: string | null;
  fixture: string | null;
}

/** One replayed action and the page it left behind. */
export interface ReproAction {
  action: string;
  url: string;
  screenshot: string;
}

/** What a finding gains once the walk has tried to reproduce it. */
export interface Reproduction {
  reproduced: boolean;
  repro?: ReproAction[];
  recording?: string;
  console?: string[];
  errors?: string[];
}

export interface ReproInput {
  browser: Browser;
  /** The walk's saved cookies and storage, loaded into the replay before it opens the start page. */
  state: string;
  out: string;
  /** The page the walk started on. The replay begins there, on a tab of its own. */
  home: string;
  /** Names the evidence: `<out>/evidence/<number>.webm` and one `<number>-<step>.png` per action. */
  number: number;
  actions: Replayable[];
  fixtures: Record<string, string>;
  /** Whether the policy raises the same finding again on the page the replay lands on. */
  fires(page: Observation, previous: Previous | undefined): Promise<boolean>;
}

function describe(action: Replayable): string {
  switch (action.kind) {
    case "CLICK":
      return `click "${action.label}"`;
    case "SELECT":
      return `select "${action.value}" in "${action.label}"`;
    case "TYPE_TEXT":
      return `fill "${action.label}" with "${action.value}"`;
  }
}

async function page(browser: Browser) {
  const snapshot = await browser.snapshot(true);
  return { elements: parseSnapshot(snapshot.tree), hash: pageHash(snapshot.url, snapshot.tree) };
}

/**
 * Replays the actions that led to a finding on a fresh tab from the same start, under a recording with a cursor
 * and a screenshot after every act. The start page is given until the network goes quiet, so a finding raised by
 * a request the page makes on load is seen again. A control the page no longer offers, or a policy that stays
 * quiet on the page the replay lands on, makes the finding a one-off: it is kept, unreproduced.
 */
export async function reproduce(input: ReproInput): Promise<Reproduction> {
  const { browser, number, fixtures } = input;
  const evidence = join(input.out, "evidence");
  await mkdir(evidence, { recursive: true });
  const recording = join(evidence, `${number}.webm`);

  // The buffers hold what every earlier replay printed and asked for, and this finding quotes only its own.
  await browser.clearLogs();
  await browser.openTab();
  await browser.loadState(input.state);
  await browser.record(recording);
  try {
    await browser.open(input.home);
    // A request the page makes on load answers after its load event, and the finding can be that request.
    await browser.wait("networkidle");
    const replayed: ReproAction[] = [];
    let previous: Previous | undefined;
    for (const action of input.actions) {
      const before = await page(browser);
      const element = before.elements.find((one) => one.role === action.role && one.label === action.label);
      if (element === undefined) return { reproduced: false };

      const value = action.fixture === null ? action.value : fixtures[action.fixture];
      await browser.act({ operation: action.kind, ref: element.ref, value });
      // A click that navigates returns before the new page paints, and the shot is the evidence.
      await browser.wait("load");
      const screenshot = join(evidence, `${number}-${action.step}.png`);
      await browser.screenshot(screenshot);
      const url = await browser.url();

      replayed.push({ action: describe(action), url, screenshot });
      previous = { hash: before.hash, action: { kind: action.kind, label: action.label } };
    }

    const landed = await observe(browser);
    if (!(await input.fires(landed, previous))) return { reproduced: false };
    return {
      reproduced: true,
      repro: replayed,
      recording,
      console: landed.console.map((message) => `${message.type}: ${message.text}`),
      errors: landed.errors.map((error) => error.text),
    };
  } finally {
    await browser.stopRecording();
    await browser.closeTab();
  }
}
