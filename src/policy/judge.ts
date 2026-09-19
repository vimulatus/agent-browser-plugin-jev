import type { Observation } from "../observe.js";
import type { Element } from "../snapshot.js";
import type { Finding } from "./apply.js";
import { factsByScope, pageFacts, type Facts, type Gathered, type RequestFact } from "./facts.js";
import type { Answer, Entry, Jev, Question } from "./jev.js";
import type { Judgment, Over, Policy, Scope } from "./load.js";
import { lookup } from "./path.js";
import { pathsOf, render, type Template } from "./template.js";

/** One Jev answer about one item, as written to inferred.jsonl. */
export type Inference = {
  question: string;
  over: Over;
  index: number;
  item: Record<string, unknown>;
} & (
  | { type: "choice"; answer: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; answer: number }
);

/** A question that fans out over what the browser saw, rather than over the findings the rules made. */
type Fanned = Judgment & { over: Scope };

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
  gathered: Gathered,
  jev: Jev,
): Promise<Inference[]> {
  const judgments = policy.judgments.filter((judgment): judgment is Fanned => judgment.over !== "finding");
  if (judgments.length === 0) return [];

  const page = pageItem(observation, gathered);
  const facts = factsByScope(observation, gathered);
  const [pageFact] = facts.page;
  const items: Record<Scope, Record<string, unknown>[]> = {
    page: [page],
    request: pageFact.requests.map(requestItem),
    element: pageFact.elements.map(elementItem),
  };

  const questions: Record<string, Question> = {};
  const asked: { judgment: Fanned; index: number }[] = [];
  for (const judgment of judgments) {
    items[judgment.over].forEach((_item, index) => {
      const itemFacts = facts[judgment.over][index];
      if (!answerable(judgment.instructions, itemFacts)) return;
      questions[questionId(judgment, index)] = ask(judgment, index, itemFacts);
      asked.push({ judgment, index });
    });
  }
  if (asked.length === 0) return [];

  const state: Record<string, unknown> = { page };
  for (const { judgment } of asked) if (judgment.over !== "page") state[`${judgment.over}s`] = items[judgment.over];

  const answers = await jev.ask(state as Entry, questions);
  return asked.map(({ judgment, index }) => {
    const id = questionId(judgment, index);
    const item = items[judgment.over][index];
    return { question: judgment.name, over: judgment.over, index, item, ...read(judgment, answers[id], id) };
  });
}

/**
 * The second pass: what each finding of this step costs the user, one question per finding.
 * A policy that does not judge `severity` keeps the severity its rules wrote and asks nothing.
 */
export async function judgeFindings(
  policy: Policy,
  observation: Observation,
  gathered: Gathered,
  findings: Finding[],
  jev: Jev,
): Promise<{ findings: Finding[]; inferences: Inference[] }> {
  const judgment = policy.judgments.find((candidate) => candidate.over === "finding");
  if (judgment === undefined || findings.length === 0) return { findings, inferences: [] };

  const items = findings.map((finding) => ({ title: finding.title, evidence: finding.evidence }));
  const facts = pageFacts(observation, gathered);
  const state = { page: pageItem(observation, gathered), findings: items };
  const questions = Object.fromEntries(
    items.map((_item, index) => [questionId(judgment, index), ask(judgment, index, facts)]),
  );

  const answers = await jev.ask(state as Entry, questions);
  const inferences = items.map((item, index): Inference => {
    const id = questionId(judgment, index);
    return { question: judgment.name, over: "finding", index, item, ...read(judgment, answers[id], id) };
  });
  return {
    findings: findings.map((finding, index) => ({ ...finding, severity: String(inferences[index].answer) })),
    inferences,
  };
}

/** Each question names the item it is about by its path in the state, so the item is sent once. */
function ask(judgment: Judgment, index: number, facts: Facts): Question {
  const subject = judgment.over === "page" ? "`page`" : `\`${judgment.over}s[${index}]\``;
  const instructions = { question: render(judgment.instructions, facts), subject };
  return judgment.type === "choice"
    ? { type: "choice", instructions, criteria: judgment.criteria! }
    : { type: "noul", instructions };
}

/** A question is put only when everything it names has a value: nothing names the action before the walk acts. */
function answerable(instructions: Template, facts: Facts): boolean {
  return pathsOf(instructions).every((path) => lookup(facts, path) !== undefined);
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

/** What Jev sees of the page. With `content` collected it reads the whole page, not only what it can act on. */
function pageItem(observation: Observation, gathered: Gathered): Record<string, unknown> {
  return { url: observation.url, title: observation.title, text: gathered.content ?? observation.text };
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
