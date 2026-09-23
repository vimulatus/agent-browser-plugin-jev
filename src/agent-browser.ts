import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One agent-browser session Jev drives. `run(["snapshot", "-i"])` returns the command's `data`. */
export interface AgentBrowser {
  run(args: string[]): Promise<Record<string, unknown>>;
}

interface Reply {
  success: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
}

type Exec = (
  file: string,
  args: string[],
  options: { maxBuffer: number },
) => Promise<{ stdout: string }>;

/**
 * Binds the `agent-browser` binary on PATH to one session. Pointer movement is a session setting,
 * so `human` rides on every command, not only on the ones that move the pointer.
 */
export function agentBrowser(session: string, human = false, exec: Exec = execFileAsync): AgentBrowser {
  const sessionArgs = ["--session", session, "--json", ...(human ? ["--input-mode", "human"] : [])];
  return {
    async run(args) {
      const { stdout } = await exec(
        "agent-browser",
        [...sessionArgs, ...args],
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
