import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capped, DEFAULT_MAX_BYTES, maxBytesOf, runFiles } from "../dist/cap.js";
import { localStore } from "../dist/store.js";
import { isolatedScopes, replay, replayingJev, scriptedBrowser, pages } from "./helpers.mjs";
import { run } from "../dist/run.js";
import { activeScope } from "../dist/scope.js";
import { newRunDir, resetSession } from "../dist/session.js";

/** The worked example counts in MB; the tests count in KB, so the files they write stay small. */
const MB = 1000;
const MONDAY = new Date("2026-09-21T12:00:00Z");
const TUESDAY = new Date("2026-09-22T12:00:00Z");

const made = [];
test.after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function storeDir() {
  const dir = mkdtempSync(join(tmpdir(), "soab-store-"));
  made.push(dir);
  return dir;
}

/** Writes `bytes` of zeroes as the file at the key, straight to disk, as the evidence writers and ffmpeg do. */
function fill(dir, key, bytes) {
  mkdirSync(join(dir, key, ".."), { recursive: true });
  writeFileSync(join(dir, key), Buffer.alloc(bytes));
}

async function held(store) {
  return (await store.entries("")).reduce((sum, entry) => sum + entry.bytes, 0);
}

test("the worked example: a 20 MB write under a 100 MB cap evicts the run used Monday, then writes", async () => {
  const dir = storeDir();
  const store = localStore(dir);
  fill(dir, "sessions/a/runs/1/evidence/1.webm", 60 * MB);
  await store.touch("sessions/a/runs/1/", MONDAY);
  fill(dir, "sessions/b/runs/1/evidence/1.webm", 30 * MB);
  await store.touch("sessions/b/runs/1/", TUESDAY);

  const files = runFiles(join(dir, "sessions/c/runs/1"), dir, store, 100 * MB);
  await files.append("login.webm", Buffer.alloc(20 * MB));

  assert.equal(existsSync(join(dir, "sessions/a/runs/1")), false);
  assert.equal(existsSync(join(dir, "sessions/b/runs/1/evidence/1.webm")), true);
  assert.equal(await held(store), 50 * MB);
});

test("last use is the store's record, not the size or the file times: the least recently used run goes first", async () => {
  const dir = storeDir();
  const store = localStore(dir);
  fill(dir, "sessions/a/runs/1/status.json", 30 * MB);
  await store.touch("sessions/a/runs/1/", TUESDAY);
  fill(dir, "sessions/b/runs/1/status.json", 60 * MB);
  await store.touch("sessions/b/runs/1/", MONDAY);

  await capped(store, 100 * MB).put("sessions/c/auth.json", Buffer.alloc(20 * MB));

  assert.deepEqual((await store.entries("sessions/")).map((entry) => entry.key), [
    "sessions/a/runs/1/status.json",
    "sessions/c/auth.json",
  ]);
});

test("runs go before any sign-in, and policies are never evicted", async () => {
  const dir = storeDir();
  const store = localStore(dir);
  fill(dir, "policies/big.yaml", 40 * MB);
  await store.put("sessions/a/auth.json", Buffer.alloc(30 * MB));
  await store.touch("sessions/a/auth.json", MONDAY);
  fill(dir, "sessions/b/runs/1/status.json", 20 * MB);
  await store.touch("sessions/b/runs/1/", TUESDAY);

  const cap = capped(store, 100 * MB);
  await cap.put("sessions/c/auth.json", Buffer.alloc(20 * MB));
  assert.equal(existsSync(join(dir, "sessions/b/runs/1")), false, "the newer run goes before the older sign-in");
  assert.equal(existsSync(join(dir, "sessions/a/auth.json")), true);

  await cap.put("sessions/d/auth.json", Buffer.alloc(40 * MB));
  assert.equal(existsSync(join(dir, "sessions/a/auth.json")), false, "with no run left, the oldest sign-in goes");
  assert.equal(existsSync(join(dir, "policies/big.yaml")), true);
  assert.ok((await held(store)) <= 100 * MB);
});

test("a write that cannot fit after every evictable entry is gone fails with the cap and the size, and writes nothing", async () => {
  const dir = storeDir();
  const store = localStore(dir);
  fill(dir, "policies/big.yaml", 90 * MB);
  fill(dir, "sessions/a/runs/1/status.json", 5 * MB);

  await assert.rejects(
    capped(store, 100 * MB).put("sessions/b/auth.json", Buffer.alloc(20 * MB)),
    /100000 bytes.*20000 bytes/,
  );
  assert.equal(existsSync(join(dir, "sessions/b/auth.json")), false);
  assert.ok((await held(store)) <= 100 * MB);
});

