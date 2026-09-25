import { appendFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { activeScope, loadConfig, type Config, type Scopes } from "./scope.js";
import type { Entry, Store } from "./store.js";

/** `store.maxBytes` when `config.json` names none: 1 GiB. */
export const DEFAULT_MAX_BYTES = 1024 ** 3;

/** The cap `config.json` sets on the store, or the default. */
export function maxBytesOf(config: Config): number {
  const store = config.store as Record<string, unknown> | undefined;
  const maxBytes = store?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`store.maxBytes must be a positive whole number of bytes, not ${JSON.stringify(maxBytes)}`);
  }
  return maxBytes;
}

/** A store that never holds more than its cap: each write first evicts the least recently used state until it fits. */
export interface CappedStore extends Store {
  /**
   * Makes room for `bytes` more, evicting until they fit. Throws, having written nothing, when they cannot. Only the
   * `last` write of a run may use the room the run keeps spare.
   */
  reserve(bytes: number, last?: boolean): Promise<void>;
  /** Gives back room a write reserved and then freed, such as the old copy of a file it replaced. */
  release(bytes: number): Promise<void>;
  /** Measures a key something else already wrote, evicting to fit it. When it cannot fit, deletes it and throws. */
  admit(key: string): Promise<void>;
}

/** Room a running run keeps free under the cap, so its last status still fits once the cap has refused a write. */
export const SPARE_BYTES = 4096;

const RUN = /^sessions\/[^/]+\/runs\/[^/]+\//;
const AUTH = /^sessions\/[^/]+\/auth\.json$/;

interface Unit {
  prefix: string;
  bytes: number;
  lastUsed: number;
}

/**
 * What eviction may delete, in the order it deletes them: every run directory, least recently used first, then
 * every session's `auth.json` the same way. Policies, and anything else in the store, are never evicted.
 */
function evictable(entries: Entry[], keep: string | undefined): Unit[] {
  const runs = new Map<string, Unit>();
  const auths: Unit[] = [];
  for (const { key, bytes, lastUsed } of entries) {
    if (keep !== undefined && key.startsWith(keep)) continue;
    const run = RUN.exec(key)?.[0];
    if (run !== undefined) {
      const unit = runs.get(run) ?? { prefix: run, bytes: 0, lastUsed: 0 };
      unit.bytes += bytes;
      unit.lastUsed = Math.max(unit.lastUsed, lastUsed);
      runs.set(run, unit);
    } else if (AUTH.test(key)) {
      auths.push({ prefix: key, bytes, lastUsed });
    }
  }
  const oldestFirst = (a: Unit, b: Unit) => a.lastUsed - b.lastUsed;
  return [...[...runs.values()].sort(oldestFirst), ...auths.sort(oldestFirst)];
}

/** A write the cap refused: it does not fit even once everything eviction may delete is gone. */
export class StoreFull extends Error {
  constructor(maxBytes: number, bytes: number, held: number) {
    super(
      `the store is capped at ${maxBytes} bytes, and a write of ${bytes} bytes does not fit beside the ${held} bytes nothing may evict (store.maxBytes in config.json)`,
    );
  }
}

/**
 * The store under a cap of `maxBytes`. `keep` is the key prefix of the run that is writing, which is never evicted
 * while it runs, and which keeps `SPARE_BYTES` free for its last write. The bytes held are measured from the store, then counted up by every reservation, so the count
 * never falls below the truth; the store is measured again only when a write would pass the cap.
 */
