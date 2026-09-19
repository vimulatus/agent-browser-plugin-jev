import type { ConsoleMessage, Observation, PageError, Request } from "../observe.js";
import type { Element, Operation } from "../snapshot.js";
import type { Inference } from "./judge.js";
import type { Scope } from "./load.js";

/** One request as a policy reads it. `time` is its duration in ms, and only a HAR carries it. */
export interface RequestFact extends Request {
  path: string;
  time?: number | null;
}

/** The page the walk acted on, and what it did there. It carries from one step to the next. */
export interface Previous {
  hash: string;
  action: { kind: Operation; label: string };
}

/** The action that led to this page, with the hash of the page it was taken on. */
export interface ActionFact {
  kind: Operation;
  label: string;
  before: string;
}

/** What a run gathered around one observation: the HAR and the page text it recorded, the step before, the answers Jev gave. */
export interface Gathered {
  har?: RequestFact[];
  content?: string;
  previous?: Previous;
  inferences?: Inference[];
}

/** What a policy's `when` and `title` read. `request` and `element` are set while a rule runs over one item. */
export interface Facts {
  page: { url: string; title: string; path: string; hash: string };
  console: { messages: ConsoleMessage[]; errors: ConsoleMessage[]; warnings: ConsoleMessage[] };
  errors: PageError[];
  requests: RequestFact[];
  elements: Element[];
  action?: ActionFact;
  request?: RequestFact;
  element?: Element;
  [judged: string]: unknown;
}

/** The facts every rule and every question runs over: the page once, each request in turn, each element in turn. */
export function factsByScope(observation: Observation, gathered: Gathered = {}): Record<Scope, Facts[]> {
  const page = pageFacts(observation, gathered);
  return {
    page: [page],
    request: page.requests.map((request) => ({ ...page, request })),
    element: page.elements.map((element) => ({ ...page, element })),
  };
}

/** The facts of the whole page. A recorded HAR replaces the request log: it covers the window and carries latency. */
export function pageFacts(observation: Observation, { har, previous }: Gathered = {}): Facts {
  return {
    page: {
      url: observation.url,
      title: observation.title,
      path: new URL(observation.url).pathname,
      hash: observation.hash,
    },
    console: {
      messages: observation.console,
      errors: observation.console.filter((m) => m.type === "error"),
      warnings: observation.console.filter((m) => m.type === "warning"),
    },
    errors: observation.errors,
    requests: har ?? observation.requests.map((request) => ({ ...request, path: new URL(request.url).pathname })),
    elements: observation.elements,
    action: previous && { ...previous.action, before: previous.hash },
  };
}
