import type { Element } from "./snapshot.js";

/** One control the walk has seen. Keyed by where it is and what it is, because a ref dies with its snapshot. */
export interface Entry {
  path: string;
  url: string;
  role: string;
  label: string;
  tried: boolean;
}

/** What is left to try, across every page the walk has been on. */
export interface Frontier {
  see(url: string, elements: Element[]): void;
  here(url: string, elements: Element[]): { element: Element; entry: Entry }[];
  pending(): Entry | null;
  entries(): Entry[];
}

function keyOf(path: string, element: Element): string {
  return `${path}|${element.role}|${element.label}`;
}

/** The frontier of one walk: every control it has seen, in the order it first saw them, from `saved` when it resumes. */
export function frontier(saved: Entry[] = []): Frontier {
  const entries = new Map<string, Entry>(saved.map((entry) => [`${entry.path}|${entry.role}|${entry.label}`, entry]));
  return {
    see(url, elements) {
      const path = new URL(url).pathname;
      for (const element of elements) {
        const key = keyOf(path, element);
        if (!entries.has(key)) entries.set(key, { path, url, role: element.role, label: element.label, tried: false });
      }
    },
    here(url, elements) {
      const path = new URL(url).pathname;
      return elements
        .map((element) => ({ element, entry: entries.get(keyOf(path, element)) }))
        .filter((pair): pair is { element: Element; entry: Entry } => pair.entry?.tried === false);
    },
    pending() {
      return [...entries.values()].find((entry) => !entry.tried) ?? null;
    },
    entries() {
      return [...entries.values()];
    },
  };
}
