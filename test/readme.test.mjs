import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { USAGE } from "../dist/args.js";
import { COLLECTIONS } from "../dist/policy/load.js";
import { NAME, STATE_DIR } from "../dist/name.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const readme = readFileSync(`${root}README.md`, "utf8");
const skill = readFileSync(`${root}SKILL.md`, "utf8");

/** Every name the docs must carry is read back out of the package, so a rename breaks this test. */
const flags = [...new Set(USAGE.match(/--[a-z][a-z-]*/g))];
const policies = readdirSync(`${root}policies`).map((file) => file.replace(/\.yaml$/, ""));

function documents(text, token) {
  return text.includes(`\`${token}\``);
}

test("the README names every run flag", () => {
  assert.ok(flags.length >= 10, `read ${flags.length} flags out of USAGE`);
  for (const flag of flags) assert.ok(documents(readme, flag), `README does not name ${flag}`);
});

test("the README names everything a policy can collect", () => {
  for (const collection of COLLECTIONS) {
    assert.ok(documents(readme, collection), `README does not name collect: ${collection}`);
  }
});

test("the README names every policy that ships", () => {
  for (const policy of policies) assert.ok(documents(readme, policy), `README does not name ${policy}.yaml`);
});

test("the docs name the duration every result carries", () => {
  assert.ok(documents(readme, "durationMs"), "README does not name durationMs");
  assert.ok(documents(skill, "durationMs"), "SKILL.md does not name durationMs");
});

test("the docs name the file a result that wrote findings points at", () => {
  assert.ok(documents(readme, "findingsFile"), "README does not name findingsFile");
  assert.ok(documents(skill, "findingsFile"), "SKILL.md does not name findingsFile");
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
  for (const token of [`npm install -g ${NAME}`, "--policy", "--max-steps", "findings.json"]) {
    assert.ok(skill.includes(token), `SKILL.md does not name ${token}`);
  }
});

test("the docs name the old package only to say it is deprecated", () => {
  for (const [file, text] of [["README.md", readme], ["SKILL.md", skill]]) {
    for (const line of text.split("\n").filter((line) => line.includes("agent-browser-plugin-jev"))) {
      assert.match(line, /deprecated/, `${file} still names agent-browser-plugin-jev: ${line}`);
    }
  }
});

test("the docs run the command by its name, never as jev", () => {
  for (const [file, text] of [["README.md", readme], ["SKILL.md", skill]]) {
    assert.ok(text.includes(`${NAME} run`), `${file} never runs ${NAME}`);
    assert.doesNotMatch(text, /^jev\b|\bjev run\b|`jev`|jev: /m, `${file} still runs jev`);
  }
});

test("the docs name init, both scopes and the order a policy is looked up in", () => {
  const order = [`./${STATE_DIR}/policies/`, `~/${STATE_DIR}/policies/`, "shipped"];
  for (const [file, text] of [["README.md", readme], ["SKILL.md", skill]]) {
    for (const token of [`${NAME} init`, `./${STATE_DIR}/`, `~/${STATE_DIR}/`, `${STATE_DIR}/sessions/`, "${VAR}"]) {
      assert.ok(text.includes(token), `${file} does not name ${token}`);
    }
    const at = order.map((step) => text.indexOf(step));
    assert.ok(at.every((i, n) => i !== -1 && (n === 0 || i > at[n - 1])), `${file} does not give the lookup order`);
  }
});
