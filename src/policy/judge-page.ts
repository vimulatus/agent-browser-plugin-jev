import { agentBrowser } from "../agent-browser.js";
import { observe } from "../observe.js";
import { applyPolicy, type Finding } from "./apply.js";
import { loadPolicy } from "./load.js";

export interface JudgePageOptions {
  session: string;
  policyPath: string;
}

/** `run --policy <file> --max-steps 0`: observe the current page once and apply the policy. */
export async function judgePage({ session, policyPath }: JudgePageOptions): Promise<{ findings: Finding[] }> {
  const policy = loadPolicy(policyPath);
  const observation = await observe(agentBrowser(session));
  return { findings: applyPolicy(policy, observation) };
}

/** The options when argv is `run --policy <file> --max-steps 0 [--session <name>]`, else null. */
export function judgePageOptions(argv: string[]): JudgePageOptions | null {
  if (argv[0] !== "run") return null;
  const option = (name: string) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const policyPath = option("--policy");
  if (policyPath === undefined || option("--max-steps") !== "0") return null;
  return { session: option("--session") ?? process.env.AGENT_BROWSER_SESSION ?? "default", policyPath };
}
