import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAuth, saveAuth } from "./auth.js";
import { openBrowser, type Browser } from "./browser.js";
import { openRun, StoreFull } from "./cap.js";
import type { Blocker } from "./blocker.js";
import { chooseNext, operationOf, type Chosen } from "./choose.js";
import { THRESHOLD, type Recent } from "./decide.js";
import { findingAt, sameAs, summarize, type WalkFinding } from "./findings.js";
import { loadFixtures } from "./fixtures.js";
import { frontier, type Entry } from "./frontier.js";
import { checkKey, httpJev, type Jev } from "./jev.js";
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
import { reproduce, type Reproduction } from "./repro.js";
import { allowList, refused, stopAsked, type RunOptions, type RunStatus } from "./run.js";
import { MASK, Secrets } from "./secrets.js";
import { discoverScopes, type Scopes } from "./scope.js";
import type { Operation } from "./snapshot.js";
import { stepLine } from "./progress.js";
import { stopwatch } from "./stopwatch.js";
/** A walk is a run with a policy and no goal. */
export type WalkOptions = RunOptions & { policy: string };

/** One step of the walk, as written to `steps.jsonl`: the control it took and what came of it. */
export interface WalkStep {
  step: number;
  url: string;
  hash: string;
  kind: Operation;
  role: string;
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
  status: "done" | "blocked" | "stopped";
  url: string;
  steps: number;
  actions: number;
  findings: number;
  /** The absolute path of `findings.json`, which a walk always writes. */
  findingsFile: string;
  out: string;
  record: string | null;
  reason: string;
  /** What stopped a blocked walk: a sign-in or a code step no fixture value fills. */
  blocker?: Blocker;
  durationMs: number;
}

/** What a walk that resumes carries over from the one it goes on from: its frontier, its findings and its steps. */
interface Carried {
  entries: Entry[];
  findings: WalkFinding[];
  unfilled: { label: string; url: string }[];
  steps: number;
  actions: number;
  home: string | null;
  stepsLog: string;
}

