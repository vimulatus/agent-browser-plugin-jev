import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { inOrder, type Scopes } from "../scope.js";
import { localStore } from "../store.js";
import { parseWhen, pathsOf as pathsOfWhen, type Expression } from "./expression.js";
import type { Facts } from "./facts.js";
import { formatPath, type Path } from "./path.js";
import { parseBuckets, type Buckets } from "./range.js";
import { parseTemplate, pathsOf as pathsOfTemplate, type Template } from "./template.js";

export const COLLECTIONS = ["console", "content", "errors", "har", "requests", "snapshot"] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** What one rule or question runs over: the whole page once, or each request or each element in turn. */
export type Scope = "page" | "request" | "element";

/** A question also runs over the findings the report rules made, once they exist. */
export type Over = Scope | "finding";

/** The one thing a policy judges about a finding, after the rules have made it. */
export const OVER_FINDING = "severity";

export interface Measure {
  scope: Scope;
  buckets: Buckets;
  read: (facts: Facts) => number | null | undefined;
}

/** One question the policy puts to Jev, fanned out over every item of its scope. */
export interface Judgment {
  name: string;
  type: "choice" | "noul";
  over: Over;
  instructions: Template;
  criteria?: Record<string, string>;
}

/** A report rule. Its severity is fixed here, unless the policy judges `severity` over every finding. */
export interface Rule {
  when: Expression;
  title: Template;
  severity?: string;
  scope: Scope;
  evidence: { key: string; path: Path };
}

/** A loaded policy: what to collect, which numbers to bucket, what to ask Jev, and the rules that make findings. */
export interface Policy {
  name?: string;
  collect: Collection[];
  measures: Record<string, Measure>;
  judgments: Judgment[];
  rules: Rule[];
}

const SECTIONS = ["name", "collect", "measure", "judge", "report"];
const RULE_FIELDS = ["when", "title", "severity"];
const JUDGMENT_FIELDS = ["type", "over", "instructions", "criteria"];
const OVERS: Over[] = ["page", "request", "element", "finding"];

/** A name a `when` or a `title` can start from: what must be collected, what it runs over, what it compares with. */
interface Readable {
  collections: Collection[];
  scope: Scope;
  values?: string[];
}

/** The numbers a policy may bucket, each read from the facts of its scope. */
const MEASURABLE: Record<string, Readable & { read: Measure["read"] }> = {
  http_status: { collections: ["requests", "har"], scope: "request", read: (facts) => facts.request!.status },
  latency: { collections: ["har"], scope: "request", read: (facts) => facts.request!.time },
  page_unchanged_after_click: {
    collections: ["snapshot"],
    scope: "page",
    read: (facts) => (facts.action?.kind === "CLICK" ? Number(facts.page.hash === facts.action.before) : null),
  },
};

/** The roots a path may start from, with the collections that can fill them. */
const ROOTS: Record<string, Readable> = {
  page: { collections: ["snapshot"], scope: "page" },
  action: { collections: ["snapshot"], scope: "page" },
  console: { collections: ["console"], scope: "page" },
  errors: { collections: ["errors"], scope: "page" },
  requests: { collections: ["requests", "har"], scope: "page" },
  request: { collections: ["requests", "har"], scope: "request" },
  elements: { collections: ["snapshot"], scope: "page" },
  element: { collections: ["snapshot"], scope: "element" },
};

/** The lists a page rule can read, and the evidence key their first item gets. */
const EVIDENCE: { prefix: Path; key: string }[] = [
  { prefix: ["errors"], key: "error" },
  { prefix: ["console", "messages"], key: "console" },
  { prefix: ["console", "errors"], key: "console" },
  { prefix: ["console", "warnings"], key: "console" },
  { prefix: ["requests"], key: "request" },
  { prefix: ["elements"], key: "element" },
];

/** The package root as a store, read-only: the policies that ship sit under the same `policies/` key. */
const SHIPPED = localStore(fileURLToPath(new URL("../../", import.meta.url)));

/**
 * A path as given, or a policy by name (`errors`, `errors.yaml`) from the project scope, then the global scope,
 * then the policies that ship.
 */
