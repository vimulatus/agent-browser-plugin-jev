import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openBrowser } from "../browser.js";
import { discoverScopes, type Scopes } from "../scope.js";
import { newRunDir } from "../session.js";
import { observe } from "../observe.js";
import { stopwatch } from "../stopwatch.js";
import { applyPolicy, type Finding } from "./apply.js";
import { readContent } from "./content.js";
import { recordHar } from "./har.js";
import { judge, judgeFindings, type Inference } from "./judge.js";
import { typesafeJev, type Jev } from "./jev.js";
import { loadPolicy } from "./load.js";

export interface JudgePageOptions {
  session: string;
  policyPath: string;
  out?: string;
  jev?: Jev;
  /** Where the policy is looked up by name and where the run writes with no `out`; discovered from the working directory and home when absent. */
  scopes?: Scopes;
}

/** The findings, and where the answers Jev gave were written when the policy judged. */
export interface Judged {
  findings: Finding[];
  inferred?: string;
  durationMs: number;
}

/** `run --policy <file> --max-steps 0`: observe the current page once and apply the policy. */
export async function judgePage({ session, policyPath, out, jev = typesafeJev(), scopes = discoverScopes() }: JudgePageOptions): Promise<Judged> {
  const elapsed = stopwatch();
  const policy = await loadPolicy(policyPath, scopes);
  const browser = openBrowser(session);
  const har = policy.collect.includes("har") ? await recordHar(browser) : undefined;
  const content = policy.collect.includes("content") ? await readContent(browser) : undefined;
  const observation = await observe(browser);
  const gathered = { har, content };
  const inferences = await judge(policy, observation, gathered, jev);
  const applied = applyPolicy(policy, observation, { ...gathered, inferences });
  const judged = await judgeFindings(policy, observation, gathered, applied, jev);
  const answered = [...inferences, ...judged.inferences];
  if (answered.length === 0) return { findings: judged.findings, durationMs: elapsed() };
  const inferred = writeInferred(answered, out ?? newRunDir(scopes, session));
  return { findings: judged.findings, inferred, durationMs: elapsed() };
}

/** The options when argv is `run --policy <file> --max-steps 0 [--session <name>] [--out <dir>]`, else null. */
export function judgePageOptions(argv: string[]): JudgePageOptions | null {
  if (argv[0] !== "run") return null;
  const option = (name: string) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const policyPath = option("--policy");
  if (policyPath === undefined || option("--max-steps") !== "0") return null;
  return {
    session: option("--session") ?? process.env.AGENT_BROWSER_SESSION ?? "default",
    policyPath,
    out: option("--out"),
  };
}

function writeInferred(inferences: Inference[], out: string): string {
  mkdirSync(out, { recursive: true });
  const path = join(out, "inferred.jsonl");
  writeFileSync(path, inferences.map((inference) => JSON.stringify(inference)).join("\n") + "\n");
  return path;
}
