import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Act, AuthProfile, Browser, ConsoleMessage, PageError, Request } from "./browser.js";

const execFileAsync = promisify(execFile);

/** One agent-browser command on the session: `run(["snapshot", "-i"])` returns the command's `data`. */
export type Run = (args: string[]) => Promise<Record<string, unknown>>;

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
 * The `agent-browser` binary on PATH, bound to one session. Pointer movement is a session setting,
 * so `human` rides on every command, not only on the ones that move the pointer.
 */
export function agentBrowserCli(session: string, human = false, exec: Exec = execFileAsync): Run {
  const sessionArgs = ["--session", session, "--json", ...(human ? ["--input-mode", "human"] : [])];
  return async (args) => {
    const { stdout } = await exec("agent-browser", [...sessionArgs, ...args], { maxBuffer: 64 * 1024 * 1024 });
    const reply = JSON.parse(stdout) as Reply;
    if (!reply.success || reply.data === null) {
      throw new Error(`agent-browser ${args.join(" ")}: ${reply.error ?? "no data"}`);
    }
    return reply.data;
  };
}

/**
 * The agent-browser command one act runs. `human` approaches a click along an eased curve instead of jumping to it.
 */
function commandFor(act: Act, human: boolean): string[] {
  const ref = `@${act.ref}`;
  switch (act.operation) {
    case "CLICK":
      return human ? ["click", ref, "--human"] : ["click", ref];
    case "TYPE_TEXT":
      return ["fill", ref, act.value ?? ""];
    case "SELECT":
      return ["select", ref, act.value ?? ""];
    case "SCROLL_UP":
      return ["scroll", "up"];
    case "SCROLL_DOWN":
      return ["scroll", "down"];
    case "WAIT":
      return ["wait", "--load", "networkidle"];
    default:
      throw new Error(`${act.operation} is not an act`);
  }
}

/** A Browser over agent-browser. `run` is the binary on PATH unless a test replays one. */
export function agentBrowser(session: string, human = false, run: Run = agentBrowserCli(session, human)): Browser {
  const call = async (...args: string[]) => {
    await run(args);
  };
  return {
    open: (url) => call("open", url),
    reload: () => call("reload"),
    wait: (until) => call("wait", "--load", until),
    async snapshot(interactive) {
      const data = (await run(interactive ? ["snapshot", "-i"] : ["snapshot"])) as { origin: string; snapshot: string };
      return { url: data.origin, tree: data.snapshot };
    },
    async title() {
      return ((await run(["get", "title"])) as { title: string }).title;
    },
    async url() {
      return ((await run(["get", "url"])) as { url: string }).url;
    },
    async console() {
      const { messages } = (await run(["console"])) as { messages: ConsoleMessage[] };
      return messages.map(({ type, text }) => ({ type, text }));
    },
    async errors() {
      const { errors } = (await run(["errors"])) as { errors: PageError[] };
      return errors.map(({ text, url, line, column }) => ({ text, url, line, column }));
    },
    async requests() {
      const { requests } = (await run(["network", "requests"])) as { requests: Request[] };
      return requests.map(({ method, url, status, resourceType, mimeType, timestamp }) => ({
        method,
        url,
        status,
        resourceType,
        mimeType,
        timestamp,
      }));
    },
    async clearLogs() {
      await call("console", "--clear");
      await call("errors", "--clear");
      await call("network", "requests", "--clear");
    },
    act: async (act) => call(...commandFor(act, human)),
    screenshot: (path) => call("screenshot", path),
    record: (path) => call("record", "start", path, "--cursor"),
    stopRecording: () => call("record", "stop"),
    startHar: () => call("network", "har", "start"),
    async stopHar() {
      return ((await run(["network", "har", "stop"])) as { path: string }).path;
    },
    // agent-browser 0.38.1 logs no request for the navigation `tab new <url>` makes, so the tab opens blank.
    openTab: () => call("tab", "new", "about:blank"),
    closeTab: () => call("tab", "close"),
    saveState: (path) => call("state", "save", path),
    loadState: (path) => call("state", "load", path),
    async authProfiles() {
      const { profiles } = (await run(["auth", "list"])) as { profiles?: AuthProfile[] };
      return profiles ?? [];
    },
    signIn: (profile) => call("auth", "login", profile),
    close: () => call("close"),
    // agent-browser 0.38.1 has no live switch between headed and headless, so each is a relaunch. `--restore` rides
    // only on these opens: on a browser launched without it, it relaunches the browser and drops what it held.
    reopen: (url, headed) => call("open", url, "--restore", session, ...(headed ? ["--headed"] : [])),
  };
}
