import { describe, THRESHOLD, type Allow, type Recent } from "./decide.js";
import type { Entry } from "./frontier.js";
import { choiceOf, noulOf, type Jev, type Question, type Request } from "./jev.js";
import type { Observation } from "./observe.js";
import { FIXTURE_VALUE, NEXT_ELEMENT, VERBS, WALK_DESTRUCTIVE, WALK_DESTRUCTIVE_VERB } from "./questions.js";
import type { Element, Operation } from "./snapshot.js";
import { NO_VALUE } from "./spans.js";

/** One untried control of the frontier, as it appears on the page in front of the walk. */
export interface Untried {
  element: Element;
  entry: Entry;
}

/** The control the walk takes next, what it types into it, and whether activating it is irreversible. */
export interface Chosen {
  entry: Entry;
  element: Element;
  operation: Operation;
  ref: string;
  value: string | null;
  fixture: string | null;
  destructive: { probability: number; verb: string | null } | null;
  probabilities: Record<string, number>;
  confidence: number | null;
  latencyMs: number;
  usage: Record<string, number>;
  model: string;
}

export interface ChooseInput {
  jev: Jev;
  model: string;
  observation: Observation;
  untried: Untried[];
  fixtures: Record<string, string>;
  allow: Allow;
  recent: Recent[];
}

/** What the walk does with a control: a field is filled, a dropdown is set, anything else is clicked. */
export function operationOf(element: Element): Operation {
  if (element.operations.includes("TYPE_TEXT")) return "TYPE_TEXT";
  if (element.operations.includes("SELECT")) return "SELECT";
  return "CLICK";
}

/** The dropdown value a walk tries: the first one the page has not already selected. */
function optionValue(element: Element): string | null {
  const options = element.options ?? [];
  return (options.find((option) => !option.selected) ?? options[0])?.value ?? null;
}

function fixtureQuestion(fixtures: Record<string, string>): Question {
  return {
    type: "choice",
    criteria: { ...fixtures, [NO_VALUE]: "No fixture value belongs in this field." },
    instructions: { rules: FIXTURE_VALUE },
  };
}

/**
 * One System One request per step of the walk: which untried control to take, which fixture value belongs in
 * every field it could fill, and whether activating the control is irreversible. The answers for the controls
 * Jev did not pick are never read. A page that leaves one untried control is not asked which one to take.
 */
export async function chooseNext(input: ChooseInput): Promise<Chosen> {
  const { jev, model, observation, untried, fixtures, allow } = input;
  const offered = untried.map(({ element }) => element.index);
  const fillable = untried.filter(({ element }) => operationOf(element) === "TYPE_TEXT");
  const activates = untried.some(({ element }) => operationOf(element) !== "TYPE_TEXT");

  const questions: Record<string, Question> = {};
  if (untried.length > 1) {
    questions.next_element = {
      type: "choice",
      criteria: Object.fromEntries(untried.map(({ element }) => [element.index, describe(element)])),
      instructions: { rules: NEXT_ELEMENT },
    };
  }
  for (const { element } of fillable) questions[`fixture_value_${element.index}`] = fixtureQuestion(fixtures);
  const gated = allow !== "all" && activates;
  if (gated) {
    questions.action_is_destructive = {
      type: "noul",
      instructions: { rules: WALK_DESTRUCTIVE },
      criteria: { true: "The control makes an irreversible change.", false: "The control is safe to try." },
    };
    questions.destructive_verb = { type: "choice", criteria: { ...VERBS }, instructions: { rules: WALK_DESTRUCTIVE_VERB } };
  }

  const request: Request = {
    model,
    state: {
      page: { url: observation.url, title: observation.title, text: observation.text },
      elements: observation.elements,
      untried: offered,
      recent_actions: input.recent.slice(-10),
    },
    questions,
  };

  const started = Date.now();
  const reply = Object.keys(questions).length === 0 ? null : await jev.ask(request);
  const latencyMs = reply === null ? 0 : Date.now() - started;
  const answers = reply?.answers ?? {};

  const picked = untried.length > 1 ? choiceOf(answers, "next_element", offered) : null;
  const taken = picked === null ? untried[0] : (untried.find(({ element }) => element.index === picked.choice) as Untried);
  const operation = operationOf(taken.element);

  const chosen: Chosen = {
    entry: taken.entry,
    element: taken.element,
    operation,
    ref: taken.element.ref,
    value: operation === "SELECT" ? optionValue(taken.element) : null,
    fixture: null,
    destructive: null,
    probabilities: picked?.probabilities ?? {},
    confidence: picked?.confidence ?? null,
    latencyMs,
    usage: { ...reply?.usage } as Record<string, number>,
    model: reply?.model ?? model,
  };

  if (operation === "TYPE_TEXT") {
    const value = choiceOf(answers, `fixture_value_${taken.element.index}`, [...Object.keys(fixtures), NO_VALUE]);
    const chose = value.choice !== NO_VALUE && value.probabilities[value.choice] > THRESHOLD;
    chosen.fixture = chose ? value.choice : null;
    chosen.value = chose ? fixtures[value.choice] : null;
  } else if (gated) {
    const probability = noulOf(answers, "action_is_destructive");
    const verb = probability > THRESHOLD ? choiceOf(answers, "destructive_verb", Object.keys(VERBS)) : null;
    chosen.destructive = { probability, verb: verb === null ? null : verb.choice };
  }

  return chosen;
}
