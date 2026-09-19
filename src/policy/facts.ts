import type { ConsoleMessage, Observation, PageError, Request } from "../observe.js";
import type { Element } from "../snapshot.js";

/** One request as a policy reads it. `time` is its duration in ms, and only a HAR carries it. */
export interface RequestFact extends Request {
  path: string;
  time?: number | null;
}

/** What a policy's `when` and `title` read. `request` and `element` are set while a rule runs over one item. */
export interface Facts {
  page: { url: string; title: string };
  console: { messages: ConsoleMessage[]; errors: ConsoleMessage[]; warnings: ConsoleMessage[] };
  errors: PageError[];
  requests: RequestFact[];
  elements: Element[];
  request?: RequestFact;
  element?: Element;
  [judged: string]: unknown;
}

/** The facts of the whole page. A recorded HAR replaces the request log: it covers the window and carries latency. */
export function pageFacts(observation: Observation, har?: RequestFact[]): Facts {
  return {
    page: { url: observation.url, title: observation.title },
    console: {
      messages: observation.console,
      errors: observation.console.filter((m) => m.type === "error"),
      warnings: observation.console.filter((m) => m.type === "warning"),
    },
    errors: observation.errors,
    requests: har ?? observation.requests.map((request) => ({ ...request, path: new URL(request.url).pathname })),
    elements: observation.elements,
  };
}