function readJson<T>(dir: string, name: string, fallback: T): T {
  const path = join(dir, name);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

function carriedFrom(dir: string): Carried {
  const state = readJson<Record<string, unknown>>(dir, "status.json", {});
  const stepsLog = join(dir, "steps.jsonl");
  return {
    entries: readJson<Entry[]>(dir, "frontier.json", []),
    findings: readJson<{ findings: WalkFinding[] }>(dir, "findings.json", { findings: [] }).findings,
    unfilled: readJson(dir, "unfilled.json", []),
    steps: typeof state.steps === "number" ? state.steps : 0,
    actions: typeof state.actions === "number" ? state.actions : 0,
    home: typeof state.home === "string" ? state.home : null,
    stepsLog: existsSync(stepsLog) ? readFileSync(stepsLog, "utf8") : "",
  };
}

/** The kinds that stop a walk on a field no fixture fits: the walk cannot sign in or pass a code step on its own. */
const WALK_BLOCKERS = new Set(["sign_in", "otp"]);

/** What the walk drives: the browser, the session it replays findings on, and Jev for its own and the policy's questions. */
export interface WalkDeps {
  browser: Browser;
  repro: Browser;
  jev: Jev;
  policyJev: PolicyJev;
  /** Where `--policy` looks up a name and the session keeps its sign-in; discovered from the working directory and home when absent. */
  scopes?: Scopes;
}

/**
 * The replay runs on a session of its own, because a recording, the active tab and the refs of a snapshot all
 * belong to a session, and the walk is still using its own. It is always human-paced: the recording is evidence.
 */
export async function defaultWalkDeps(options: WalkOptions): Promise<WalkDeps> {
  await checkKey();
  const apiKey = process.env.TYPESAFE_API_KEY;
  return {
    browser: openBrowser(options.session, options.human),
    repro: openBrowser(`${options.session}-repro`, true),
    jev: httpJev(apiKey),
    policyJev: typesafeJev(options.model),
  };
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
 * origin it started on, and stops when the frontier or `--max-steps` runs out. A control whose act fails is tried, and
 * the walk goes on.
 */
export async function walk(options: WalkOptions, injected?: WalkDeps): Promise<WalkResult> {
  const elapsed = stopwatch();
  const scopes = injected?.scopes ?? discoverScopes();
  const files = await openRun(scopes, options.out);
  const policy = await loadPolicy(options.policy, scopes);
  if (policy.collect.includes("har")) {
    throw new Error(
      `policy ${options.policy}: a HAR is recorded over a reload, which a walk cannot do; judge one page with --max-steps 0`,
    );
  }
  const fixtures = loadFixtures(options.fixtures);
  const findingsFile = resolve(options.out, "findings.json");
  const carried = options.resume === undefined ? null : carriedFrom(options.resume.from);
  const seen = frontier(carried?.entries);
  const findings: WalkFinding[] = carried?.findings ?? [];
  const unfilled: { label: string; url: string }[] = carried?.unfilled ?? [];
  const recent: Recent[] = [];
  const startedAt = new Date().toISOString();
  const secrets = new Secrets();
  let observation: Observation | null = null;
  let steps = carried?.steps ?? 0;
  let actions = carried?.actions ?? 0;
  let reason = `reached --max-steps ${options.maxSteps}`;
  let status: WalkResult["status"] = "done";
  let blocker: Blocker | undefined;
  let home = options.url ?? carried?.home ?? null;
  if (carried !== null && carried.stepsLog !== "") await files.append("steps.jsonl", carried.stepsLog);

  const save = async (state: RunStatus) => {
    const last = state !== "running" && state !== "login";
    await files.writeJson("frontier.json", seen.entries(), last);
    await files.writeJson("findings.json", summarize(findings), last);
    await files.writeJson("unfilled.json", unfilled, last);
    await files.writeJson("status.json", secrets.scrub({
      status: state,
      goal: null,
      policy: options.policy,
      fixtures: options.fixtures ?? null,
      session: options.session,
      home,
      url: observation?.url ?? null,
      steps,
      maxSteps: options.maxSteps,
      allow: allowList(options.allow),
      ...(options.resume === undefined ? {} : { resumedFrom: options.resume.from }),
      actions,
      findings: findings.length,
      findingsFile,
      unfilled: unfilled.length,
      out: options.out,
      record: options.record ?? null,
      model: options.model,
      reason,
      ...(blocker === undefined ? {} : { blocker }),
      startedAt,
      updatedAt: new Date().toISOString(),
      durationMs: elapsed(),
    }), last);
  };
  await save("running");

  let browser: Browser | null = null;
  let replayed: Browser | undefined;
  let recording = false;
  try {
    const deps = injected ?? (await defaultWalkDeps(options));
    browser = deps.browser;
    // A resumed walk goes on in the browser the blocked one left open, which already holds its sign-in.
    if (options.resume === undefined) await loadAuth(files.store, options.session, browser);
    if (options.url !== undefined) await browser.open(options.url);
    if (options.resume?.open !== undefined) {
      secrets.add(options.resume.open);
      await browser.open(options.resume.open);
    }
    if (options.record !== undefined) {
      await browser.record(options.record);
      recording = true;
    }

    /** Every rule of the policy that fires on one page, with the answers Jev gave the rules to read. */
    const firesOn = async (on: Browser, page: Observation, previous: Previous | undefined) => {
      const gathered: Gathered = {
        previous,
        content: policy.collect.includes("content") ? await readContent(on) : undefined,
      };
      const inferences = await judge(policy, page, gathered, deps.policyJev);
      return { gathered, inferences, fired: applyPolicy(policy, page, { ...gathered, inferences }) };
    };

    /** The policy over the page in front of the walk: judge it, apply the rules, keep what is not already reported. */
    const inspect = async (page: Observation, previous: Previous | undefined, step: number, from: string) => {
      const { gathered, inferences, fired } = await firesOn(deps.browser, page, previous);
      const judged = await judgeFindings(policy, page, gathered, fired, deps.policyJev);
      const answered = [...inferences, ...judged.inferences];
      if (answered.length > 0) {
        await files.append("inferred.jsonl", `${answered.map((inference) => JSON.stringify(inference)).join("\n")}\n`);
      }
      for (const finding of judged.findings) {
        const candidate = findingAt(finding, page.url, step);
        const repeats = await sameAs(deps.jev, options.model, candidate, findings);
        if (repeats !== null) {
          findings[repeats].repeats.push({ step: candidate.step, where: candidate.where });
          continue;
        }
        findings.push(candidate);
        await save("running");
        const state = join(options.out, "state.json");
        await deps.browser.saveState(state);
        await files.admit(state);
        replayed = deps.repro;
        // A replay that fails on its own, a recording ffmpeg cannot write say, costs the finding its evidence, not the walk.
        const reproduction = await reproduce({
          browser: deps.repro,
          state,
          files,
          home: from,
          number: findings.length,
          actions: actionsBefore(options.out, candidate.step),
          fixtures,
          fires: async (replay, acted) => {
            const { fired: again } = await firesOn(deps.repro, replay, acted);
            return again.some((one) => one.title === candidate.title);
          },
        }).catch((error: unknown): Reproduction => {
          if (error instanceof StoreFull) throw error;
          return { reproduced: false, evidenceMissing: (error as Error).message };
        });
        Object.assign(candidate, reproduction);
        await save("running");
      }
    };

    /** Types each value `resume` was given into its field, and marks the field tried, so the walk does not block on it again. */
    const typeGiven = async (values: { label: string; value: string }[]) => {
      if (values.length === 0) return;
      const page = await observe(deps.browser);
      seen.see(page.url, page.elements);
      const here = seen.here(page.url, page.elements);
      for (const { label, value } of values) {
        const field = here.find(({ element }) => element.label === label && operationOf(element) === "TYPE_TEXT");
        if (field === undefined) throw new Error(`the page has no field "${label}" to type the value into`);
        secrets.add(value, label);
        await deps.browser.act({ operation: "TYPE_TEXT", ref: field.element.ref, value });
        field.entry.tried = true;
        steps++;
        actions++;
        const given: WalkStep = {
          step: steps,
          url: page.url,
          hash: page.hash,
          kind: "TYPE_TEXT",
          role: field.element.role,
          label,
          ref: field.element.ref,
          value: MASK,
          fixture: null,
          executed: true,
          reason: "given to resume",
          confidence: null,
          probabilities: {},
          destructive: null,
          latencyMs: 0,
          usage: {},
          model: options.model,
        };
        await files.append("steps.jsonl", `${JSON.stringify(given)}\n`);
        options.progress?.(stepLine({ ...given, operation: given.kind }));
      }
      await save("running");
    };
    await typeGiven(options.resume?.values ?? []);

    let origin: string | null = null;
    let previous: Previous | undefined;
    let acted: { recent: Recent; hash: string } | null = null;
    let jumped: Entry | null = null;

    while (steps < options.maxSteps) {
      const stop = stopAsked(options);
      if (stop !== null) {
        status = "stopped";
        reason = stop;
        break;
      }
      observation = await observe(browser);
      home ??= observation.url;
      origin ??= new URL(home).origin;
      if (new URL(observation.url).origin !== origin) {
        await browser.open(home);
        previous = undefined;
        observation = await observe(browser);
      }
      if (acted !== null) {
        acted.recent.pageChanged = observation.hash !== acted.hash;
        acted = null;
      }
      await files.append("observed.jsonl", `${JSON.stringify(secrets.scrub({ step: steps + 1, ...observation }))}\n`);

      await inspect(observation, previous, steps + 1, home);
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
        await browser.open(next.url);
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
        role: chosen.element.role,
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
        await files.append("steps.jsonl", `${JSON.stringify(step)}\n`);
        options.progress?.(stepLine({ ...step, operation: step.kind }));
        await save("running");
      };

      const deny = refused(chosen.destructive, options.allow);
      if (deny !== null) {
        chosen.entry.tried = true;
        step.reason = deny;
        await record();
        continue;
      }
      const stops = chosen.blocker !== null && WALK_BLOCKERS.has(chosen.blocker.kind) && chosen.blocker.probability >= THRESHOLD;
      if (chosen.operation === "TYPE_TEXT" && chosen.value === null && stops) {
        const empty = observation.elements.filter((element) => operationOf(element) === "TYPE_TEXT" && (element.value ?? "") === "");
        reason = step.reason = `no fixture value belongs in ${chosen.element.label}, on a ${chosen.blocker!.kind} step`;
        blocker = {
          kind: chosen.blocker!.kind as Blocker["kind"],
          fields: empty.map(({ ref, label }) => ({ ref, label })),
          reason,
        };
        status = "blocked";
        await record();
        break;
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

      // A control agent-browser refuses, one another element covers say, is tried; a browser that is gone fails the next observe.
      chosen.entry.tried = true;
      try {
        await browser.act(chosen);
      } catch (error) {
        step.reason = `${chosen.operation} failed: ${(error as Error).message}`;
        await record();
        continue;
      }
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
      await browser.stopRecording();
      recording = false;
      await files.admit(options.record!);
    }
    if (replayed !== undefined) await replayed.close();
    observation ??= await observe(browser);
    if (status === "stopped") await saveAuth(files.store, options.session, browser);
    await save(status);
    return secrets.scrub({
      status,
      url: observation.url,
      steps,
      actions,
      findings: findings.length,
      findingsFile,
      out: options.out,
      record: options.record ?? null,
      reason,
      ...(blocker === undefined ? {} : { blocker }),
      durationMs: elapsed(),
    } satisfies WalkResult);
  } catch (error) {
    reason = (error as Error).message;
    if (recording && browser !== null) {
      await browser.stopRecording().catch(() => {});
      await files.admit(options.record!).catch(() => {});
    }
    if (replayed !== undefined) await replayed.close().catch(() => {});
    // The cap that failed the walk can refuse its last status too, and the walk still fails for the first reason.
    await save("failed").catch((refused: unknown) => {
      if (!(refused instanceof StoreFull)) throw refused;
    });
    throw error;
  }
}
