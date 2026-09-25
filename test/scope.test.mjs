import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STATE_DIR } from "../dist/name.js";
import { loadPolicy } from "../dist/policy/index.js";
import { discoverScopes, init, loadConfig } from "../dist/scope.js";
import { localStore } from "../dist/store.js";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

function temp(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** A home and a repo under it, both empty temp dirs, so no test reads the real `~`. */
function world() {
  const home = temp("soab-home");
  const repo = join(home, "code", "repo");
  mkdirSync(repo, { recursive: true });
  return { home, repo };
}

function write(path, text) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

test("the local store keeps each key as a file, and lists, reads and deletes it", async () => {
  const dir = temp("soab-store");
  const store = localStore(dir);
  assert.equal(await store.get("policies/perf.yaml"), null);
  await store.put("policies/perf.yaml", "collect: []\n");
  await store.put("sessions/checkout/auth.json", new Uint8Array([123, 125]));
  assert.equal(readFileSync(join(dir, "policies", "perf.yaml"), "utf8"), "collect: []\n");
  assert.equal(Buffer.from(await store.get("sessions/checkout/auth.json")).toString(), "{}");
  assert.deepEqual(await store.list(""), ["policies/perf.yaml", "sessions/checkout/auth.json"]);
  assert.deepEqual(await store.list("sessions/"), ["sessions/checkout/auth.json"]);
  await store.delete("sessions/checkout/auth.json");
  await store.delete("sessions/checkout/auth.json");
  assert.deepEqual(await store.list("sessions/"), []);
  assert.deepEqual(await localStore(join(dir, "absent")).list(""), []);
});

test("the local store refuses a key that leaves its directory", async () => {
  const store = localStore(temp("soab-store"));
  for (const key of ["../outside", "/etc/passwd", "policies/../../outside", ""]) {
    await assert.rejects(store.get(key), /not a relative path inside the store/, key);
  }
});

test("init creates the project scope and a .gitignore naming its sessions, and a second init changes nothing", async () => {
  const { repo } = world();
  const first = await init(repo);
  const dir = join(repo, STATE_DIR);
  assert.equal(first.dir, dir);
  assert.deepEqual(first.created, [`${STATE_DIR}/config.json`, `${STATE_DIR}/policies/`, ".gitignore"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), { store: { type: "local" } });
  assert.ok(existsSync(join(dir, "policies")));
  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), `${STATE_DIR}/sessions/\n`);

  const second = await init(repo);
  assert.deepEqual(second.created, []);
  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), `${STATE_DIR}/sessions/\n`);
});

test("init appends to a .gitignore that has no trailing newline, and keeps a config.json that exists", async () => {
  const { repo } = world();
  writeFileSync(join(repo, ".gitignore"), `node_modules\n${STATE_DIR}/sessions/old`);
  write(join(repo, STATE_DIR, "config.json"), '{ "mine": true }\n');
  const result = await init(repo);
  assert.deepEqual(result.created, [`${STATE_DIR}/policies/`, ".gitignore"]);
  assert.equal(
    readFileSync(join(repo, ".gitignore"), "utf8"),
    `node_modules\n${STATE_DIR}/sessions/old\n${STATE_DIR}/sessions/\n`,
  );
  assert.equal(readFileSync(join(repo, STATE_DIR, "config.json"), "utf8"), '{ "mine": true }\n');
});

test("the init command prints what it created as one JSON line", () => {
  const { home, repo } = world();
  const result = spawnSync("node", [MAIN, "init"], { cwd: repo, encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    dir: join(realpathSync(repo), STATE_DIR),
    created: [`${STATE_DIR}/config.json`, `${STATE_DIR}/policies/`, ".gitignore"],
  });
});

test("the project scope is the nearest state directory up from the working directory, and never the global one", async () => {
  const { home, repo } = world();
  const deep = join(repo, "src", "pages");
  mkdirSync(deep, { recursive: true });
  mkdirSync(join(home, STATE_DIR));

  let scopes = await discoverScopes({ cwd: deep, home });
  assert.equal(scopes.project, undefined);
  assert.equal(scopes.global.dir, join(home, STATE_DIR));

  await init(repo);
  scopes = await discoverScopes({ cwd: deep, home });
  assert.equal(scopes.project.dir, join(repo, STATE_DIR));
});

test("--policy looks in the project, then the global scope, then the policies that ship", async () => {
  const { home, repo } = world();
  await init(repo);
  const project = join(repo, STATE_DIR, "policies", "perf.yaml");
  const global = join(home, STATE_DIR, "policies", "perf.yaml");
  write(project, "name: project\ncollect: [console]\nreport: []\n");
  write(global, "name: global\ncollect: [console]\nreport: []\n");
  const scopes = await discoverScopes({ cwd: repo, home });

  assert.equal((await loadPolicy("perf", scopes)).name, "project");
  rmSync(project);
  assert.equal((await loadPolicy("perf", scopes)).name, "global");
  assert.equal((await loadPolicy("perf.yaml", scopes)).name, "global");
  rmSync(global);
  assert.equal((await loadPolicy("perf", scopes)).name, "perf");
});

test("a policy named by path loads from that path, and a name found nowhere says where it looked", async () => {
  const { home, repo } = world();
  const scopes = await discoverScopes({ cwd: repo, home });
  const path = join(repo, "mine.yaml");
  writeFileSync(path, "name: mine\ncollect: [console]\nreport: []\n");
  assert.equal((await loadPolicy(path, scopes)).name, "mine");
  await assert.rejects(
    loadPolicy("nope", scopes),
    new RegExp(`policy nope: no such file, and no nope.yaml in ${join(home, STATE_DIR, "policies")} or the shipped policies`),
  );
});

test("config.json from the project merges over the global one, key by key", async () => {
  const { home, repo } = world();
  await init(repo);
  write(join(home, STATE_DIR, "config.json"), JSON.stringify({ store: { type: "local", maxBytes: 10 }, keep: "global" }));
  write(join(repo, STATE_DIR, "config.json"), JSON.stringify({ store: { maxBytes: 20 }, extra: [1] }));
  const config = await loadConfig(await discoverScopes({ cwd: repo, home }), {});
  assert.deepEqual(config, { store: { type: "local", maxBytes: 20 }, keep: "global", extra: [1] });
});

test("a ${VAR} in a config string reads the environment, and an unset one is an error that names it", async () => {
  const { home, repo } = world();
  write(
    join(home, STATE_DIR, "config.json"),
    JSON.stringify({ store: { type: "local", headers: { Authorization: "Bearer ${STORE_TOKEN}", Team: "${TEAM}" } } }),
  );
  const scopes = await discoverScopes({ cwd: repo, home });
  const config = await loadConfig(scopes, { STORE_TOKEN: "t0k", TEAM: "qa" });
  assert.deepEqual(config.store.headers, { Authorization: "Bearer t0k", Team: "qa" });
  await assert.rejects(
    loadConfig(scopes, { TEAM: "qa" }),
    new RegExp(`${join(home, STATE_DIR, "config.json")}: \\$\\{STORE_TOKEN\\} reads STORE_TOKEN, which is not set`),
  );
});

test("a config.json that is not a JSON object is an error that names the file", async () => {
  const { home, repo } = world();
  write(join(home, STATE_DIR, "config.json"), "[1]");
  await assert.rejects(
    loadConfig(await discoverScopes({ cwd: repo, home }), {}),
    new RegExp(`${join(home, STATE_DIR, "config.json")}: expected a JSON object`),
  );
});