export async function loadPolicy(name: string, scopes: Scopes): Promise<Policy> {
  if (existsSync(name)) return parsePolicy(readFileSync(name, "utf8"), name);
  const file = name.endsWith(".yaml") ? name : `${name}.yaml`;
  const key = `policies/${file}`;
  for (const scope of inOrder(scopes)) {
    const bytes = await scope.store.get(key);
    if (bytes !== null) return parsePolicy(decode(bytes), join(scope.dir, key));
  }
  const shipped = await SHIPPED.get(key);
  if (shipped !== null) return parsePolicy(decode(shipped), key);
  const places = inOrder(scopes).map((scope) => join(scope.dir, "policies"));
  throw new Error(`policy ${name}: no such file, and no ${file} in ${places.join(", ")} or the shipped policies`);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses YAML text into a Policy, rejecting every name that nothing will fill. */
export function parsePolicy(text: string, source = "policy"): Policy {
  const fail = (message: string): never => {
    throw new Error(`${source}: ${message}`);
  };
  const doc: unknown = parseYaml(text);
  if (!isRecord(doc)) return fail("expected a mapping with collect and report");
  for (const key of Object.keys(doc)) if (!SECTIONS.includes(key)) fail(`unknown section "${key}"`);
  if (doc.name !== undefined && typeof doc.name !== "string") fail("name must be a string");

  const collect = doc.collect;
  if (!Array.isArray(collect)) return fail("collect must list what to gather: " + COLLECTIONS.join(", "));
  for (const item of collect) {
    if (!COLLECTIONS.includes(item)) fail(`collect: "${item}" is not one of ${COLLECTIONS.join(", ")}`);
  }
  const collected = (collections: Collection[], reader: string) => {
    if (!collections.some((collection) => collect.includes(collection))) {
      fail(`${reader} needs ${collections.map((c) => `"${c}"`).join(" or ")} in collect`);
    }
  };

  const readables: Record<string, Readable> = { ...ROOTS };

  const measures: Record<string, Measure> = {};
  if (doc.measure !== undefined) {
    if (!isRecord(doc.measure)) return fail("measure must map a name to its buckets");
    for (const [name, spec] of Object.entries(doc.measure)) {
      const measurable = MEASURABLE[name];
      if (!measurable) fail(`measure: "${name}" is not measurable; known: ${Object.keys(MEASURABLE).join(", ")}`);
      collected(measurable.collections, `measure ${name}`);
      if (!isRecord(spec) || Object.values(spec).some((r) => typeof r !== "string")) {
        return fail(`measure ${name}: buckets must map a name to a range`);
      }
      const buckets = parseBuckets(spec as Record<string, string>);
      measures[name] = { scope: measurable.scope, buckets, read: measurable.read };
      readables[name] = { ...measurable, values: buckets.map((bucket) => bucket.name) };
    }
  }

  const judgments: Judgment[] = [];
  if (doc.judge !== undefined) {
    if (!isRecord(doc.judge)) return fail("judge must map a name to its question");
    for (const [name, spec] of Object.entries(doc.judge)) {
      if (readables[name]) fail(`judge: "${name}" is already a name a rule can read`);
      const where = `judge ${name}`;
      const judgment = parseJudgment(name, spec, (message) => fail(`${where}: ${message}`));
      for (const path of pathsOfTemplate(judgment.instructions)) {
        const reads = ROOTS[String(path[0])];
        if (!reads) fail(`${where}: instructions name "${formatPath(path)}", which the browser does not show`);
        collected(reads.collections, `${where}: "${formatPath(path)}"`);
        if (reads.scope !== "page" && reads.scope !== judgment.over) {
          fail(`${where}: a question over ${judgment.over} cannot name "${formatPath(path)}"`);
        }
      }
      judgments.push(judgment);
      if (judgment.over === "finding") continue;
      const { collections } = ROOTS[judgment.over];
      collected(collections, `${where}: over ${judgment.over}`);
      readables[name] = { collections, scope: judgment.over, values: judgment.criteria && Object.keys(judgment.criteria) };
    }
  }
  const judgesSeverity = judgments.some((judgment) => judgment.over === "finding");

  const report = doc.report;
  if (!Array.isArray(report)) return fail("report must list rules");
  const rules = report.map((entry: unknown, i: number): Rule => {
    const where = `report[${i}]`;
    if (!isRecord(entry)) return fail(`${where}: expected when, title and severity`);
    for (const key of Object.keys(entry)) if (!RULE_FIELDS.includes(key)) fail(`${where}: unknown field "${key}"`);
    for (const key of ["when", "title"]) if (typeof entry[key] !== "string") fail(`${where}: ${key} must be a string`);
    if (judgesSeverity && entry.severity !== undefined) {
      fail(`${where}: severity is judged over every finding, so a rule cannot set it`);
    }
    if (!judgesSeverity && typeof entry.severity !== "string") fail(`${where}: severity must be a string`);
    const when = parseWhen(entry.when as string);
    const title = parseTemplate(entry.title as string);

    let scope: Scope = "page";
    for (const path of [...pathsOfWhen(when), ...pathsOfTemplate(title)]) {
      const reads = readables[String(path[0])];
      if (!reads) fail(`${where}: "${formatPath(path)}" starts from nothing collected, measured or judged`);
      collected(reads.collections, `${where}: "${formatPath(path)}"`);
      if (reads.scope !== "page" && reads.scope !== scope && scope !== "page") {
        fail(`${where}: a rule cannot run over ${scope} and ${reads.scope} at once`);
      }
      if (reads.scope !== "page") scope = reads.scope;
    }
    for (const expression of comparisons(when)) {
      const values = expression.path.length === 1 ? readables[expression.path[0]]?.values : undefined;
      if (values && (expression.op === "==" || expression.op === "!=") && !values.includes(String(expression.value))) {
        fail(`${where}: "${expression.value}" is not one of ${expression.path[0]}: ${values.join(", ")}`);
      }
    }

    return {
      when,
      title,
      severity: entry.severity as string | undefined,
      scope,
      evidence: scope === "page" ? pageEvidence(pathsOfWhen(when)) : { key: scope, path: [scope] },
    };
  });

  return { name: doc.name as string | undefined, collect, measures, judgments, rules };
}

function parseJudgment(name: string, spec: unknown, fail: (message: string) => never): Judgment {
  if (!isRecord(spec)) return fail("expected type, over and instructions");
  for (const key of Object.keys(spec)) if (!JUDGMENT_FIELDS.includes(key)) fail(`unknown field "${key}"`);
  if (spec.type !== "choice" && spec.type !== "noul") fail(`type must be "choice" or "noul"`);
  if (!OVERS.includes(spec.over as Over)) fail(`over must be one of ${OVERS.join(", ")}`);
  if (spec.over === "finding") {
    if (name !== OVER_FINDING) fail(`over finding is read as the "${OVER_FINDING}" of every finding, under no other name`);
    if (spec.type !== "choice") fail(`over finding must be a choice, one criterion per level`);
  }
  if (typeof spec.instructions !== "string" || spec.instructions.trim() === "") {
    fail("instructions must say what Jev decides");
  }
  const judgment: Judgment = {
    name,
    type: spec.type,
    over: spec.over as Over,
    instructions: parseTemplate(spec.instructions),
  };
  if (spec.type === "noul") {
    if (spec.criteria !== undefined) fail("a noul answers its instructions on its own and takes no criteria");
    return judgment;
  }
  if (!isRecord(spec.criteria) || Object.values(spec.criteria).some((v) => typeof v !== "string")) {
    return fail("criteria must map each option to what it means");
  }
  if (Object.keys(spec.criteria).length < 2) fail("criteria must offer at least two options");
  return { ...judgment, criteria: spec.criteria as Record<string, string> };
}

function comparisons(expression: Expression): Extract<Expression, { kind: "compare" }>[] {
  switch (expression.kind) {
    case "compare":
      return [expression];
    case "path":
      return [];
    case "not":
      return comparisons(expression.operand);
    default:
      return [...comparisons(expression.left), ...comparisons(expression.right)];
  }
}

function pageEvidence(paths: Path[]): Rule["evidence"] {
  for (const path of paths) {
    const list = EVIDENCE.find((e) => e.prefix.every((segment, i) => path[i] === segment));
    if (list) return { key: list.key, path: [...list.prefix, 0] };
  }
  return { key: "page", path: ["page"] };
}