test("a run never evicts its own directory: it evicts the others, then fails", async () => {
  const dir = storeDir();
  const store = localStore(dir);
  fill(dir, "sessions/a/runs/1/status.json", 30 * MB);
  await store.touch("sessions/a/runs/1/", TUESDAY);
  const own = "sessions/b/runs/1/";
  fill(dir, `${own}evidence/1.webm`, 50 * MB);
  await store.touch(own, MONDAY);

  const files = runFiles(join(dir, own), dir, store, 100 * MB);
  await files.append("observed.jsonl", Buffer.alloc(40 * MB));
  assert.equal(existsSync(join(dir, "sessions/a/runs/1")), false);
  await assert.rejects(files.append("observed.jsonl", Buffer.alloc(20 * MB)), /100000 bytes/);
  assert.equal(existsSync(join(dir, `${own}evidence/1.webm`)), true);
  assert.equal(await held(store), 90 * MB);
});

test("a file another process wrote into the run is measured after: it evicts to fit, or is deleted and fails", async () => {
  const dir = storeDir();
  const store = localStore(dir);
  fill(dir, "sessions/a/runs/1/status.json", 50 * MB);
  const own = "sessions/b/runs/1/";
  const files = runFiles(join(dir, own), dir, store, 100 * MB);

  fill(dir, `${own}login.webm`, 60 * MB);
  await files.admit(join(dir, own, "login.webm"));
  assert.equal(existsSync(join(dir, "sessions/a/runs/1")), false);

  fill(dir, `${own}login-2.webm`, 50 * MB);
  await assert.rejects(files.admit(join(dir, own, "login-2.webm")), /100000 bytes.*50000 bytes/);
  assert.equal(existsSync(join(dir, own, "login-2.webm")), false);
  assert.equal(await held(store), 60 * MB);
});

test("a run directory outside the store is not capped", async () => {
  const dir = storeDir();
  const out = storeDir();
  const files = runFiles(out, dir, localStore(dir), 10);
  await files.writeJson("status.json", { status: "running" });
  await files.append("observed.jsonl", "x".repeat(100));
  await files.admit(join(out, "observed.jsonl"));
  assert.equal(readFileSync(join(out, "observed.jsonl"), "utf8").length, 100);
});

test("store.maxBytes defaults to 1 GiB and must be a positive whole number", () => {
  assert.equal(DEFAULT_MAX_BYTES, 1024 ** 3);
  assert.equal(maxBytesOf({}), DEFAULT_MAX_BYTES);
  assert.equal(maxBytesOf({ store: { type: "local" } }), DEFAULT_MAX_BYTES);
  assert.equal(maxBytesOf({ store: { maxBytes: 5000 } }), 5000);
  for (const maxBytes of [0, -1, 1.5, "100"]) assert.throws(() => maxBytesOf({ store: { maxBytes } }), /store\.maxBytes/);
});

test("a goal run over the cap evicts another run, then fails with the cap and the size in its reason, keeping its own", async () => {
  const scopes = isolatedScopes();
  const { dir } = activeScope(scopes);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ store: { maxBytes: 8000 } }));
  fill(dir, "sessions/other/runs/1/status.json", 500);
  const out = newRunDir(scopes, "checkout");
  const options = {
    goal: JSON.parse(readFileSync(new URL("./replay/login.json", import.meta.url), "utf8")).goal,
    session: "checkout",
    maxSteps: 5,
    out,
    allow: new Set(),
    model: "jev",
    human: false,
    handoff: false,
    loginTimeoutMs: 1000,
  };
  const browser = scriptedBrowser(pages("login"));
  await assert.rejects(run(options, { browser, jev: replayingJev(replay("login")), policyJev: null, scopes }), /8000 bytes/);
  const status = JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
  assert.equal(existsSync(join(dir, "sessions/other/runs/1")), false);
  assert.equal(status.status, "failed");
  assert.match(status.reason, /capped at 8000 bytes/);
  assert.ok(existsSync(join(out, "observed.jsonl")), "the run got as far as its first step");
});

test("session reset deletes through the store, so the store forgets when the session was used", async () => {
  const scopes = isolatedScopes();
  const { store } = activeScope(scopes);
  await store.put("sessions/checkout/auth.json", "{}");
  await store.touch("sessions/checkout/runs/1/", MONDAY);
  fill(activeScope(scopes).dir, "sessions/checkout/runs/1/status.json", 10);
  await resetSession(scopes, "checkout", { close: async () => {}, forgetSaved: async () => [] });
  assert.deepEqual(await store.entries("sessions/"), []);
  fill(activeScope(scopes).dir, "sessions/checkout/runs/1/status.json", 10);
  assert.equal((await store.entries("sessions/"))[0].lastUsed, 0);
});
