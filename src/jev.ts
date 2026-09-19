export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";

export type Criteria = Record<string, unknown>;

export type Question =
  | { type: "choice"; instructions: unknown; criteria: Criteria }
  | { type: "noul"; instructions: unknown; criteria?: Criteria };

export interface Request {
  model: string;
  state: unknown;
  questions: Record<string, Question>;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface Reply {
  model: string;
  answers: Record<string, ChoiceAnswer | NoulAnswer | undefined>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** One System One request. The HTTP call, the key and the retries live behind this. */
export interface Jev {
  ask(request: Request): Promise<Reply>;
}

const RETRY = new Set([429, 503, 529]);
const ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Binds TypeSafe's System One endpoint to one API key. Nothing has acted when this throws. */
export function httpJev(apiKey: string, endpoint = ENDPOINT): Jev {
  return {
    async ask(request) {
      for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(request),
          });
        } catch (cause) {
          throw new Error("jev: connection failed, nothing acted", { cause });
        }
        if (RETRY.has(response.status) && attempt < ATTEMPTS - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        if (!response.ok) throw new Error(`jev: HTTP ${response.status}, nothing acted`);
        return (await response.json()) as Reply;
      }
    },
  };
}

function probability(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function faultIn(answer: ChoiceAnswer, ids: Set<string>): string | null {
  const { choice, probabilities, confidence } = answer;
  if (probabilities === null || typeof probabilities !== "object") return "has no probabilities";
  const keys = Object.keys(probabilities);
  const mass = Object.values(probabilities);
  if (!ids.has(choice)) return `chose ${choice}, which was not offered`;
  if (keys.length !== ids.size || !keys.every((id) => ids.has(id))) return "has probabilities over other options";
  if (![...mass, confidence].every(probability)) return "has a number outside 0..1";
  if (Math.abs(mass.reduce((sum, n) => sum + n, 0) - 1) >= 0.02) return "has probabilities that do not sum to 1";
  if (probabilities[choice] < Math.max(...mass) - 1e-6) return "did not choose its most likely option";
  return null;
}

/** The strict read of a Choice answer: the pick is offered, is the argmax, and the mass sums to 1. */
export function choiceOf(answers: Reply["answers"], key: string, offered: Iterable<string>): ChoiceAnswer {
  const answer = answers[key];
  if (answer?.type !== "choice") throw new Error(`jev: ${key} is not a choice answer, nothing acted`);
  const fault = faultIn(answer, new Set(offered));
  if (fault !== null) throw new Error(`jev: ${key} ${fault}, nothing acted`);
  return answer;
}

/** The strict read of a Noul answer: one probability in 0..1. */
export function noulOf(answers: Reply["answers"], key: string): number {
  const answer = answers[key];
  const value = answer?.type === "noul" ? answer.noul : undefined;
  if (!probability(value)) throw new Error(`jev: ${key} is not a probability, nothing acted`);
  return value as number;
}
