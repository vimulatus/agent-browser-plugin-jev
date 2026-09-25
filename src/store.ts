import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

/** One key the store holds: its size, and when it was last used as the store records it; 0 when never. */
export interface Entry {
  key: string;
  bytes: number;
  lastUsed: number;
}

/**
 * Where a scope keeps its state, under keys like `policies/<policy>.yaml` and `sessions/<session>/auth.json`.
 * The local store keeps each key as a file; a remote store keeps the same keys behind its own contract.
 */
export interface Store {
  /** The bytes under the key, or null when nothing is stored there. */
  get(key: string): Promise<Uint8Array | null>;
  /** Stores the value under the key, and records the key as used now. */
  put(key: string, value: Uint8Array | string): Promise<void>;
  /** Every key that starts with the prefix, sorted. */
  list(prefix: string): Promise<string[]>;
  /** Removes the key; a key that holds nothing is already deleted. */
  delete(key: string): Promise<void>;
  /** Records the key as used at `at`, or every key under it when it ends in `/`. */
  touch(key: string, at?: Date): Promise<void>;
  /** Every key that starts with the prefix, sorted, with its size and last use. */
  entries(prefix: string): Promise<Entry[]>;
  /** Deletes every key that starts with the prefix, and the store's record of their use. Returns the keys it deleted. */
  deleteTree(prefix: string): Promise<string[]>;
}

/**
 * Where the local store records when each key was last used: file access times are unreliable on macOS. It sits
 * under `sessions/`, which `init` keeps out of git, and is no key of the store.
 */
const USED = "sessions/.used.json";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** A store that keeps each key as the file at that path under `dir`. */
export function localStore(dir: string): Store {
  const root = resolve(dir);
  const pathOf = (key: string) => {
    const relative = normalize(key);
    if (key === "" || isAbsolute(key) || relative === ".." || relative.startsWith(`..${sep}`)) {
      throw new Error(`store key ${JSON.stringify(key)} is not a relative path inside the store`);
    }
    return join(root, relative);
  };

  const readUsed = async (): Promise<Record<string, number>> => {
    try {
      return JSON.parse(await readFile(join(root, USED), "utf8")) as Record<string, number>;
    } catch (error) {
      if (isMissing(error)) return {};
      throw error;
    }
  };
  const writeUsed = async (used: Record<string, number>) => {
    const path = join(root, USED);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(used));
    await rename(`${path}.tmp`, path);
  };
  const touch = async (key: string, at = new Date()) => {
    pathOf(key);
    await writeUsed({ ...(await readUsed()), [key]: at.getTime() });
  };

  const list = async (prefix: string) => {
    const keys: string[] = [];
    const walk = async (under: string) => {
      let entries;
      try {
        entries = await readdir(join(root, under), { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      for (const entry of entries) {
        const key = under === "" ? entry.name : `${under}/${entry.name}`;
        if (entry.isDirectory()) await walk(key);
        else if (entry.isFile() && key !== USED && key.startsWith(prefix)) keys.push(key);
      }
    };
    await walk("");
    return keys.sort();
  };

  return {
    async get(key) {
      try {
        return await readFile(pathOf(key));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async put(key, value) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, value);
      await touch(key);
    },
    list,
    async delete(key) {
      await rm(pathOf(key), { force: true });
      const used = await readUsed();
      if (key in used) {
        delete used[key];
        await writeUsed(used);
      }
    },
    touch,
    async entries(prefix) {
      const used = await readUsed();
      const lastUse = (key: string) =>
        Object.entries(used).reduce(
          (latest, [touched, at]) => (touched === key || (touched.endsWith("/") && key.startsWith(touched)) ? Math.max(latest, at) : latest),
          0,
        );
      const entries: Entry[] = [];
      for (const key of await list(prefix)) {
        const size = await stat(pathOf(key)).catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        });
        if (size !== null) entries.push({ key, bytes: size.size, lastUsed: lastUse(key) });
      }
      return entries;
    },
    async deleteTree(prefix) {
      const keys = await list(prefix);
      if (prefix.endsWith("/")) await rm(pathOf(prefix), { recursive: true, force: true });
      else for (const key of keys) await rm(pathOf(key), { force: true });
      const used = await readUsed();
      const forgotten = Object.keys(used).filter((key) => key.startsWith(prefix));
      if (forgotten.length > 0) {
        for (const key of forgotten) delete used[key];
        await writeUsed(used);
      }
      return keys;
    },
  };
}
