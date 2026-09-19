import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commandFor } from "./act.js";
import { agentBrowser, type AgentBrowser } from "./agent-browser.js";
import { chooseNext, type Chosen } from "./choose.js";
import { THRESHOLD, type Allow, type Recent } from "./decide.js";
import { findingAt, sameAs, type WalkFinding } from "./findings.js";
import { loadFixtures } from "./fixtures.js";
import { frontier, type Entry } from "./frontier.js";
import { httpJev, type Jev } from "./jev.js";
import { observe, snapshotHash, type Observation } from "./observe.js";
import {
  applyPolicy,
  judge,
  judgeFindings,
  loadPolicy,
  readContent,
  typesafeJev,
  type Gathered,
  type Jev as PolicyJev,
  type Previous,
} from "./policy/index.js";
import { MASK, type RunOptions, type RunStatus } from "./run.js";
import type { Operation } from "./snapshot.js";

/** A walk is a run with a policy and no goal. */
export type WalkOptions = RunOptions & { policy: string };

/** One step of the walk, as written to `steps.jsonl`: the control it took and what came of it. */
export interface WalkStep {
  step: number;
  url: string;
  hash: string;
  kind: Operation;
  label: string;
  ref: string;
  value: string | null;
  fixture: string | null;
  executed: boolean;
  reason: string | null;
  confidence: number | null;
  probabilities: Record<string, number>;
  destructive: Chosen["destructive"];
  latencyMs: number;
  usage: Record<string, number>;
  model: string;
}

export interface WalkResult {
  status: "done";
  url: string;
  steps: number;
  actions: number;
  findings: number;
  out: string;
  record: string | null;
  reason: string;
}

/** What the walk drives: the browser, Jev for its own questions, and Jev for the policy's. */
export interface WalkDeps {
  browser: AgentBrowser;
  jev: Jev;
  policyJev: PolicyJev;
}

export function defaultWalkDeps(options: WalkOptions): WalkDeps {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (apiKey === undefined || apiKey === "") throw new Error("TYPESAFE_API_KEY is not set");
  return {
    browser: agentBrowser(options.session, options.human),
    jev: httpJev(apiKey),
    policyJev: typesafeJev(options.model),
  };
}

function denied(chosen: Chosen, allow: Allow): string | null {
  const gate = chosen.destructive;
  if (gate === null || gate.probability <= THRESHOLD) return null;
  const verb = gate.verb ?? "change";
  if (allow !== "all" && !allow.has(verb)) return `${verb} is destructive and not in --allow`;
  return null;
}

