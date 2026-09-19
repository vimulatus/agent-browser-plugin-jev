import type { Observation } from "../observe.js";
import { evaluate } from "./expression.js";
import { pageFacts, type Facts } from "./facts.js";
import type { Policy, Scope } from "./load.js";
import { lookup } from "./path.js";
import { bucketOf } from "./range.js";
import { render } from "./template.js";

/** One report rule that fired: its rendered title, its severity and the fact it fired on. */
export interface Finding {
  title: string;
  severity: string;
  evidence: Record<string, unknown>;
}

/** Runs every rule of the policy over one observation. Pure: no browser, no Jev. */
export function applyPolicy(policy: Policy, observation: Observation): Finding[] {
  const page = pageFacts(observation);
  const scopes: Record<Scope, Facts[]> = {
    page: [measured(policy, page, "page")],
    request: page.requests.map((request) => measured(policy, { ...page, request }, "request")),
  };
  return policy.rules.flatMap((rule) =>
    scopes[rule.scope]
      .filter((facts) => evaluate(rule.when, facts))
      .map((facts) => ({
        title: render(rule.title, facts),
        severity: rule.severity,
        evidence: { [rule.evidence.key]: lookup(facts, rule.evidence.path) },
      })),
  );
}

function measured(policy: Policy, facts: Facts, scope: Scope): Facts {
  for (const [name, measure] of Object.entries(policy.measures)) {
    if (measure.scope === scope) facts[name] = bucketOf(measure.buckets, measure.read(facts));
  }
  return facts;
}
