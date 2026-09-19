import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One agent-browser session the plugin drives. `run(["snapshot", "-i"])` returns the command's `data`. */
export interface AgentBrowser {
  run(args: string[]): Promise<Record<string, unknown>>;
}

interface Reply {
  success: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
}

/** Binds the `agent-browser` binary on PATH to one session. */
export function agentBrowser(session: string): AgentBrowser {
  return {
    async run(args) {
      const { stdout } = await execFileAsync(
        "agent-browser",
        ["--session", session, "--json", ...args],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const reply = JSON.parse(stdout) as Reply;
      if (!reply.success || reply.data === null) {
        throw new Error(`agent-browser ${args.join(" ")}: ${reply.error ?? "no data"}`);
      }
      return reply.data;
    },
  };
}
