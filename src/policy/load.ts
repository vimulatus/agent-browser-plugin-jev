import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parseWhen, pathsOf as pathsOfWhen, type Expression } from "./expression.js";
import type { Facts } from "./facts.js";
import { formatPath, type Path } from "./path.js";
import { parseBuckets, type Buckets } from "./range.js";
import { parseTemplate, pathsOf as pathsOfTemplate, type Template } from "./template.js";

export const COLLECTIONS = ["console", "errors", "requests", "snapshot"] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** `page` rules fire once per observation; `request` rules once per request. */
export type Scope = "page" | "request";

export interface Measure {
  scope: Scope;
  buckets: Buckets;
  read: (facts: Facts) => number | null;
}

export interface Rule {
  when: Expression;
  title: Template;
  severity: string;
  scope: Scope;
  evidence: { key: string; path: Path };
}

/** A loaded policy: what to collect, which numbers to bucket, and the rules that make findings. */
export interface Policy {
  name?: string;
  collect: Collection[];
  measures: Record<string, Measure>;
  rules: Rule[];
}

const SECTIONS = ["name", "collect", "measure", "report"];
const RULE_FIELDS = ["when", "title", "severity"];

/** The numbers a policy may bucket, each read from the facts of its scope. */
const MEASURABLE: Record<string, { collection: Collection; scope: Scope; read: Measure["read"] }> = {
  http_status: { collection: "requests", scope: "request", read: (facts) => facts.request!.status },
};

/** The roots a path may start from, with the collection that fills them. */
const ROOTS: Record<string, { collection: Collection; scope: Scope }> = {
  page: { collection: "snapshot", scope: "page" },
  console: { collection: "console", scope: "page" },
  errors: { collection: "errors", scope: "page" },
  requests: { collection: "requests", scope: "page" },
  request: { collection: "requests", scope: "request" },
};

/** The lists a page rule can read, and the evidence key their first item gets. */
const EVIDENCE: { prefix: Path; key: string }[] = [
  { prefix: ["errors"], key: "error" },
  { prefix: ["console", "messages"], key: "console" },
  { prefix: ["console", "errors"], key: "console" },
  { prefix: ["console", "warnings"], key: "console" },
  { prefix: ["requests"], key: "request" },
];

const POLICIES_DIR = fileURLToPath(new URL("../../policies/", import.meta.url));

/** The path as given, or a policy shipped with the plugin by name (`errors`, `errors.yaml`). */
export function resolvePolicyPath(name: string): string {
  if (existsSync(name)) return name;
  const shipped = `${POLICIES_DIR}${name.endsWith(".yaml") ? name : `${name}.yaml`}`;
  if (existsSync(shipped)) return shipped;
  throw new Error(`policy ${name}: no such file, and no shipped policy by that name`);
}

export function loadPolicy(name: string): Policy {
  const path = resolvePolicyPath(name);
  return parsePolicy(readFileSync(path, "utf8"), path);
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
  const collected = (collection: Collection, reader: string) => {
    if (!collect.includes(collection)) fail(`${reader} needs "${collection}" in collect`);
  };

  const measures: Record<string, Measure> = {};
  if (doc.measure !== undefined) {
    if (!isRecord(doc.measure)) return fail("measure must map a name to its buckets");
    for (const [name, spec] of Object.entries(doc.measure)) {
      const measurable = MEASURABLE[name];
      if (!measurable) fail(`measure: "${name}" is not measurable; known: ${Object.keys(MEASURABLE).join(", ")}`);
      collected(measurable.collection, `measure ${name}`);
      if (!isRecord(spec) || Object.values(spec).some((r) => typeof r !== "string")) {
        return fail(`measure ${name}: buckets must map a name to a range`);
      }
      measures[name] = { ...measurable, buckets: parseBuckets(spec as Record<string, string>) };
    }
  }

  const report = doc.report;
  if (!Array.isArray(report)) return fail("report must list rules");
  const rules = report.map((entry: unknown, i: number): Rule => {
    const where = `report[${i}]`;
    if (!isRecord(entry)) return fail(`${where}: expected when, title and severity`);
    for (const key of Object.keys(entry)) if (!RULE_FIELDS.includes(key)) fail(`${where}: unknown field "${key}"`);
    for (const key of RULE_FIELDS) if (typeof entry[key] !== "string") fail(`${where}: ${key} must be a string`);
    const when = parseWhen(entry.when as string);
    const title = parseTemplate(entry.title as string);

    let scope: Scope = "page";
    for (const path of [...pathsOfWhen(when), ...pathsOfTemplate(title)]) {
      const root = String(path[0]);
      const reads = ROOTS[root] ?? measures[root];
      if (!reads) fail(`${where}: "${formatPath(path)}" starts from nothing collected or measured`);
      const collection = "collection" in reads ? reads.collection : MEASURABLE[root].collection;
      collected(collection, `${where}: "${formatPath(path)}"`);
      if (reads.scope === "request") scope = "request";
    }
    for (const expression of comparisons(when)) {
      const measure = expression.path.length === 1 ? measures[expression.path[0]] : undefined;
      if (measure && !measure.buckets.some((b) => b.name === expression.value)) {
        fail(`${where}: "${expression.value}" is not a bucket of ${expression.path[0]}`);
      }
    }

    return {
      when,
      title,
      severity: entry.severity as string,
      scope,
      evidence: scope === "request" ? { key: "request", path: ["request"] } : pageEvidence(pathsOfWhen(when)),
    };
  });

  return { name: doc.name as string | undefined, collect, measures, rules };
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
