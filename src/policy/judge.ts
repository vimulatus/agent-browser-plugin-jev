import type { Observation } from "../observe.js";
import type { Element } from "../snapshot.js";
import { pageFacts, type RequestFact } from "./facts.js";
import type { Answer, Entry, Jev, Question } from "./jev.js";
import type { Judgment, Policy, Scope } from "./load.js";

/** One Jev answer about one item, as written to inferred.jsonl. */
export type Inference = {
  question: string;
  over: Scope;
  index: number;
  item: Record<string, unknown>;
} & (
  | { type: "choice"; answer: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; answer: number }
);

/** The id a fanned-out question carries in the request, and its answer in the reply. */
export function questionId(judgment: Judgment, index: number): string {
  return judgment.over === "page" ? judgment.name : `${judgment.name}#${index}`;
}

/**
 * Puts every question of the judge section to Jev in one request, one question per item of its `over`,
 * and returns one inference per answer. A policy with no judge section asks nothing.
 */
export async function judge(
  policy: Policy,
  observation: Observation,
  har: RequestFact[] | undefined,
  jev: Jev,
): Promise<Inference[]> {
  if (policy.judgments.length === 0) return [];

  const page = { url: observation.url, title: observation.title, text: observation.text };
  const items: Record<Scope, Record<string, unknown>[]> = {
    page: [page],
    request: pageFacts(observation, har).requests.map(requestItem),
    element: observation.elements.map(elementItem),
  };

  const state: Record<string, unknown> = { page };
  const questions: Record<string, Question> = {};
  for (const judgment of policy.judgments) {
    if (judgment.over !== "page") state[`${judgment.over}s`] = items[judgment.over];
    items[judgment.over].forEach((_item, index) => {
      questions[questionId(judgment, index)] = ask(judgment, index);
    });
  }

  const answers = await jev.ask(state as Entry, questions);
  return policy.judgments.flatMap((judgment) =>
    items[judgment.over].map((item, index) => {
      const id = questionId(judgment, index);
      return { question: judgment.name, over: judgment.over, index, item, ...read(judgment, answers[id], id) };
    }),
  );
}

/** Each question names the item it is about by its path in the state, so the item is sent once. */
function ask(judgment: Judgment, index: number): Question {
  const subject = judgment.over === "page" ? "`page`" : `\`${judgment.over}s[${index}]\``;
  const instructions = { question: judgment.instructions, subject };
  return judgment.type === "choice"
    ? { type: "choice", instructions, criteria: judgment.criteria! }
    : { type: "noul", instructions };
}

function read(judgment: Judgment, answer: Answer | undefined, id: string) {
  if (answer === undefined) throw new Error(`jev: no answer for "${id}"`);
  if (answer.type !== judgment.type) throw new Error(`jev: "${id}" answered ${answer.type}, not ${judgment.type}`);
  if (answer.type === "noul") return { type: "noul" as const, answer: answer.noul };
  if (!(answer.choice in judgment.criteria!)) {
    throw new Error(`jev: "${id}" chose "${answer.choice}", which is not one of its criteria`);
  }
  return {
    type: "choice" as const,
    answer: answer.choice,
    probabilities: answer.probabilities,
    confidence: answer.confidence,
  };
}

/** What Jev sees of a request: what it asked for, not how long it took. Code measures the numbers. */
function requestItem(request: RequestFact): Record<string, unknown> {
  const { method, url, resourceType, mimeType } = request;
  return { method, url, resourceType, mimeType };
}

function elementItem(element: Element): Record<string, unknown> {
  const { index, role, label, value } = element;
  return { index, role, label, value };
}
