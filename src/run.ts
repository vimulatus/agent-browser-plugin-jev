import { basename, dirname, extname, join, resolve } from "node:path";
import { keepAuth, loadAuth, saveAuth } from "./auth.js";
import { openBrowser, type Browser } from "./browser.js";
import { boxesFrom, codeBoxes } from "./boxes.js";
import { blockerOf, blocksBeforeActing, networkBlocker, type Blocker, type Cause } from "./blocker.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { openRun, StoreFull, type RunFiles } from "./cap.js";
import { decide, THRESHOLD, type Allow, type Decision, type Recent } from "./decide.js";
import { findingAt, summarize, type WalkFinding } from "./findings.js";
import { checkKey, DEFAULT_MODEL, httpJev, type Jev } from "./jev.js";
import { authProfileFor, handoff } from "./login.js";
import { NAME } from "./name.js";
import { discoverScopes, type Scopes } from "./scope.js";
import { observe, snapshotHash, type Observation } from "./observe.js";
import type { Element } from "./snapshot.js";
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
import { stepLine } from "./progress.js";
import { STOP_FILE } from "./runs.js";
import { MASK, Secrets } from "./secrets.js";
import { valueSpans } from "./spans.js";
import { stopwatch } from "./stopwatch.js";

export const DEFAULT_MAX_STEPS = 60;
/**
 * This many steps in a row that leave the page unchanged mean the run cannot progress. A WAIT counts like any act:
 * it waits for the network to go quiet, so a tree unchanged after it is no more likely to change on the next one.
 */
const STUCK = 3;

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
  /** Whether a blocked page may be signed in with a saved auth profile, or shown to the person in a window. */
  handoff: boolean;
  /** The run can show a window: it has a display and a terminal. Without one, a captcha ends the run like any blocker. */
  display?: boolean;
  loginTimeoutMs: number;
  /** Where each step's line goes as it happens; the command sends it to stderr unless `--quiet`. */
  progress?: (line: string) => void;
  /** Aborted by Ctrl-C or SIGTERM: the run finishes the step it is on and ends `stopped`. */
  signal?: AbortSignal;
  /** Set by `resume`: the run goes on in the session's open browser, from the page the last run ended on. */
  resume?: Resume;
}

/** What `resume` hands the run it starts: the run it goes on from, a link to open, and the values to type first. */
export interface Resume {
  from: string;
  open?: string;
  /** `code` marks a code split over boxes: one character goes into each, from the box of `label` on. */
  values: { label: string; value: string; code?: true }[];
}

/** The allow list as `status.json` keeps it, so `resume` can read it back. */
export function allowList(allow: Allow): string[] | "all" {
  return allow === "all" ? "all" : [...allow];
}

/** What `<out>/status.json` reports while the run is in flight and once it has ended. `login` means a window is open for the person to sign in. */
export type RunStatus = "running" | "login" | "done" | "blocked" | "stopped" | "failed";

export interface RunResult {
  status: "done" | "blocked" | "stopped";
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
  /** What stopped a blocked run, and the fields it needs; absent on any other status. */
  blocker?: Blocker;
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
  outcome: number | null;
  blockerProbabilities: Record<string, number>;
  latencyMs: number;
  usage: Record<string, number>;
  model: string;
}

/** The real browser and the real model, from the session and `TYPESAFE_API_KEY` or a proxy that adds it. */
export async function defaultDeps(options: RunOptions): Promise<Deps> {
  await checkKey();
  const apiKey = process.env.TYPESAFE_API_KEY;
  return {
    browser: openBrowser(options.session, options.human),
    jev: httpJev(apiKey),
    policyJev: typesafeJev(options.model),
  };
}

/** Why the run is stuck, or null: the last `STUCK` steps all left the page as it was. A change starts the count again. */
function stuck(history: Step[]): string | null {
  const last = history.slice(-STUCK);
  if (last.length < STUCK || !last.every((s) => s.pageChanged === false)) return null;
  if (last.every((s) => s.operation === "WAIT")) return `the page did not change after ${STUCK} WAITs in a row`;
  return `${STUCK} actions in a row left the page unchanged`;
}

/** Why the run must stop before its next step, or null: a signal in its own shell, or `soab stop` from another. */
export function stopAsked(options: RunOptions): string | null {
  if (options.signal?.aborted === true) return `stopped by ${String(options.signal.reason ?? "a signal")}`;
  if (existsSync(join(options.out, STOP_FILE))) return `stopped by ${NAME} stop`;
  return null;
}

/** Why an irreversible control may not be activated, or null when it may. Shared by the goal run and the walk. */
export function refused(destructive: Decision["destructive"], allow: Allow): string | null {
  if (destructive === null || destructive.probability <= THRESHOLD) return null;
  const verb = destructive.verb ?? "change";
  if (allow !== "all" && !allow.has(verb)) return `${verb} is destructive and not in --allow`;
  return null;
}

