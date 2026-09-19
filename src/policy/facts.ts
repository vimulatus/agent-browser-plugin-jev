import type { ConsoleMessage, Observation, PageError, Request } from "../observe.js";

export interface RequestFact extends Request {
  path: string;
}

/** What a policy's `when` and `title` read. `request` is set while a rule runs over one request. */
export interface Facts {
  page: { url: string; title: string };
  console: { messages: ConsoleMessage[]; errors: ConsoleMessage[]; warnings: ConsoleMessage[] };
  errors: PageError[];
  requests: RequestFact[];
  request?: RequestFact;
  [measure: string]: unknown;
}

export function pageFacts(observation: Observation): Facts {
  return {
    page: { url: observation.url, title: observation.title },
    console: {
      messages: observation.console,
      errors: observation.console.filter((m) => m.type === "error"),
      warnings: observation.console.filter((m) => m.type === "warning"),
    },
    errors: observation.errors,
    requests: observation.requests.map((request) => ({ ...request, path: new URL(request.url).pathname })),
  };
}
