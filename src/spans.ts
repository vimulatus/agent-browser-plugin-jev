/** The answer that means no span in the goal belongs in the field. */
export const NO_VALUE = "NONE";

export const MAX_SPANS = 40;
export const MAX_SPAN_LENGTH = 200;

/** The word that introduces a value: "log in **as** alice@example.com". */
const LEAD = new Set(["as", "with", "to", "for", "into", "using", "named", "called", "titled"]);
/** The word that ends one: "with password secret **and** open Settings". */
const STOP = new Set(["and", "then", "but", "or", "so", ...LEAD]);

const QUOTED = /"([^"]+)"|'([^']+)'|[“]([^”]+)[”]/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+\w/g;
const NUMBER = /\b\d[\d,.]*\d\b|\b\d\b/g;

function words(goal: string): string[] {
  return goal.split(/\s+/).filter(Boolean);
}

function bare(word: string): string {
  return word.replace(/^["'(\[]+/, "").replace(/[."',:;!?)\]]+$/, "");
}

/** The words a lead word introduces, up to the next stop word. */
function phrases(goal: string): string[] {
  const found: string[] = [];
  const tokens = words(goal);
  for (let i = 0; i < tokens.length; i++) {
    if (!LEAD.has(bare(tokens[i]).toLowerCase())) continue;
    const run: string[] = [];
    for (let j = i + 1; j < tokens.length && !STOP.has(bare(tokens[j]).toLowerCase()); j++) {
      const token = bare(tokens[j]);
      if (token !== "") run.push(token);
    }
    if (run.length > 1) found.push(run.join(" "));
    found.push(...run);
  }
  return found;
}

function matches(goal: string, pattern: RegExp): string[] {
  return [...goal.matchAll(pattern)].map((m) => m.slice(1).find((g) => g !== undefined) ?? m[0]);
}

/**
 * Every value the goal could put in a field, widest first. Jev picks one and writes no text,
 * so a value that is not in this list cannot be typed.
 */
export function valueSpans(goal: string): string[] {
  const candidates = [
    ...matches(goal, QUOTED),
    ...matches(goal, EMAIL),
    ...phrases(goal),
    ...matches(goal, NUMBER),
  ];
  const spans: string[] = [];
  for (const candidate of candidates) {
    const span = candidate.trim();
    if (span === "" || span === NO_VALUE || span.length > MAX_SPAN_LENGTH) continue;
    if (!spans.includes(span)) spans.push(span);
    if (spans.length === MAX_SPANS) break;
  }
  return spans;
}

function within(outer: string[], inner: string[]): boolean {
  for (let start = 0; start + inner.length <= outer.length; start++) {
    if (inner.every((word, i) => outer[start + i] === word)) return true;
  }
  return false;
}

/**
 * Jev's answer to a value question, with spans that overlap counted as one value: the span Jev scored highest
 * takes the mass of every span whose words contain its words or sit inside them, so "one-time code 123456" and
 * "123456" cannot split the vote under the threshold. Jev's own ranking picks the text typed, which keeps a spaced
 * value like "Anna Smith" whole. The value is null when NONE outscores that merged mass.
 */
export function valueVote(probabilities: Record<string, number>): { value: string | null; probability: number } {
  const none = probabilities[NO_VALUE];
  const spans = Object.keys(probabilities).filter((span) => span !== NO_VALUE);
  const top = spans.reduce((best, span) => (probabilities[span] > probabilities[best] ? span : best));
  const topWords = words(top);
  const merged = spans
    .filter((span) => within(words(span), topWords) || within(topWords, words(span)))
    .reduce((sum, span) => sum + probabilities[span], 0);
  return merged > none ? { value: top, probability: merged } : { value: null, probability: none };
}
