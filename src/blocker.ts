import { THRESHOLD, type Decision, type Field } from "./decide.js";
import type { Observation } from "./observe.js";

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

/**
 * The blocker the page's own document request names, with no question asked: a 5xx is `error_page` and a 429 is
 * `rate_limit`. Null when the page loaded, or its request is not in the log. The log keeps every request since the
 * browser opened, so the page's request is the last document request for its URL.
 */
export function networkBlocker(page: Observation): Blocker | null {
  const document = page.requests.filter((request) => request.resourceType === "Document" && request.url === page.url).at(-1);
  const status = document?.status ?? null;
  if (status === 429) {
    const retryAfter = document?.retryAfter;
    const wait = retryAfter === undefined ? "" : `, retry after ${retryAfter} s`;
    return { kind: "rate_limit", fields: [], reason: `the page returned HTTP 429${wait}`, ...(retryAfter === undefined ? {} : { retryAfter }) };
  }
  if (status !== null && status >= 500) return { kind: "error_page", fields: [], reason: `the page returned HTTP ${status}` };
  return null;
}

/**
 * Why the run must not act on this page, whatever operation Jev picked, or null when it may: a captcha, a wait for
 * approval, or a sign-in with nothing typed and nothing the goal can type, such as a magic-link page. Each act there counts as an
 * attempt on a real app: a failed captcha, a resent email.
 */
export function blocksBeforeActing(decision: Decision, page: Observation): string | null {
  const kind = judgedKind(decision);
  if (kind === "captcha") return "the page asks to prove the user is a person";
  if (kind === "approval") return "the page waits for the user to approve on another device";
  if (kind !== "sign_in") return null;
  const typing = decision.operation === "TYPE_TEXT" && decision.value !== null;
  const fields = page.elements.filter((element) => element.operations.includes("TYPE_TEXT"));
  const typed = fields.some((element) => (element.value ?? "").trim() !== "");
  if (typing || typed || decision.unfilled().length < fields.length) return null;
  return "the page asks to sign in, and the goal holds nothing to sign in with";
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
