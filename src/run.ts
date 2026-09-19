import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandFor } from "./act.js";
import { agentBrowser, type AgentBrowser } from "./agent-browser.js";
import { decide, THRESHOLD, type Allow, type Decision, type Recent } from "./decide.js";
import { DEFAULT_MODEL, httpJev, type Jev } from "./jev.js";
import { observe, snapshotHash, type Observation } from "./observe.js";
import { valueSpans } from "./spans.js";

export const DEFAULT_MAX_STEPS = 60;
/** This many acts in a row that leave the page unchanged mean the run cannot progress. */
const STUCK = 3;
/** What a run logs in place of a value it typed into a field that hides what it holds. */
export const MASK = "•••";

export interface RunOptions {
  goal: string;
  session: string;
  url?: string;
  maxSteps: number;
  out: string;
  allow: Allow;
  model: string;
  record?: string;
  human: boolean;
  policy?: string;
  fixtures?: string;
}

/** What `<out>/status.json` reports while the run is in flight and once it has ended. */
export type RunStatus = "running" | "done" | "blocked" | "failed";

export interface RunResult {
  status: "done" | "blocked";
  url: string;
  steps: number;
  actions: number;
  snapshot: string;
  out: string;
  record: string | null;
  reason: string | null;
}

/** What the loop drives. Tests inject a scripted browser and recorded Jev replies. */
export interface Deps {
  browser: AgentBrowser;
  jev: Jev;
}

interface Step {
  step: number;
  hash: string;
  operation: string;
  target: string | null;
  label: string | null;
  value: string | null;
  executed: boolean;
  reason: string | null;
  pageChanged: boolean | null;
  confidence: number;
  probabilities: Record<string, number>;
  targetProbabilities: Record<string, number>;
  valueProbabilities: Record<string, number>;
  destructive: Decision["destructive"];
  latencyMs: number;
  usage: Record<string, number>;
  model: string;
}

/** A fresh directory under the OS temp dir, named in the result, for the run's artifacts. */
export function defaultOut(): string {
  return mkdtempSync(join(tmpdir(), "jev-run-"));
}

/** The real browser and the real model, from the session and `TYPESAFE_API_KEY`. */
export function defaultDeps(options: RunOptions): Deps {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (apiKey === undefined || apiKey === "") throw new Error("TYPESAFE_API_KEY is not set");
  return { browser: agentBrowser(options.session, options.human), jev: httpJev(apiKey) };
}

function stuck(history: Step[]): boolean {
  const last = history.slice(-STUCK);
  return last.length === STUCK && last.every((s) => s.pageChanged === false && s.operation !== "WAIT");
}

function blockedByGate(decision: Decision, allow: Allow): string | null {
  const gate = decision.destructive;
  if (gate === null || gate.probability <= THRESHOLD) return null;
  const verb = gate.verb ?? "change";
  if (allow !== "all" && !allow.has(verb)) return `${verb} is destructive and not in --allow`;
  return null;
}

function logged(decision: Decision): string | null {
  return decision.password && decision.value !== null ? MASK : decision.value;
}

function recent(history: Step[]): Recent[] {
  return history.map(({ operation, label, value, pageChanged }) => ({
    operation,
    target: label,
    value,
    pageChanged,
  }));
}

/**
 * Drives the browser to the goal, one Jev request per step. Every step is observed before the decision
 * and the page is re-hashed before the act, so a page that moved is re-decided instead of acted on.
 * A mutation is never retried: the step is recorded once, whether it ran, was skipped or failed.
 */
