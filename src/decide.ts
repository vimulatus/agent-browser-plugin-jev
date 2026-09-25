import { choiceOf, noulOf, type Criteria, type Jev, type Question, type Request } from "./jev.js";
import type { Observation } from "./observe.js";
import { DESTRUCTIVE, DESTRUCTIVE_VERB, NEXT_ACTION, OPERATION_LABELS, OUTCOME, TARGET, VALUE, VERBS } from "./questions.js";
import type { Element, Operation as ElementOperation } from "./snapshot.js";
import { NO_VALUE } from "./spans.js";

export type Operation = ElementOperation | "SCROLL_UP" | "SCROLL_DOWN" | "WAIT" | "DONE" | "BLOCKED";

/** Above this, the destructive gate closes and a value span is not trusted. */
export const THRESHOLD = 0.5;

export interface Recent {
  operation: string;
  target: string | null;
  value: string | null;
  pageChanged: boolean | null;
}

/** What the run may do without asking: every verb in the set, or every verb at all. */
export type Allow = Set<string> | "all";

export interface Decision {
  operation: Operation;
  target: string | null;
  ref: string | null;
  label: string | null;
  value: string | null;
  valueProbability: number | null;
  valueProbabilities: Record<string, number>;
  password: boolean;
  destructive: { probability: number; verb: string | null } | null;
  /** On a DONE, how likely Jev judges the page to show the goal's outcome; null on any other operation. */
  outcome: number | null;
  confidence: number;
  probabilities: Record<string, number>;
  targetProbabilities: Record<string, number>;
  model: string;
  usage: Record<string, number>;
  latencyMs: number;
}

interface Target {
  element: Element;
  option?: { value: string; label: string };
  criteria: Record<string, unknown>;
}

/** What Jev sees of one element it could act on: what it is, and what it holds now. */
export function describe(element: Element): Record<string, unknown> {
  const { role, checked, selected, expanded, password } = element;
  return {
    element: `[${element.index}] ${element.label}`,
    current_value: password === true ? "" : (element.value ?? ""),
    ...(password === true ? { password: true } : {}),
    ...Object.fromEntries(
      Object.entries({ role, checked, selected, expanded }).filter(([, v]) => v !== undefined),
    ),
  };
}

/** A Choice question takes at most 255 options (docs.typesafe.ai/primitives/choice). */
const MAX_TARGETS = 250;

/**
 * Every typeable target carries its own value question, so the first this many fields of a page are
 * offered and the rest are not. A request holds 64k tokens (docs.typesafe.ai/models), and a value
 * question restates every span of the goal.
 */
export const MAX_TYPE_TEXT_TARGETS = 20;

function targetsFor(elements: Element[], operation: ElementOperation): Map<string, Target> {
  const targets = new Map<string, Target>();
  const limit = operation === "TYPE_TEXT" ? MAX_TYPE_TEXT_TARGETS : MAX_TARGETS;
  for (const element of elements) {
    if (targets.size >= limit) break;
    if (!element.operations.includes(operation)) continue;
    if (operation !== "SELECT") {
      targets.set(element.index, { element, criteria: describe(element) });
      continue;
    }
    for (const option of element.options ?? []) {
      if (targets.size >= limit) break;
      targets.set(option.index, {
        element,
        option,
        criteria: {
          element: `[${element.index}] ${element.label} → ${option.label}`,
          value: option.value,
          selected: option.selected,
        },
      });
    }
  }
  return targets;
}

function criteriaOf(targets: Map<string, Target>): Criteria {
  return Object.fromEntries([...targets].map(([index, target]) => [index, target.criteria]));
}

/** The value question that belongs to one typeable target. */
function valueKey(index: string): string {
  return `type_text_value_${index}`;
}

function targetQuestion(operation: ElementOperation, targets: Map<string, Target>): Question {
  return { type: "choice", criteria: criteriaOf(targets), instructions: { operation, rules: [NEXT_ACTION, TARGET] } };
}

export interface DecideInput {
  jev: Jev;
  model: string;
  goal: string;
  spans: string[];
  observation: Observation;
  /** The whole page as Jev reads it: the interactive tree leaves out the alerts and messages that show an outcome. */
  content: string;
  recent: Recent[];
  allow: Allow;
}

