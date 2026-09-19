import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { USAGE } from "../dist/args.js";
import { COLLECTIONS } from "../dist/policy/load.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const readme = readFileSync(`${root}README.md`, "utf8");
const skill = readFileSync(`${root}SKILL.md`, "utf8");

/** Every name the docs must carry is read back out of the package, so a rename breaks this test. */
const flags = [...new Set(USAGE.match(/--[a-z][a-z-]*/g))];
const requestTypes = [
  ...readFileSync(`${root}src/protocol.ts`, "utf8").matchAll(/envelope\.type === "([^"]+)"/g),
].map((match) => match[1]);
const policies = readdirSync(`${root}policies`).map((file) => file.replace(/\.yaml$/, ""));

function documents(text, token) {
  return text.includes(`\`${token}\``);
}

test("the README names every run flag", () => {
  assert.ok(flags.length >= 10, `read ${flags.length} flags out of USAGE`);
  for (const flag of flags) assert.ok(documents(readme, flag), `README does not name ${flag}`);
});

test("the README names every request type the plugin answers", () => {
  assert.deepEqual(requestTypes.length, 3);
  for (const type of requestTypes) assert.ok(documents(readme, type), `README does not name ${type}`);
});

test("the README names everything a policy can collect", () => {
  for (const collection of COLLECTIONS) {
    assert.ok(documents(readme, collection), `README does not name collect: ${collection}`);
  }
});

test("the README names every policy that ships", () => {
  for (const policy of policies) assert.ok(documents(readme, policy), `README does not name ${policy}.yaml`);
});

test("SKILL.md has the frontmatter npx skills add reads", () => {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert.ok(frontmatter, "SKILL.md starts with no YAML frontmatter");
  assert.match(frontmatter[1], /^name: \S/m);
  assert.match(frontmatter[1], /^description: \S/m);
});

test("SKILL.md carries the install, the policy grammar and both run forms", () => {
  for (const collection of COLLECTIONS) {
    assert.ok(documents(skill, collection), `SKILL.md does not name collect: ${collection}`);
  }
  for (const token of ["npm link", "~/.agent-browser/config.json", "--policy", "--max-steps", "findings.json"]) {
    assert.ok(skill.includes(token), `SKILL.md does not name ${token}`);
  }
});
