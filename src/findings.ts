import { noulOf, type Jev, type Question } from "./jev.js";
import type { Finding } from "./policy/index.js";
import { SAME_FINDING } from "./questions.js";

/** Above this, a new finding is the one already reported, seen again. */
export const SAME = 0.8;

/** One finding of a walk: what the policy saw, where it saw it, and every later step that saw it again. */
export interface WalkFinding {
  title: string;
  severity: string | null;
  where: string;
  step: number;
  evidence: Record<string, unknown>;
  repeats: { step: number; where: string }[];
}

export function findingAt(finding: Finding, where: string, step: number): WalkFinding {
  return {
    title: finding.title,
    severity: finding.severity ?? null,
    where,
    step,
    evidence: finding.evidence,
    repeats: [],
  };
}

function item(finding: WalkFinding): Record<string, unknown> {
  return { title: finding.title, where: finding.where, evidence: finding.evidence };
}

/**
 * The finding this one repeats, or null when it is new. One request per candidate, a Noul against every
 * finding so far, so a walk that meets the same broken control on ten pages reports it once with ten repeats.
 */
export async function sameAs(
  jev: Jev,
  model: string,
  candidate: WalkFinding,
  findings: WalkFinding[],
): Promise<number | null> {
  if (findings.length === 0) return null;
  const questions: Record<string, Question> = Object.fromEntries(
    findings.map((_finding, k) => [
      `same_as_finding_${k}`,
      { type: "noul", instructions: { rules: SAME_FINDING, against: `\`findings[${k}]\`` } } as Question,
    ]),
  );
  const reply = await jev.ask({
    model,
    state: { finding: item(candidate), findings: findings.map(item) },
    questions,
  });

  let match: number | null = null;
  let best = SAME;
  findings.forEach((_finding, k) => {
    const probability = noulOf(reply.answers, `same_as_finding_${k}`);
    if (probability > best) {
      best = probability;
      match = k;
    }
  });
  return match;
}