/**
 * One System One request per step. It picks the operation, a target for every operation that has one,
 * the span of the goal that belongs in each field it may type into, whether clicking is irreversible, and
 * whether the page shows the goal's outcome, which a DONE needs.
 * The speculative answers for the operations and fields Jev did not pick are never read.
 */
export async function decide(input: DecideInput): Promise<Decision> {
  const { jev, goal, observation, spans, allow } = input;
  const byOperation = new Map<ElementOperation, Map<string, Target>>();
  for (const operation of ["CLICK", "TYPE_TEXT", "SELECT"] as const) {
    const targets = targetsFor(observation.elements, operation);
    if (targets.size > 0) byOperation.set(operation, targets);
  }
  if (spans.length === 0) byOperation.delete("TYPE_TEXT");

  const offered = [...byOperation.keys(), "SCROLL_UP", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"];
  const operations = Object.fromEntries(offered.map((key) => [key, OPERATION_LABELS[key]]));

  const questions: Record<string, Question> = {
    operation: { type: "choice", criteria: operations, instructions: { rules: NEXT_ACTION } },
    goal_outcome_visible: {
      type: "noul",
      instructions: { rules: OUTCOME },
      criteria: { true: "The page shows the goal's outcome.", false: "The page does not show it yet." },
    },
  };
  for (const [operation, targets] of byOperation) {
    questions[`${operation.toLowerCase()}_target`] = targetQuestion(operation, targets);
  }
  const valueCriteria: Criteria = {
    ...Object.fromEntries(spans.map((span) => [span, null])),
    [NO_VALUE]: "No span of the goal belongs in that field.",
  };
  for (const [index, target] of byOperation.get("TYPE_TEXT") ?? []) {
    questions[valueKey(index)] = {
      type: "choice",
      criteria: valueCriteria,
      instructions: { field: target.criteria, rules: VALUE },
    };
  }
  const gated = allow !== "all" && byOperation.has("CLICK");
  if (gated) {
    questions.action_is_destructive = {
      type: "noul",
      instructions: { rules: DESTRUCTIVE },
      criteria: { true: "The control makes an irreversible change.", false: "The control is safe to try." },
    };
    questions.destructive_verb = { type: "choice", criteria: { ...VERBS }, instructions: { rules: DESTRUCTIVE_VERB } };
  }

  const request: Request = {
    model: input.model,
    state: {
      goal,
      page: { url: observation.url, title: observation.title, text: input.content },
      elements: observation.elements,
      recent_actions: input.recent.slice(-10),
    },
    questions,
  };

  const started = Date.now();
  const reply = await jev.ask(request);
  const latencyMs = Date.now() - started;

  const answer = choiceOf(reply.answers, "operation", Object.keys(operations));
  const operation = answer.choice as Operation;
  const targets = byOperation.get(operation as ElementOperation);
  const decision: Decision = {
    operation,
    target: null,
    ref: null,
    label: null,
    value: null,
    valueProbability: null,
    valueProbabilities: {},
    password: false,
    destructive: null,
    outcome: operation === "DONE" ? noulOf(reply.answers, "goal_outcome_visible") : null,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    targetProbabilities: {},
    model: reply.model,
    usage: { ...reply.usage } as Record<string, number>,
    latencyMs,
  };

  if (targets !== undefined) {
    const picked = choiceOf(reply.answers, `${operation.toLowerCase()}_target`, targets.keys());
    const target = targets.get(picked.choice) as Target;
    decision.target = picked.choice;
    decision.targetProbabilities = picked.probabilities;
    decision.ref = target.element.ref;
    decision.label = target.element.label;
    decision.password = target.element.password === true;
    if (target.option !== undefined) decision.value = target.option.value;
    if (operation === "TYPE_TEXT") {
      const value = choiceOf(reply.answers, valueKey(picked.choice), [...spans, NO_VALUE]);
      decision.valueProbability = value.probabilities[value.choice];
      decision.valueProbabilities = value.probabilities;
      decision.value = value.choice === NO_VALUE ? null : value.choice;
    }
  }

  if (operation === "CLICK" && gated) {
    const probability = noulOf(reply.answers, "action_is_destructive");
    const verb = probability > THRESHOLD ? choiceOf(reply.answers, "destructive_verb", Object.keys(VERBS)) : null;
    decision.destructive = { probability, verb: verb === null ? null : verb.choice };
  }

  return decision;
}
