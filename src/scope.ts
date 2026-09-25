import { realpathSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { STATE_DIR } from "./name.js";
import { localStore, type Store } from "./store.js";

/** One state directory and the store that holds its state. */
export interface Scope {
  dir: string;
  store: Store;
}

/** The global scope in the home directory, and the project scope when one is found up from the working directory. */
export interface Scopes {
  project?: Scope;
  global: Scope;
}

export type Config = Record<string, unknown>;

const SESSIONS_IGNORE = `${STATE_DIR}/sessions/`;

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function scopeAt(dir: string): Scope {
  return { dir, store: localStore(dir) };
}

/** The nearest `.soab/` up from `cwd` is the project scope, unless it is the global one in `home`. */
export function discoverScopes({ cwd = process.cwd(), home = homedir() } = {}): Scopes {
  const global = join(resolve(home), STATE_DIR);
  const globalReal = isDirectory(global) ? realpathSync(global) : global;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const candidate = join(dir, STATE_DIR);
    if (isDirectory(candidate) && realpathSync(candidate) !== globalReal) {
      return { project: scopeAt(candidate), global: scopeAt(global) };
    }
    if (dirname(dir) === dir) return { global: scopeAt(global) };
  }
}

/** Where sessions keep their runs and their sign-in: the project scope when there is one, else the global. */
export function activeScope(scopes: Scopes): Scope {
  return scopes.project ?? scopes.global;
}

/** The project scope first, then the global one: the order every lookup follows. */
export function inOrder(scopes: Scopes): Scope[] {
  return scopes.project === undefined ? [scopes.global] : [scopes.project, scopes.global];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(under: Config, over: Config): Config {
  const merged = { ...under };
  for (const [key, value] of Object.entries(over)) {
    merged[key] = isRecord(value) && isRecord(merged[key]) ? merge(merged[key], value) : value;
  }
  return merged;
}

function expand(value: unknown, env: NodeJS.ProcessEnv, source: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{(\w+)\}/g, (reference, name: string) => {
      const found = env[name];
      if (found === undefined) throw new Error(`${source}: ${reference} reads ${name}, which is not set`);
      return found;
    });
  }
  if (Array.isArray(value)) return value.map((item) => expand(item, env, source));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, env, source)]));
  return value;
}

async function readConfig(scope: Scope, env: NodeJS.ProcessEnv): Promise<Config> {
  const path = join(scope.dir, "config.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error(`${path}: expected a JSON object`);
  return expand(parsed, env, path) as Config;
}

/**
 * Each scope's `config.json`, the project's merged over the global one key by key. A `${VAR}` in a string reads
 * the environment, so the file can be committed with no secret in it.
 */
export async function loadConfig(scopes: Scopes, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  let config: Config = {};
  for (const scope of inOrder(scopes).reverse()) config = merge(config, await readConfig(scope, env));
  return config;
}

/**
 * `soab init`: creates the project scope in `cwd` with a `config.json` and `policies/`, and keeps its sessions out
 * of git. Leaves anything that is already there as it is, and returns what it created, relative to `cwd`.
 */
export async function init(cwd: string): Promise<{ dir: string; created: string[] }> {
  const dir = join(resolve(cwd), STATE_DIR);
  const created: string[] = [];
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "config.json"), `${JSON.stringify({ store: { type: "local" } }, null, 2)}\n`, { flag: "wx" });
    created.push(`${STATE_DIR}/config.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if ((await mkdir(join(dir, "policies"), { recursive: true })) !== undefined) created.push(`${STATE_DIR}/policies/`);

  const gitignore = join(resolve(cwd), ".gitignore");
  const ignored = await readFile(gitignore, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!ignored.split(/\r?\n/).some((line) => line.trim() === SESSIONS_IGNORE)) {
    const separator = ignored === "" || ignored.endsWith("\n") ? "" : "\n";
    await appendFile(gitignore, `${separator}${SESSIONS_IGNORE}\n`);
    created.push(".gitignore");
  }
  return { dir, created };
}
