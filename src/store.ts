import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

/**
 * Where a scope keeps its state, under keys like `policies/<policy>.yaml` and `sessions/<session>/auth.json`.
 * The local store keeps each key as a file; a remote store keeps the same keys behind its own contract.
 */
export interface Store {
  /** The bytes under the key, or null when nothing is stored there. */
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array | string): Promise<void>;
  /** Every key that starts with the prefix, sorted. */
  list(prefix: string): Promise<string[]>;
  /** Removes the key; a key that holds nothing is already deleted. */
  delete(key: string): Promise<void>;
}

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
    },
    async list(prefix) {
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
          else if (entry.isFile() && key.startsWith(prefix)) keys.push(key);
        }
      };
      await walk("");
      return keys.sort();
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}
