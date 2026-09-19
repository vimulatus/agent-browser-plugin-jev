/** A dotted path into the facts, `console.errors[0].text` as `["console", "errors", 0, "text"]`. */
export type Path = (string | number)[];

const PATH = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[\d+\])*$/;
const SEGMENT = /[A-Za-z_]\w*|\[\d+\]/g;

/** Parses `a.b[0].c`; returns null when the text is not a path. */
export function parsePath(text: string): Path | null {
  if (!PATH.test(text)) return null;
  return (text.match(SEGMENT) ?? []).map((s) => (s.startsWith("[") ? Number(s.slice(1, -1)) : s));
}

export function formatPath(path: Path): string {
  return path.map((s, i) => (typeof s === "number" ? `[${s}]` : i === 0 ? s : `.${s}`)).join("");
}

/** Reads the value at `path`; undefined when any step is missing. `any` on a list is "not empty". */
export function lookup(facts: unknown, path: Path): unknown {
  let value: unknown = facts;
  for (const segment of path) {
    if (segment === "any" && Array.isArray(value)) return value.length > 0;
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[segment];
  }
  return value;
}