export function capped(store: Store, maxBytes: number, keep?: string): CappedStore {
  let counted: number | null = null;
  const limitOf = (last: boolean) => (keep === undefined || last ? maxBytes : maxBytes - SPARE_BYTES);

  /** Evicts until `bytes` more fit under `limit`. False when even evicting everything it may is not enough. */
  const makeRoom = async (bytes: number, limit: number, skip?: string): Promise<boolean> => {
    const entries = await store.entries("");
    let held = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const unit of evictable(entries, keep)) {
      if (held + bytes <= limit) break;
      if (skip !== undefined && unit.prefix === skip) continue;
      await store.deleteTree(unit.prefix);
      held -= unit.bytes;
    }
    counted = held;
    return held + bytes <= limit;
  };

  const reserve = async (bytes: number, last = false) => {
    const limit = limitOf(last);
    if ((counted === null || counted + bytes > limit) && !(await makeRoom(bytes, limit))) {
      throw new StoreFull(maxBytes, bytes, counted!);
    }
    counted! += bytes;
  };

  return {
    get: (key) => store.get(key),
    list: (prefix) => store.list(prefix),
    delete: (key) => store.delete(key),
    touch: (key, at) => store.touch(key, at),
    entries: (prefix) => store.entries(prefix),
    deleteTree: (prefix) => store.deleteTree(prefix),
    reserve,
    async release(bytes) {
      if (counted !== null) counted -= bytes;
    },
    async admit(key) {
      const [written] = await store.entries(key);
      if (written === undefined || written.key !== key) return;
      if (counted !== null && counted + written.bytes <= limitOf(false)) {
        counted += written.bytes;
        return;
      }
      if (!(await makeRoom(0, limitOf(false), key))) {
        await store.deleteTree(key);
        throw new StoreFull(maxBytes, written.bytes, counted! - written.bytes);
      }
    },
    async put(key, value) {
      const bytes = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
      const [existing] = await store.entries(key);
      const replaced = existing?.key === key ? existing.bytes : 0;
      await reserve(bytes);
      await store.put(key, value);
      counted! -= replaced;
    },
  };
}

/** How a run writes its files into its directory, under the store's cap when the directory is in the store. */
export interface RunFiles {
  dir: string;
  /** The store the run keeps its sign-in in, under the same cap, which never evicts this run. */
  store: CappedStore;
  /**
   * Replaces the file with the value as JSON, whole, so a reader never sees half of it; when the cap has no room for
   * both copies, in place. The `last` write of the run may use the room it kept spare.
   */
  writeJson(name: string, value: unknown, last?: boolean): Promise<void>;
  append(name: string, value: string | Uint8Array): Promise<void>;
  /** Measures a file another process wrote into the run, such as a recording, whose size was not known up front. */
  admit(path: string): Promise<void>;
}

async function sizeOf(path: string): Promise<number> {
  return (await stat(path).catch(() => null))?.size ?? 0;
}

/** The key a path has in the local store kept in `storeDir`, or null when the path is outside it. */
function keyIn(storeDir: string, path: string): string | null {
  const inStore = relative(resolve(storeDir), resolve(path));
  if (inStore === "" || inStore === ".." || inStore.startsWith(`..${sep}`) || isAbsolute(inStore)) return null;
  return inStore.split(sep).join("/");
}

/**
 * The files of the run in `dir`, with `store`, the local store kept in `storeDir`, capped at `maxBytes`. A run
 * inside the store reserves room before each write and records itself as used; a run elsewhere, under `--out`,
 * writes uncapped.
 */
export function runFiles(dir: string, storeDir: string, store: Store, maxBytes: number): RunFiles {
  const inStore = keyIn(storeDir, dir);
  const runKey = inStore === null ? undefined : `${inStore}/`;
  const cappedStore = capped(store, maxBytes, runKey);

  const reserve = async (bytes: number, last = false) => {
    if (runKey === undefined) return;
    await cappedStore.reserve(bytes, last);
    await cappedStore.touch(runKey);
  };

  return {
    dir,
    store: cappedStore,
    async writeJson(name, value, last = false) {
      const path = join(dir, name);
      const text = `${JSON.stringify(value, null, 2)}\n`;
      const replaced = await sizeOf(path);
      try {
        await reserve(Buffer.byteLength(text), last);
      } catch (error) {
        if (!(error instanceof StoreFull) || replaced === 0) throw error;
        await reserve(Buffer.byteLength(text) - replaced, last);
        await writeFile(path, text);
        return;
      }
      await mkdir(dir, { recursive: true });
      await writeFile(`${path}.tmp`, text);
      await rename(`${path}.tmp`, path);
      if (runKey !== undefined) await cappedStore.release(replaced);
    },
    async append(name, value) {
      await reserve(typeof value === "string" ? Buffer.byteLength(value) : value.byteLength);
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, name), value);
    },
    async admit(path) {
      const key = keyIn(storeDir, path);
      if (runKey === undefined || key === null || !key.startsWith(runKey)) return;
      await cappedStore.admit(key);
      await cappedStore.touch(runKey);
    },
  };
}

/** The files of the run in `out`, under the cap the scopes' `config.json` sets on the active scope's store. */
export async function openRun(scopes: Scopes, out: string): Promise<RunFiles> {
  const { dir, store } = activeScope(scopes);
  return runFiles(out, dir, store, maxBytesOf(await loadConfig(scopes)));
}