export async function run(options: RunOptions, injected?: Deps): Promise<RunResult> {
  const spans = valueSpans(options.goal);
  const history: Step[] = [];
  const startedAt = new Date().toISOString();
  let observation: Observation | null = null;
  let status: RunResult["status"] = "blocked";
  let reason: string | null = `reached --max-steps ${options.maxSteps}`;
  let steps = 0;

  await mkdir(options.out, { recursive: true });
  const write = async (state: RunStatus, step: Step | null = null) => {
    if (step !== null) await appendFile(join(options.out, "inferred.jsonl"), `${JSON.stringify(step)}\n`);
    const path = join(options.out, "status.json");
    await writeFile(
      `${path}.tmp`,
      `${JSON.stringify(
        {
          status: state,
          goal: options.goal,
          url: observation?.url ?? null,
          steps,
          actions: history.length,
          out: options.out,
          record: options.record ?? null,
          model: options.model,
          reason,
          startedAt,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    await rename(`${path}.tmp`, path);
  };
  await write("running");

  let browser: AgentBrowser | null = null;
  let recording = false;
  try {
    const deps = injected ?? defaultDeps(options);
    const jev = deps.jev;
    browser = deps.browser;

    if (options.url !== undefined) await browser.run(["open", options.url]);
    if (options.record !== undefined) {
      await browser.run(["record", "start", options.record, "--cursor"]);
      recording = true;
    }

    while (steps < options.maxSteps) {
      observation = await observe(browser);
      const previous = history.at(-1);
      if (previous !== undefined && previous.pageChanged === null) {
        previous.pageChanged = observation.hash !== previous.hash;
      }
      if (stuck(history)) {
        reason = `${STUCK} actions in a row left the page unchanged`;
        break;
      }
      await appendFile(
        join(options.out, "observed.jsonl"),
        `${JSON.stringify({ step: steps + 1, ...observation })}\n`,
      );

      const decision = await decide({
        jev,
        model: options.model,
        goal: options.goal,
        spans,
        observation,
        recent: recent(history),
        allow: options.allow,
      });
      steps++;
      const step: Step = {
        step: steps,
        hash: observation.hash,
        operation: decision.operation,
        target: decision.target,
        label: decision.label,
        value: logged(decision),
        executed: false,
        reason: null,
        pageChanged: null,
        confidence: decision.confidence,
        probabilities: decision.probabilities,
        targetProbabilities: decision.targetProbabilities,
        valueProbabilities: decision.valueProbabilities,
        destructive: decision.destructive,
        latencyMs: decision.latencyMs,
        usage: decision.usage,
        model: decision.model,
      };

      if (decision.operation === "BLOCKED") {
        reason = step.reason = "no supported operation can make progress";
        await write("running", step);
        break;
      }
      if (decision.operation === "TYPE_TEXT" && (decision.value === null || (decision.valueProbability ?? 0) <= THRESHOLD)) {
        reason = step.reason = `the goal holds no value for ${decision.label}`;
        await write("running", step);
        break;
      }
      const denied = blockedByGate(decision, options.allow);
      if (denied !== null) {
        step.reason = denied;
        await write("running", step);
        continue;
      }
      if ((await snapshotHash(browser)) !== observation.hash) {
        step.reason = "the page changed between the decision and the act";
        await write("running", step);
        continue;
      }
      if (decision.operation === "DONE") {
        status = "done";
        reason = step.reason = "every requirement is visibly satisfied";
        await write("running", step);
        break;
      }

      const command = commandFor(decision, options.human) as string[];
      try {
        await browser.run(command);
      } catch (error) {
        reason = step.reason = `${command[0]} failed: ${(error as Error).message}`;
        await write("running", step);
        break;
      }
      step.executed = true;
      history.push(step);
      await write("running", step);
    }

    if (recording) {
      await browser.run(["record", "stop"]);
      recording = false;
    }
    observation ??= await observe(browser);
    await write(status);
    return {
      status,
      url: observation.url,
      steps,
      actions: history.length,
      snapshot: observation.text,
      out: options.out,
      record: options.record ?? null,
      reason,
    };
  } catch (error) {
    reason = (error as Error).message;
    if (recording && browser !== null) await browser.run(["record", "stop"]).catch(() => {});
    await write("failed");
    throw error;
  }
}
