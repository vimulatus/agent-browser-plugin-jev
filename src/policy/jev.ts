import { fetch } from "../http.js";

/** Text, or the JSON structure TypeSafe calls an entry: state, instructions and criteria all take one. */
export type Entry = string | { [key: string]: unknown } | unknown[];

export type Question =
  | { type: "choice"; instructions: Entry; criteria: Record<string, Entry> }
  | { type: "noul"; instructions: Entry };

/** One answer, keyed in the reply by the id its question had in the request. */
export type Answer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number };

/** Many questions over one state, answered in parallel by one request. */
export interface Jev {
  ask(state: Entry, questions: Record<string, Question>): Promise<Record<string, Answer>>;
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const ATTEMPTS = 3;
const TIMEOUT = 25_000;
const RETRY_STATUS = new Set([429, 503, 529]);

/** Jev over the TypeSafe System One API. `TYPESAFE_API_KEY` is read for the call and never stored. */
export function typesafeJev(model = MODEL): Jev {
  return {
    async ask(state, questions) {
      const apiKey = process.env.TYPESAFE_API_KEY;
      if (!apiKey) throw new Error("a policy with a judge section needs TYPESAFE_API_KEY in the environment");
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, state, questions }),
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (RETRY_STATUS.has(response.status) && attempt < ATTEMPTS - 1) {
          await new Promise((done) => setTimeout(done, 500 * 2 ** attempt));
          continue;
        }
        if (!response.ok) throw new Error(`jev: HTTP ${response.status} ${await response.text()}`);
        const { answers } = (await response.json()) as { answers: Record<string, Answer> };
        return answers;
      }
    },
  };
}
