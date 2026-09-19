import type { Decision } from "./decide.js";

/** The agent-browser command one decision runs, or null when the run stops instead. */
export function commandFor(decision: Decision): string[] | null {
  const ref = `@${decision.ref}`;
  switch (decision.operation) {
    case "CLICK":
      return ["click", ref];
    case "TYPE_TEXT":
      return ["fill", ref, decision.value ?? ""];
    case "SELECT":
      return ["select", ref, decision.value ?? ""];
    case "SCROLL_UP":
      return ["scroll", "up"];
    case "SCROLL_DOWN":
      return ["scroll", "down"];
    case "WAIT":
      return ["wait", "--load", "networkidle"];
    default:
      return null;
  }
}
