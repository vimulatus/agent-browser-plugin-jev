import { THRESHOLD, type Decision, type Field } from "./decide.js";

/** What stopped a blocked run. Agents branch on `kind` and fill `fields`, so both are part of the output shape. */
export type BlockerKind =
  | "otp"
  | "sign_in"
  | "approval"
  | "captcha"
  | "missing_value"
  | "permission"
  | "error_page"
  | "rate_limit"
  | "unknown";

export interface Blocker {
  kind: BlockerKind;
  /** Every input the blocker needs, by the label `resume --value` names it with; empty when the kind needs none. */
  fields: Field[];
  reason: string;
  /** On `rate_limit`, the seconds the page's `Retry-After` asks to wait, when it sent one. */
  retryAfter?: number;
}

/** The kinds a value given to `resume` gets past. The rest need a person, a permission or time. */
const TAKES_VALUES = new Set<BlockerKind>(["otp", "sign_in", "missing_value"]);

/** Why the run ended blocked, as the loop knows it: a click it refused, a field the goal holds no value for, or neither. */
export type Cause = "refused" | "no_value" | null;

/** The kind Jev judged at more than even odds, or null when it judged nothing stops the goal or was unsure. */
export function judgedKind(decision: Decision): BlockerKind | null {
  const { kind, probability } = decision.blocker;
  if (kind === "none" || probability < THRESHOLD) return null;
  return kind as BlockerKind;
}

/**
 * Names what stopped the run. A refused click is `permission`, with no question asked. A field the goal holds no value
 * for is `missing_value`, unless Jev judges the page a code or a sign-in step. Anything else is the kind Jev judged,
 * or `unknown` when it was unsure. `decision` is the last one the run made, on the page it blocked on.
 */
export function blockerOf(reason: string, decision: Decision | null, cause: Cause): Blocker {
  if (cause === "refused") return { kind: "permission", fields: [], reason };
  const judged = decision === null ? null : judgedKind(decision);
  let kind: BlockerKind = judged ?? "unknown";
  if (cause === "no_value" && judged !== "otp" && judged !== "sign_in") kind = "missing_value";
  const fields = TAKES_VALUES.has(kind) && decision !== null ? decision.unfilled() : [];
  return { kind, fields, reason };
}
