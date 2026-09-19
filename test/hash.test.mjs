import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pageHash } from "../dist/hash.js";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).data;
}

const before = fixture("snapshot-login.json");
const typed = fixture("snapshot-login-typed.json");

test("the same page hashes the same twice", () => {
  assert.equal(pageHash(before.origin, before.snapshot), pageHash(before.origin, before.snapshot));
  assert.match(pageHash(before.origin, before.snapshot), /^[0-9a-f]{64}$/);
});

test("typing in a field changes the hash", () => {
  assert.notEqual(pageHash(before.origin, before.snapshot), pageHash(typed.origin, typed.snapshot));
});

test("the same snapshot at another url is another page", () => {
  assert.notEqual(pageHash(before.origin, before.snapshot), pageHash(before.origin + "?x", before.snapshot));
});