/** The page the run last clicked on, as it read just before the click. */
interface Clicked {
  label: string | null;
  url: string;
  content: string;
}

/**
 * Why the run cannot act on this decision, or null when it can: the goal holds no value for the field, or Jev
 * sees no move, which is what it answers on a login page when the goal has no value to type at all, and on a step
 * that rejected what the run submitted.
 */
function stalledOn(decision: Decision, url: string, clicked: Clicked | null): string | null {
  if (decision.operation === "BLOCKED") {
    const stuckOn = clicked !== null && clicked.url === url;
    const noMove = "no supported operation can make progress";
    return stuckOn ? `${noMove}: the page did not move on after clicking ${clicked.label}` : noMove;
  }
  if (decision.operation !== "TYPE_TEXT") return null;
  if (decision.value === null || (decision.valueProbability ?? 0) <= THRESHOLD) {
    return `the goal holds no value for ${decision.label}`;
  }
  return null;
}

/**
 * Why a DONE does not end the run done, or null when it does. Filled fields and a clicked submit are not the goal's
 * outcome: the page did not move on when it reads exactly as it did before the last click, or when Jev judges it
 * does not show the outcome. A DONE Jev is unsure of does not end the run done either.
 */
function notDone(decision: Decision, url: string, content: string, clicked: Clicked | null): string | null {
  const stayed = clicked !== null && clicked.url === url;
  const noMove = `the page did not move on after clicking ${clicked?.label}`;
  if (stayed && clicked.content === content) return noMove;
  if ((decision.outcome ?? 0) <= THRESHOLD) {
    return stayed ? `${noMove}: it does not show the goal's outcome` : "the page does not show the goal's outcome";
  }
  if (decision.confidence <= THRESHOLD) return `DONE at ${decision.confidence.toFixed(2)} is too unsure to call the goal met`;
  return null;
}

function logged(decision: Decision): string | null {
  return decision.secret && decision.value !== null ? MASK : decision.value;
}

