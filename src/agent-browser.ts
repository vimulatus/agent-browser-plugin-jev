import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
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

/** The seconds a `Retry-After` header asks for: a whole number of seconds, or an HTTP date from now. */
export function retryAfterOf(headers: Record<string, string> | undefined, now = Date.now()): number | undefined {
  const raw = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "retry-after")?.[1]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
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
      const { requests } = (await run(["network", "requests"])) as {
        requests: (Request & { responseHeaders?: Record<string, string> })[];
      };
      return requests.map(({ method, url, status, resourceType, mimeType, timestamp, responseHeaders }) => {
        const retryAfter = retryAfterOf(responseHeaders);
        return { method, url, status, resourceType, mimeType, timestamp, ...(retryAfter === undefined ? {} : { retryAfter }) };
      });
    },
    async clearLogs() {
      await call("console", "--clear");
      await call("errors", "--clear");
      await call("network", "requests", "--clear");
    },
    async maxLength(ref) {
      const { value } = (await run(["get", "attr", `@${ref}`, "maxlength"])) as { value?: string | null };
      const length = Number(value ?? Number.NaN);
      return Number.isInteger(length) ? length : null;
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
    // agent-browser 0.38.1 launches the first browser after a headed one closed headed again, unless the command names
    // the mode, and the next command relaunches it headless without what it loaded (#67).
    loadState: (path) => call("state", "load", path, "--headed", "false"),
    async authProfiles() {
      const { profiles } = (await run(["auth", "list"])) as { profiles?: AuthProfile[] };
      return profiles ?? [];
    },
    signIn: (profile) => call("auth", "login", profile),
    close: () => call("close"),
    openWindow: (url) => call("open", url, "--headed"),
    // A launch with `--restore <session>`, as the login handoff made before 0.3.0, makes agent-browser 0.38.1 save to
    // `<directory>/<session>-<session>.json`, `.json.enc` when AGENT_BROWSER_ENCRYPTION_KEY is set; `state list` names
    // the directory with HOME and AGENT_BROWSER_NAMESPACE applied. `state clear <name>` deletes every session's file, so each file goes by exact path.
    async forgetSaved() {
      const { directory } = (await run(["state", "list"])) as { directory: string };
      const saved = [`${session}-${session}.json`, `${session}-${session}.json.enc`]
        .map((name) => join(directory, name))
        .filter((path) => existsSync(path));
      for (const path of saved) await rm(path);
      return saved;
    },
  };
}
