import { formatPath, lookup, parsePath, type Path } from "./path.js";

/** A title template: literal text and `{{path}}` placeholders. */
export type Template = (string | Path)[];

const PLACEHOLDER = /\{\{([^}]*)\}\}|\{\{/g;

export function parseTemplate(text: string): Template {
  const template: Template = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const path = match[1] === undefined ? null : parsePath(match[1].trim());
    if (!path) throw new Error(`template "${text}": bad placeholder at "${text.slice(match.index)}"`);
    if (match.index > last) template.push(text.slice(last, match.index));
    template.push(path);
    last = match.index + match[0].length;
  }
  if (last < text.length) template.push(text.slice(last));
  return template;
}

export function render(template: Template, facts: unknown): string {
  return template
    .map((part) => {
      if (typeof part === "string") return part;
      const value = lookup(facts, part);
      if (value === undefined) throw new Error(`template: no value at ${formatPath(part)}`);
      return String(value);
    })
    .join("");
}

export function pathsOf(template: Template): Path[] {
  return template.filter((part): part is Path => typeof part !== "string");
}
