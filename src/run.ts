import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { loadAuth, saveAuth } from "./auth.js";
import { openBrowser, type Browser } from "./browser.js";
import { decide, THRESHOLD, type Allow, type Decision, type Recent } from "./decide.js";
import { findingAt, summarize, type WalkFinding } from "./findings.js";
import { DEFAULT_MODEL, httpJev, type Jev } from "./jev.js";
import { authProfileFor, handoff, loginPage } from "./login.js";
import { NAME } from "./name.js";
import { activeScope, discoverScopes, type Scopes } from "./scope.js";
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
  type Policy,
  type Previous,
} from "./policy/index.js";
import { valueSpans } from "./spans.js";
import { stopwatch } from "./stopwatch.js";

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
  /** Whether a login page the goal cannot fill is handed to the person in a window. Off, the run ends blocked there. */
  handoff: boolean;
  loginTimeoutMs: number;
}

/** What `<out>/status.json` reports while the run is in flight and once it has ended. `login` means a window is open for the person to sign in. */
export type RunStatus = "running" | "login" | "done" | "blocked" | "failed";

export interface RunResult {
  status: "done" | "blocked";
  url: string;
  steps: number;
  actions: number;
  findings: number;
  /** The absolute path of `findings.json`, on a run with `--policy`; absent when no file was written. */
  findingsFile?: string;
  snapshot: string;
  out: string;
  record: string | null;
  /** Every file the recording went to: one, or one per stretch when a handoff split it. */
  recordings: string[];
  reason: string | null;
  durationMs: number;
}

