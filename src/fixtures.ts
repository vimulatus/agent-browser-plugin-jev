import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/** The test data a walk types into a form. Jev picks the key per field; the plugin never writes a value. */
export const DEFAULT_FIXTURES: Record<string, string> = {
  email: "jev.tester@example.com",
  password: "Test-Passw0rd-42",
  name: "Jev Tester",
  phone: "+1 555 0142",
  address: "100 Test Street, Springfield IL 62704",
};

/** The built-in values, with the file's own on top: a key it names is replaced, a key it adds is offered too. */
export function loadFixtures(path?: string): Record<string, string> {
  if (path === undefined) return { ...DEFAULT_FIXTURES };
  const doc: unknown = parseYaml(readFileSync(path, "utf8"));
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`fixtures ${path}: expected a mapping of a key to the value to type`);
  }
  const given = Object.entries(doc as Record<string, unknown>).map(([key, value]) => {
    if (typeof value !== "string") throw new Error(`fixtures ${path}: ${key} must be the text to type`);
    return [key, value] as const;
  });
  return { ...DEFAULT_FIXTURES, ...Object.fromEntries(given) };
}
