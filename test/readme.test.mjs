import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { USAGE } from "../dist/args.js";
import { COLLECTIONS } from "../dist/policy/load.js";
import { NAME, STATE_DIR } from "../dist/name.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (dir) => readdirSync(`${root}${dir}`).filter((f) => f.endsWith(".md")).map((f) => readFileSync(`${root}${dir}/${f}`, "utf8"));
/** The README is the front page and docs/ holds the rest, so the checks read them as one text. */
const front = readFileSync(`${root}README.md`, "utf8");
const readmeFiles = [front, ...read("docs")];
const readme = readmeFiles.join("\n");
const skillEntry = readFileSync(`${root}skills/${NAME}/SKILL.md`, "utf8");
/** The skill is its entrypoint plus the references it points at. */
const skillFiles = [skillEntry, ...read(`skills/${NAME}/references`)];
const skill = skillFiles.join("\n");

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

test("the docs name session reset", () => {
  assert.ok(USAGE.includes(`${NAME} session reset <session>`), "USAGE does not name session reset");
  assert.ok(readme.includes(`${NAME} session reset`), "README does not name session reset");
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
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skillEntry);
  assert.ok(frontmatter, "SKILL.md starts with no YAML frontmatter");
  assert.match(frontmatter[1], new RegExp(`^name: ${NAME}$`, "m"));
  assert.match(frontmatter[1], /^description: \S/m);
});

test("SKILL.md links every reference, and every link resolves", () => {
  for (const file of readdirSync(`${root}skills/${NAME}/references`)) {
    assert.ok(skillEntry.includes(`](references/${file})`), `SKILL.md does not link references/${file}`);
  }
});

test("the README links every doc, and every doc link resolves", () => {
  for (const file of readdirSync(`${root}docs`)) {
    assert.ok(front.includes(`](docs/${file})`), `README does not link docs/${file}`);
  }
  for (const [, target] of readme.matchAll(/\]\(((?:docs\/)?[a-z-]+\.md)(?:#[a-z-]+)?\)/g)) {
    const path = target.startsWith("docs/") ? target : `docs/${target}`;
    assert.ok(existsSync(`${root}${path}`), `a doc links ${target}, which does not exist`);
  }
});

test("the skill carries the install, the policy grammar and both run forms", () => {
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
  const givesOrder = (text) => {
    const at = order.map((step) => text.indexOf(step));
    return at.every((i, n) => i !== -1 && (n === 0 || i > at[n - 1]));
  };
  for (const [file, text, files] of [["README.md", readme, readmeFiles], ["SKILL.md", skill, skillFiles]]) {
    for (const token of [`${NAME} init`, `./${STATE_DIR}/`, `~/${STATE_DIR}/`, `${STATE_DIR}/sessions/`]) {
      assert.ok(text.includes(token), `${file} does not name ${token}`);
    }
    assert.ok(files.some(givesOrder), `${file} does not give the lookup order`);
  }
  assert.ok(readme.includes("${VAR}"), "README does not name ${VAR}");
});