/** What the loop drives. Tests inject a scripted browser and recorded Jev replies. */
export interface Deps {
  browser: Browser;
  jev: Jev;
  policyJev: PolicyJev;
  /** Where `--policy` looks up a name and the session keeps its sign-in; discovered from the working directory and home when absent. */
  scopes?: Scopes;
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

/** The real browser and the real model, from the session and `TYPESAFE_API_KEY`. */
export function defaultDeps(options: RunOptions): Deps {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (apiKey === undefined || apiKey === "") throw new Error("TYPESAFE_API_KEY is not set");
  return {
    browser: openBrowser(options.session, options.human),
    jev: httpJev(apiKey),
    policyJev: typesafeJev(options.model),
  };
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

/**
 * Why the run cannot act on this decision, or null when it can: the goal holds no value for the field, or Jev
 * sees no move, which is what it answers on a login page when the goal has no value to type at all.
 */
function stalledOn(decision: Decision): string | null {
  if (decision.operation === "BLOCKED") return "no supported operation can make progress";
  if (decision.operation !== "TYPE_TEXT") return null;
  if (decision.value === null || (decision.valueProbability ?? 0) <= THRESHOLD) {
    return `the goal holds no value for ${decision.label}`;
  }
  return null;
}

function logged(decision: Decision): string | null {
  return decision.password && decision.value !== null ? MASK : decision.value;
}

/**
 * The policy the run judges every step against, or null with no `--policy`. A HAR is recorded over a reload,
 * which a run that is driving the page cannot do, so a policy that collects one is refused here.
 */
async function policyOf(options: RunOptions, scopes: Scopes): Promise<Policy | null> {
  if (options.policy === undefined) return null;
  const policy = await loadPolicy(options.policy, scopes);
  if (policy.collect.includes("har")) {
    throw new Error(
      `policy ${options.policy}: a HAR is recorded over a reload, which a goal run cannot do; judge one page with --max-steps 0`,
    );
  }
  return policy;
}

/** The act a policy reads as `action` on the page it leads to, or nothing: scrolling and waiting act on no control. */
function actedOn(decision: Decision, hash: string): Previous | undefined {
  const { operation, label } = decision;
  if (label === null) return undefined;
  if (operation !== "CLICK" && operation !== "TYPE_TEXT" && operation !== "SELECT") return undefined;
  return { hash, action: { kind: operation, label } };
}

/** The file the recording goes to: the one asked for, then `<name>-2`, `<name>-3` for the stretches after each handoff. */
function recordingFile(record: string, stretch: number): string {
  if (stretch === 1) return record;
  const ext = extname(record);
  return join(dirname(record), `${basename(record, ext)}-${stretch}${ext}`);
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
 * With `--policy` every page the run sees is judged against it before the decision, into `findings.json`.
 */
export async function run(options: RunOptions, injected?: Deps): Promise<RunResult> {
  const elapsed = stopwatch();
  const scopes = injected?.scopes ?? discoverScopes();
  const store = activeScope(scopes).store;
  const policy = await policyOf(options, scopes);
  const findingsFile = policy === null ? undefined : resolve(options.out, "findings.json");
  const spans = valueSpans(options.goal);
  const history: Step[] = [];
  const findings: WalkFinding[] = [];
  const startedAt = new Date().toISOString();
  let observation: Observation | null = null;
  let status: RunResult["status"] = "blocked";
  let reason: string | null = `reached --max-steps ${options.maxSteps}`;
  let steps = 0;
  const origins = new Set<string>();
  if (options.url !== undefined) origins.add(new URL(options.url).origin);
  const recordings: string[] = [];

  await mkdir(options.out, { recursive: true });
  const writeJson = async (name: string, value: unknown) => {
    const path = join(options.out, name);
    await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
    await rename(`${path}.tmp`, path);
  };
  const write = async (state: RunStatus, step: Step | null = null) => {
    if (step !== null) await appendFile(join(options.out, "inferred.jsonl"), `${JSON.stringify(step)}\n`);
    if (policy !== null) await writeJson("findings.json", summarize(findings));
    await writeJson("status.json", {
      status: state,
      goal: options.goal,
      policy: options.policy ?? null,
      url: observation?.url ?? null,
      steps,
      actions: history.length,
      findings: findings.length,
      findingsFile,
      out: options.out,
      record: options.record ?? null,
      recordings,
      model: options.model,
      reason,
      startedAt,
      updatedAt: new Date().toISOString(),
      durationMs: elapsed(),
    });
  };
  await write("running");

  let browser: Browser | null = null;
  let recording = false;
  try {
    const deps = injected ?? defaultDeps(options);
    const jev = deps.jev;
    browser = deps.browser;

    await loadAuth(store, options.session, browser);
    if (options.url !== undefined) await browser.open(options.url);

    /** Starts the recording on the file asked for, then on `<name>-2`, `<name>-3` after each handoff, which stops it. */
    const record = async () => {
      if (options.record === undefined || recording) return;
      const file = recordingFile(options.record, recordings.length + 1);
      await deps.browser.record(file);
      recordings.push(file);
      recording = true;
    };
    const stopRecording = async () => {
      if (!recording) return;
      await deps.browser.stopRecording();
      recording = false;
    };
    await record();

    /**
     * The policy over the page the run is about to act on: judge it, apply the rules, keep what is new.
     * A page condition outlives the act that revealed it, so the same title on a later step is that finding
     * seen again rather than a second one.
     */
    const inspect = async (rules: Policy, page: Observation, previous: Previous | undefined, step: number) => {
      const gathered: Gathered = {
        previous,
        content: rules.collect.includes("content") ? await readContent(deps.browser) : undefined,
      };
      const inferences = await judge(rules, page, gathered, deps.policyJev);
      const applied = applyPolicy(rules, page, { ...gathered, inferences });
      const judged = await judgeFindings(rules, page, gathered, applied, deps.policyJev);
      const answered = [...inferences, ...judged.inferences];
      if (answered.length > 0) {
        await appendFile(
          join(options.out, "inferred.jsonl"),
          `${answered.map((inference) => JSON.stringify(inference)).join("\n")}\n`,
        );
      }
      for (const finding of judged.findings) {
        const candidate = findingAt(finding, page.url, step);
        const reported = findings.find((earlier) => earlier.title === candidate.title);
        if (reported === undefined) findings.push(candidate);
        else reported.repeats.push({ step: candidate.step, where: candidate.where });
      }
    };

    /**
     * The goal holds no password, so the login is signed in another way: through the `auth` profile saved for
     * the page, else by the person in a window. Either way the step is logged as a typed password, masked.
     * False when the wait for the person ran out, with the reason on the run.
     */
    const login = async (page: Observation, step: Step): Promise<boolean> => {
      step.value = MASK;
      const profile = await authProfileFor(deps.browser, page.url);
      if (profile !== null) {
        await deps.browser.signIn(profile);
        step.executed = true;
        step.reason = `signed in with the auth profile ${profile}`;
        return true;
      }
      await stopRecording();
      const landed = await handoff({
        browser: deps.browser,
        url: page.url,
        origins,
        timeoutMs: options.loginTimeoutMs,
        opened: async () => {
          // The run blocks its caller, so the caller learns of the window from stderr, not from status.json.
          process.stderr.write(`${NAME}: sign in on the window at ${page.url}\n`);
          await write("login");
        },
        signedIn: () => saveAuth(store, options.session, deps.browser),
      });
      if (landed === null) {
        reason = step.reason = `the login on ${page.url} timed out after ${options.loginTimeoutMs / 1000} s in the window`;
        await write("running", step);
        return false;
      }
      await record();
      step.executed = true;
      step.reason = "signed in by hand in a window";
      return true;
    };

    let previous: Previous | undefined;
    while (steps < options.maxSteps) {
      observation = await observe(browser);
      origins.add(new URL(observation.url).origin);
      const last = history.at(-1);
      if (last !== undefined && last.pageChanged === null) {
        last.pageChanged = observation.hash !== last.hash;
      }
      if (stuck(history)) {
        reason = `${STUCK} actions in a row left the page unchanged`;
        break;
      }
      await appendFile(
        join(options.out, "observed.jsonl"),
        `${JSON.stringify({ step: steps + 1, ...observation })}\n`,
      );
      if (policy !== null) await inspect(policy, observation, previous, steps + 1);
      previous = undefined;

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

      const stalled = stalledOn(decision);
      if (stalled !== null) {
        if (!options.handoff || !loginPage(observation)) {
          reason = step.reason = stalled;
          await write("running", step);
          break;
        }
        if (!(await login(observation, step))) break;
        history.push(step);
        await write("running", step);
        continue;
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

      try {
        await browser.act(decision);
      } catch (error) {
        reason = step.reason = `${decision.operation} failed: ${(error as Error).message}`;
        await write("running", step);
        break;
      }
      step.executed = true;
      previous = actedOn(decision, observation.hash);
      history.push(step);
      await write("running", step);
    }

    await stopRecording();
    // A blocked run does not save: after a handoff it can be on the blank browser of #67, signed out.
    if (status === "done") await saveAuth(store, options.session, browser);
    observation ??= await observe(browser);
    await write(status);
    return {
      status,
      url: observation.url,
      steps,
      actions: history.length,
      findings: findings.length,
      findingsFile,
      snapshot: observation.text,
      out: options.out,
      record: options.record ?? null,
      recordings,
      reason,
      durationMs: elapsed(),
    };
  } catch (error) {
    reason = (error as Error).message;
    if (recording && browser !== null) await browser.stopRecording().catch(() => {});
    await write("failed");
    throw error;
  }
}
