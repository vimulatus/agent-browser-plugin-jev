import { join, resolve } from "node:path";
import { openBrowser, type Browser } from "../browser.js";
import { openRun } from "../cap.js";
import { findingAt, summarize } from "../findings.js";
import { discoverScopes, type Scopes } from "../scope.js";
import { newRunDir } from "../session.js";
import { observe } from "../observe.js";
import { stopwatch } from "../stopwatch.js";
import { applyPolicy, type Finding } from "./apply.js";
import { readContent } from "./content.js";
import { recordHar } from "./har.js";
import { judge, judgeFindings } from "./judge.js";
import { typesafeJev, type Jev } from "./jev.js";
import { loadPolicy } from "./load.js";

export interface JudgePageOptions {
  session: string;
  policyPath: string;
  out?: string;
  /** The page to open before judging; the page the session is on when absent. */
  url?: string;
  jev?: Jev;
  browser?: Browser;
  /** Where the policy is looked up by name and where the run writes with no `out`; discovered from the working directory and home when absent. */
  scopes?: Scopes;
}

/** The findings, the files they and the run's status were written to, and where Jev's answers went when it judged. */
export interface Judged {
  status: "done";
  url: string;
  findings: Finding[];
  /** The absolute path of `findings.json`, laid out as a walk's. */
  findingsFile: string;
  inferred?: string;
  out: string;
  durationMs: number;
}

/**
 * `run --policy <file> --max-steps 0`: open `url` when given, observe the page once and apply the policy. It writes
 * `findings.json` and `status.json` as every run does, so the one-page judge keeps the same contract as the walk.
 */
export async function judgePage({
  session,
  policyPath,
  out,
  url,
  jev = typesafeJev(),
  browser = openBrowser(session),
  scopes = discoverScopes(),
}: JudgePageOptions): Promise<Judged> {
  const elapsed = stopwatch();
  const startedAt = new Date().toISOString();
  const files = await openRun(scopes, out ?? newRunDir(scopes, session));
  const findingsFile = resolve(files.dir, "findings.json");
  let reason = "judged one page";
  let page: string | null = null;
  let found: Finding[] = [];
  const save = (status: "running" | "done" | "failed") =>
    files.writeJson("status.json", {
      status,
      goal: null,
      policy: policyPath,
      session,
      home: url ?? null,
      url: page,
      steps: 0,
      maxSteps: 0,
      findings: found.length,
      findingsFile,
      out: files.dir,
      reason,
      startedAt,
      updatedAt: new Date().toISOString(),
      durationMs: elapsed(),
    }, status !== "running");
  await save("running");

  try {
    const policy = await loadPolicy(policyPath, scopes);
    if (url !== undefined) await browser.open(url);
    const har = policy.collect.includes("har") ? await recordHar(browser) : undefined;
    const content = policy.collect.includes("content") ? await readContent(browser) : undefined;
    const observation = await observe(browser);
    page = observation.url;
    const gathered = { har, content };
    const inferences = await judge(policy, observation, gathered, jev);
    const applied = applyPolicy(policy, observation, { ...gathered, inferences });
    const judged = await judgeFindings(policy, observation, gathered, applied, jev);
    found = judged.findings;
    const answered = [...inferences, ...judged.inferences];
    if (answered.length > 0) {
      await files.append("inferred.jsonl", `${answered.map((inference) => JSON.stringify(inference)).join("\n")}\n`);
    }
    await files.writeJson("findings.json", summarize(found.map((finding) => findingAt(finding, observation.url, 0))), true);
    await save("done");
    return {
      status: "done",
      url: observation.url,
      findings: found,
      findingsFile,
      ...(answered.length > 0 ? { inferred: join(files.dir, "inferred.jsonl") } : {}),
      out: files.dir,
      durationMs: elapsed(),
    };
  } catch (error) {
    reason = (error as Error).message;
    await save("failed");
    throw error;
  }
}
