export type Operation = "CLICK" | "TYPE_TEXT" | "SELECT";

export interface Option {
  index: string;
  ref: string;
  label: string;
  value: string;
  selected: boolean;
}

/** One thing Jev can act on, with the state the accessibility tree shows for it. */
export interface Element {
  index: string;
  ref: string;
  role: string;
  label: string;
  value?: string;
  checked?: boolean | "mixed";
  expanded?: boolean;
  selected?: boolean;
  options?: Option[];
  operations: Operation[];
}

export const MAX_ELEMENTS = 250;

const CLICK_ROLES = new Set(["link", "button", "checkbox", "radio", "tab", "menuitem", "option"]);
const TYPE_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);

interface Line {
  depth: number;
  role: string;
  name: string;
  attrs: Map<string, string | true>;
  value?: string;
}

// `- role "name" [k=v, flag, ref=e1]: value`; name and attrs are optional.
const LINE = /^(\s*)- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?(?:: (.*))?$/;

function parseLine(raw: string): Line | null {
  const match = LINE.exec(raw);
  if (!match) return null;
  const [, indent, role, name = "", attrText = "", value] = match;
  const attrs = new Map<string, string | true>();
  for (const attr of attrText.split(",").map((a) => a.trim()).filter(Boolean)) {
    const eq = attr.indexOf("=");
    if (eq === -1) attrs.set(attr, true);
    else attrs.set(attr.slice(0, eq), attr.slice(eq + 1));
  }
  return { depth: indent.length, role, name: name.replace(/\\(.)/g, "$1"), attrs, value };
}

function flag(attrs: Map<string, string | true>, key: string): boolean | "mixed" | undefined {
  const raw = attrs.get(key);
  if (raw === undefined) return undefined;
  if (raw === true || raw === "true") return true;
  if (raw === "mixed") return "mixed";
  return false;
}

function isPassword(line: Line): boolean {
  return /password/i.test(line.name) || /^•+$/.test(line.value ?? "");
}

function operationsFor(line: Line, options: Option[]): Operation[] {
  if (line.attrs.has("disabled")) return [];
  if (line.role === "combobox") return options.length > 0 ? ["SELECT"] : ["TYPE_TEXT", "CLICK"];
  if (TYPE_ROLES.has(line.role)) return isPassword(line) ? [] : ["TYPE_TEXT", "CLICK"];
  if (CLICK_ROLES.has(line.role)) return ["CLICK"];
  return [];
}

/** Turns the text `snapshot` of `snapshot -i --json` into elements with values, states and options. */
export function parseSnapshot(text: string): Element[] {
  const lines = text.split("\n").map(parseLine).filter((l): l is Line => l !== null);
  const elements: Element[] = [];

  for (let i = 0; i < lines.length && elements.length < MAX_ELEMENTS; i++) {
    const line = lines[i];
    const index = String(elements.length + 1);
    const options: Option[] = [];
    if (line.role === "combobox") {
      while (i + 1 < lines.length && lines[i + 1].depth > line.depth && lines[i + 1].role === "option") {
        const option = lines[++i];
        options.push({
          index: `${index}:${options.length + 1}`,
          ref: String(option.attrs.get("ref")),
          label: option.name,
          value: option.name,
          selected: flag(option.attrs, "selected") === true,
        });
      }
    }
    const operations = operationsFor(line, options);
    if (operations.length === 0) continue;

    const element: Element = { index, ref: String(line.attrs.get("ref")), role: line.role, label: line.name.trim(), operations };
    if (line.value !== undefined) element.value = line.value;
    const checked = flag(line.attrs, "checked");
    if (checked !== undefined) element.checked = checked;
    const expanded = flag(line.attrs, "expanded");
    if (expanded !== undefined) element.expanded = expanded === true;
    if (line.role === "tab" || line.role === "option") element.selected = flag(line.attrs, "selected") === true;
    if (options.length > 0) element.options = options;
    elements.push(element);
  }
  return elements;
}