/** Rewrites a JSON-lines file of the run through `secrets`, for the lines written before a secret was typed. */
async function scrubLines(files: RunFiles, name: string, secrets: Secrets): Promise<void> {
  const path = join(files.dir, name);
  if (secrets.empty || !existsSync(path)) return;
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  await files.replace(name, lines.map((line) => `${JSON.stringify(secrets.scrub(JSON.parse(line)))}\n`).join(""));
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

/**
 * What Jev is told the run did. A code spread over single-character boxes is told as one TYPE per box, with the
 * character each got, or the mask for a secret: told as the whole code typed into the first box, Jev sees one character
 * there and types again.
 */
function recent(history: Step[], spread: WeakMap<Step, Element[]>): Recent[] {
  return history.flatMap((step) => {
    const { operation, label, value, pageChanged } = step;
    const boxes = spread.get(step);
    if (boxes === undefined || value === null) return [{ operation, target: label, value, pageChanged }];
    return boxes.map((box, at) => ({ operation, target: box.label, value: value === MASK ? MASK : value[at], pageChanged }));
  });
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
  const files = await openRun(scopes, options.out);
  const store = files.store;
  const policy = await policyOf(options, scopes);
  const findingsFile = policy === null ? undefined : resolve(options.out, "findings.json");
  const spans = valueSpans(options.goal);
  const history: Step[] = [];
  const spread = new WeakMap<Step, Element[]>();
  const findings: WalkFinding[] = [];
  const startedAt = new Date().toISOString();
  let observation: Observation | null = null;
  let status: RunResult["status"] = "blocked";
  let reason: string | null = `reached --max-steps ${options.maxSteps}`;
  let blocker: Blocker | undefined;
  let steps = 0;
  const origins = new Set<string>();
  if (options.url !== undefined) origins.add(new URL(options.url).origin);
  const recordings: string[] = [];
  const secrets = new Secrets();

  const write = async (state: RunStatus, step: Step | null = null) => {
    const last = state !== "running" && state !== "login";
    if (step !== null) {
      const logged = secrets.scrub(step);
      await files.append("inferred.jsonl", `${JSON.stringify(logged)}\n`);
      options.progress?.(stepLine(logged));
    }
    if (policy !== null) await files.writeJson("findings.json", secrets.scrub(summarize(findings)), last);
    await files.writeJson("status.json", secrets.scrub({
      status: state,
      goal: options.goal,
      policy: options.policy ?? null,
      session: options.session,
      url: observation?.url ?? null,
      steps,
      maxSteps: options.maxSteps,
      allow: allowList(options.allow),
      ...(options.resume === undefined ? {} : { resumedFrom: options.resume.from }),
      actions: history.length,
      findings: findings.length,
      findingsFile,
      out: options.out,
      record: options.record ?? null,
      recordings,
      model: options.model,
      reason,
      ...(blocker === undefined ? {} : { blocker }),
      startedAt,
      updatedAt: new Date().toISOString(),
      durationMs: elapsed(),
    }), last);
  };
  /** The lines written before a secret was typed hold it too, so a run that typed one rewrites them as it ends. */
  const scrubEarlier = async () => {
    await scrubLines(files, "inferred.jsonl", secrets);
    await scrubLines(files, "observed.jsonl", secrets);
  };
  await write("running");

  let browser: Browser | null = null;
  let recording = false;
  let stopRecording = async () => {};
  try {
    const deps = injected ?? (await defaultDeps(options));
    const jev = deps.jev;
    browser = deps.browser;

    // A resumed run goes on in the browser the last run left open, which already holds its sign-in.
    if (options.resume === undefined) await loadAuth(store, options.session, browser);
    if (options.url !== undefined) await browser.open(options.url);
    if (options.resume?.open !== undefined) {
      secrets.add(options.resume.open);
      await browser.open(options.resume.open);
    }

    /** Starts the recording on the file asked for, then on `<name>-2`, `<name>-3` after each handoff, which stops it. */
    const record = async () => {
      if (options.record === undefined || recording) return;
      const file = recordingFile(options.record, recordings.length + 1);
      await deps.browser.record(file);
      recordings.push(file);
      recording = true;
    };
    /** A recording's size is known only once it stops, so it is measured against the cap then. */
    stopRecording = async () => {
      if (!recording) return;
      await deps.browser.stopRecording();
      recording = false;
      await files.admit(recordings.at(-1)!);
    };
    await record();

    /**
     * The policy over the page the run is about to act on: judge it, apply the rules, keep what is new.
     * A page condition outlives the act that revealed it, so the same title on a later step is that finding
     * seen again rather than a second one.
     */
    const inspect = async (
      rules: Policy,
      page: Observation,
      content: string,
      previous: Previous | undefined,
      step: number,
    ) => {
      const gathered: Gathered = { previous, content: rules.collect.includes("content") ? content : undefined };
      const inferences = await judge(rules, page, gathered, deps.policyJev);
      const applied = applyPolicy(rules, page, { ...gathered, inferences });
      const judged = await judgeFindings(rules, page, gathered, applied, deps.policyJev);
      const answered = [...inferences, ...judged.inferences];
      if (answered.length > 0) {
        await files.append("inferred.jsonl", `${answered.map((inference) => JSON.stringify(secrets.scrub(inference))).join("\n")}\n`);
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
    const login = async (page: Observation, step: Step, profile: string | null): Promise<boolean> => {
      step.value = MASK;
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
          process.stderr.write(`${NAME}: the page needs a person, finish it on the window at ${page.url}\n`);
          await write("login");
        },
        signedIn: (state) => keepAuth(store, options.session, state),
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

    /** Types each value `resume` was given into the field of that label, as a step of its own. Every one is masked. */
    const typeGiven = async (values: Resume["values"]) => {
      if (values.length === 0) return;
      const page = await observe(deps.browser);
      for (const { label, value, code } of values) {
        const field = page.elements.find((element) => element.label === label && element.operations.includes("TYPE_TEXT"));
        if (field === undefined) throw new Error(`the page has no field "${label}" to type the value into`);
        secrets.add(value, label);
        const boxes = (code ? boxesFrom(page.elements, field.ref, value.length) : null) ?? (await codeBoxes(deps.browser, page.elements, field.ref, value));
        if (boxes === null) await deps.browser.act({ operation: "TYPE_TEXT", ref: field.ref, value });
        for (const [at, box] of (boxes ?? []).entries()) {
          await deps.browser.act({ operation: "TYPE_TEXT", ref: box.ref, value: value[at] });
          secrets.add("", box.label);
        }
        steps++;
        const step: Step = {
          step: steps,
          hash: page.hash,
          operation: "TYPE_TEXT",
          target: field.index,
          label,
          value: MASK,
          executed: true,
          reason: "given to resume",
          pageChanged: null,
          confidence: 1,
          probabilities: {},
          targetProbabilities: {},
          valueProbabilities: {},
          destructive: null,
          outcome: null,
          blockerProbabilities: {},
          latencyMs: 0,
          usage: {},
          model: options.model,
        };
        history.push(step);
        await write("running", step);
      }
    };
    await typeGiven(options.resume?.values ?? []);

    let previous: Previous | undefined;
    let clicked: Clicked | null = null;
    let decided: Decision | null = null;
    let cause: Cause = null;
    while (steps < options.maxSteps) {
      const stop = stopAsked(options);
      if (stop !== null) {
        status = "stopped";
        reason = stop;
        break;
      }
      observation = await observe(browser);
      origins.add(new URL(observation.url).origin);
      const last = history.at(-1);
      if (last !== undefined && last.pageChanged === null) {
        last.pageChanged = observation.hash !== last.hash;
      }
      const unchanged = stuck(history);
      if (unchanged !== null) {
        reason = unchanged;
        break;
      }
      await files.append("observed.jsonl", `${JSON.stringify(secrets.scrub({ step: steps + 1, ...observation }))}\n`);
      const content = await readContent(browser);
      if (policy !== null) await inspect(policy, observation, content, previous, steps + 1);
      previous = undefined;
      const failed = networkBlocker(observation);
      if (failed !== null) {
        blocker = failed;
        reason = failed.reason;
        break;
      }

      const decision = await decide({
        jev,
        model: options.model,
        goal: options.goal,
        spans,
        observation,
        content,
        recent: recent(history, spread),
        allow: options.allow,
      });
      decided = decision;
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
        outcome: decision.outcome,
        blockerProbabilities: decision.blocker.probabilities,
        latencyMs: decision.latencyMs,
        usage: decision.usage,
        model: decision.model,
      };

      const early = blocksBeforeActing(decision, observation);
      const stalled = early ?? stalledOn(decision, observation.url, clicked);
      if (stalled !== null) {
        const here: Cause = early === null && decision.operation === "TYPE_TEXT" ? "no_value" : null;
        const { kind } = blockerOf(stalled, decision, here);
        // A sign-in with a saved auth profile needs nobody; a captcha, or a page Jev cannot name, needs a person now.
        // Every other blocker ends the run for `resume`, which needs no window and no one watching it.
        const profile = options.handoff && kind === "sign_in" ? await authProfileFor(deps.browser, observation.url) : null;
        const window = options.handoff && options.display === true && (kind === "captcha" || kind === "unknown");
        if (profile === null && !window) {
          cause = here;
          reason = step.reason = stalled;
          await write("running", step);
          break;
        }
        if (!(await login(observation, step, profile))) break;
        history.push(step);
        await write("running", step);
        continue;
      }
      const denied = refused(decision.destructive, options.allow);
      if (denied !== null) {
        cause = "refused";
        reason = step.reason = `${denied}: did not click ${decision.label}`;
        await write("running", step);
        break;
      }
      if ((await snapshotHash(browser)) !== observation.hash) {
        step.reason = "the page changed between the decision and the act";
        await write("running", step);
        continue;
      }
      if (decision.operation === "DONE") {
        const unmet = notDone(decision, observation.url, content, clicked);
        if (unmet === null) status = "done";
        reason = step.reason = unmet ?? "every requirement is visibly satisfied";
        await write("running", step);
        break;
      }

      try {
        const boxes = decision.operation === "TYPE_TEXT" ? await codeBoxes(browser, observation.elements, decision.ref, decision.value) : null;
        if (boxes === null) await browser.act(decision);
        if (boxes !== null) spread.set(step, boxes);
        for (const [at, box] of (boxes ?? []).entries()) {
          await browser.act({ operation: "TYPE_TEXT", ref: box.ref, value: decision.value![at] });
          if (decision.secret) secrets.add("", box.label);
        }
      } catch (error) {
        reason = step.reason = `${decision.operation} failed: ${(error as Error).message}`;
        await write("running", step);
        break;
      }
      step.executed = true;
      if (decision.secret && decision.value !== null) secrets.add(decision.value, decision.label);
      previous = actedOn(decision, observation.hash);
      if (decision.operation === "CLICK") clicked = { label: decision.label, url: observation.url, content };
      history.push(step);
      await write("running", step);
    }

    await stopRecording();
    // A blocked run does not save, so a login that timed out does not overwrite the session's last sign-in.
    if (status === "done" || status === "stopped") await saveAuth(store, options.session, browser);
    observation ??= await observe(browser);
    if (status === "blocked") blocker ??= blockerOf(reason ?? "", decided, cause);
    await scrubEarlier();
    await write(status);
    return secrets.scrub({
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
      ...(blocker === undefined ? {} : { blocker }),
      durationMs: elapsed(),
    } satisfies RunResult);
  } catch (error) {
    reason = (error as Error).message;
    await scrubEarlier().catch(() => {});
    await stopRecording().catch(() => {});
    // The cap that failed the run can refuse its last status too, and the run still fails for the first reason.
    await write("failed").catch((refused: unknown) => {
      if (!(refused instanceof StoreFull)) throw refused;
    });
    throw error;
  }
}
