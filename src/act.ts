import type { Decision } from "./decide.js";

/**
 * The agent-browser command one decision runs, or null when the run stops instead.
 * `human` approaches a click along an eased curve instead of jumping to it.
 */
export function commandFor(decision: Decision, human: boolean): string[] | null {
  const ref = `@${decision.ref}`;
  switch (decision.operation) {
    case "CLICK":
      return human ? ["click", ref, "--human"] : ["click", ref];
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
