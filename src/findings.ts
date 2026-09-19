import { noulOf, type Jev, type Question } from "./jev.js";
import type { Finding } from "./policy/index.js";
import { SAME_FINDING } from "./questions.js";
import type { Reproduction } from "./repro.js";

/** Above this, a new finding is the one already reported, seen again. */
export const SAME = 0.8;

/** One finding of a walk: what the policy saw, where it saw it, every later step that saw it again, and its replay. */
export interface WalkFinding extends Partial<Reproduction> {
  title: string;
  severity: string | null;
  where: string;
  step: number;
  evidence: Record<string, unknown>;
  repeats: { step: number; where: string }[];
}

/** The findings of a walk in the order they were raised, and the list an agent reads first. */
export interface Findings {
  findings: WalkFinding[];
  summary: { title: string; severity: string | null; where: string }[];
}

export function summarize(findings: WalkFinding[]): Findings {
  return {
    findings,
    summary: findings.map(({ title, severity, where }) => ({ title, severity, where })),
  };
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