/** The actions the walk took before this step, oldest first. A finding is reproduced by replaying them. */
export function actionsBefore(out: string, step: number, count = 3): WalkStep[] {
  const path = join(out, "steps.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WalkStep)
    .filter((taken) => taken.executed && taken.step < step)
    .slice(-count);
}

/**
 * Walks the app from the start page, trying every control it finds once. Every step applies the policy and
 * appends what it found to `findings.json`, deduped against the findings before it. The walk never leaves the
 * origin it started on, and stops when the frontier or `--max-steps` runs out.
 */
export async function walk(options: WalkOptions, injected?: WalkDeps): Promise<WalkResult> {
  const policy = loadPolicy(options.policy);
  if (policy.collect.includes("har")) {
    throw new Error(
      `policy ${options.policy}: a HAR is recorded over a reload, which a walk cannot do; judge one page with --max-steps 0`,
    );
  }
  const fixtures = loadFixtures(options.fixtures);
  const seen = frontier();
  const findings: WalkFinding[] = [];
  const unfilled: { label: string; url: string }[] = [];
  const recent: Recent[] = [];
  const startedAt = new Date().toISOString();
  let observation: Observation | null = null;
  let steps = 0;
  let actions = 0;
  let reason = `reached --max-steps ${options.maxSteps}`;

  await mkdir(options.out, { recursive: true });
  const write = async (name: string, value: unknown) => {
    const path = join(options.out, name);
    await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
    await rename(`${path}.tmp`, path);
  };
  const save = async (state: RunStatus) => {
    await write("frontier.json", seen.entries());
    await write("findings.json", findings);
    await write("unfilled.json", unfilled);
    await write("status.json", {
      status: state,
      goal: null,
      policy: options.policy,
      url: observation?.url ?? null,
      steps,
      actions,
      findings: findings.length,
      unfilled: unfilled.length,
      out: options.out,
      record: options.record ?? null,
      model: options.model,
      reason,
      startedAt,
      updatedAt: new Date().toISOString(),
    });
  };
  await save("running");

  let browser: AgentBrowser | null = null;
  let recording = false;
  try {
    const deps = injected ?? defaultWalkDeps(options);
    browser = deps.browser;
    if (options.url !== undefined) await browser.run(["open", options.url]);
    if (options.record !== undefined) {
      await browser.run(["record", "start", options.record, "--cursor"]);
      recording = true;
    }

    /** The policy over the page in front of the walk: judge it, apply the rules, keep what is not already reported. */
    const inspect = async (page: Observation, previous: Previous | undefined, step: number) => {
      const gathered: Gathered = {
        previous,
        content: policy.collect.includes("content") ? await readContent(deps.browser) : undefined,
      };
      const inferences = await judge(policy, page, gathered, deps.policyJev);
      const applied = applyPolicy(policy, page, { ...gathered, inferences });
      const judged = await judgeFindings(policy, page, gathered, applied, deps.policyJev);
      const answered = [...inferences, ...judged.inferences];
      if (answered.length > 0) {
        await appendFile(
          join(options.out, "inferred.jsonl"),
          `${answered.map((inference) => JSON.stringify(inference)).join("\n")}\n`,
        );
      }
      for (const finding of judged.findings) {
        const candidate = findingAt(finding, page.url, step);
        const repeats = await sameAs(deps.jev, options.model, candidate, findings);
        if (repeats === null) findings.push(candidate);
        else findings[repeats].repeats.push({ step: candidate.step, where: candidate.where });
      }
    };

    let home = options.url ?? null;
    let origin = home === null ? null : new URL(home).origin;
    let previous: Previous | undefined;
    let acted: { recent: Recent; hash: string } | null = null;
    let jumped: Entry | null = null;

    while (steps < options.maxSteps) {
      observation = await observe(browser);
      if (origin === null) {
        home = observation.url;
        origin = new URL(observation.url).origin;
      }
      if (new URL(observation.url).origin !== origin) {
        await browser.run(["open", home as string]);
        previous = undefined;
        observation = await observe(browser);
      }
      if (acted !== null) {
        acted.recent.pageChanged = observation.hash !== acted.hash;
        acted = null;
      }
      await appendFile(
        join(options.out, "observed.jsonl"),
        `${JSON.stringify({ step: steps + 1, ...observation })}\n`,
      );

      await inspect(observation, previous, steps + 1);
      previous = undefined;

      seen.see(observation.url, observation.elements);
      const untried = seen.here(observation.url, observation.elements);
      if (untried.length === 0) {
        if (jumped !== null) jumped.tried = true;
        const next = seen.pending();
        if (next === null) {
          reason = "every control the walk found has been tried";
          break;
        }
        jumped = next;
        await save("running");
        await browser.run(["open", next.url]);
        continue;
      }
      jumped = null;

      const chosen = await chooseNext({
        jev: deps.jev,
        model: options.model,
        observation,
        untried,
        fixtures,
        allow: options.allow,
        recent,
      });
      steps++;
      const masked = chosen.element.password === true && chosen.value !== null ? MASK : chosen.value;
      const step: WalkStep = {
        step: steps,
        url: observation.url,
        hash: observation.hash,
        kind: chosen.operation,
        label: chosen.element.label,
        ref: chosen.ref,
        value: masked,
        fixture: chosen.fixture,
        executed: false,
        reason: null,
        confidence: chosen.confidence,
        probabilities: chosen.probabilities,
        destructive: chosen.destructive,
        latencyMs: chosen.latencyMs,
        usage: chosen.usage,
        model: chosen.model,
      };
      const record = async () => {
        await appendFile(join(options.out, "steps.jsonl"), `${JSON.stringify(step)}\n`);
        await save("running");
      };

      const deny = denied(chosen, options.allow);
      if (deny !== null) {
        chosen.entry.tried = true;
        step.reason = deny;
        await record();
        continue;
      }
      if (chosen.operation === "TYPE_TEXT" && chosen.value === null) {
        chosen.entry.tried = true;
        step.reason = `no fixture value belongs in ${chosen.element.label}`;
        unfilled.push({ label: chosen.element.label, url: observation.url });
        await record();
        continue;
      }
      if ((await snapshotHash(browser)) !== observation.hash) {
        step.reason = "the page changed between the decision and the act";
        await record();
        continue;
      }

      const command = commandFor(chosen, options.human) as string[];
      try {
        await browser.run(command);
      } catch (error) {
        reason = step.reason = `${command[0]} failed: ${(error as Error).message}`;
        await record();
        break;
      }
      chosen.entry.tried = true;
      step.executed = true;
      actions++;
      previous = { hash: observation.hash, action: { kind: chosen.operation, label: chosen.element.label } };
      acted = {
        recent: { operation: chosen.operation, target: chosen.element.label, value: masked, pageChanged: null },
        hash: observation.hash,
      };
      recent.push(acted.recent);
      await record();
    }

    if (recording) {
      await browser.run(["record", "stop"]);
      recording = false;
    }
    observation ??= await observe(browser);
    await save("done");
    return {
      status: "done",
      url: observation.url,
      steps,
      actions,
      findings: findings.length,
      out: options.out,
      record: options.record ?? null,
      reason,
    };
  } catch (error) {
    reason = (error as Error).message;
    if (recording && browser !== null) await browser.run(["record", "stop"]).catch(() => {});
    await save("failed");
    throw error;
  }
}
