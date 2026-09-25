import type { Browser } from "./browser.js";
import type { Element } from "./snapshot.js";

/**
 * The single-character boxes a value is spread over, one character each, or null when it is typed as it is. They
 * are the field Jev picked and the fields right after it on the page, each with `maxlength` 1, and there must be
 * exactly one per character: `fill` puts the whole value into each box, and a box that keeps one character and does
 * not move focus on keeps only the first.
 */
export async function codeBoxes(browser: Browser, elements: Element[], ref: string | null, value: string | null): Promise<Element[] | null> {
  if (ref === null || value === null || value.length < 2) return null;
  const start = elements.findIndex((element) => element.ref === ref);
  const boxes: Element[] = [];
  for (const element of elements.slice(start, start + value.length + 1)) {
    if (!element.operations.includes("TYPE_TEXT") || (await browser.maxLength(element.ref)) !== 1) break;
    boxes.push(element);
  }
  return boxes.length === value.length ? boxes : null;
}
