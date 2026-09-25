import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stepLine } from "./progress.js";
import { going, latestRun, readState } from "./runs.js";
import type { Scopes } from "./scope.js";

export interface TailOptions {
  /** Print each step's JSON object instead of its line. */
  json: boolean;
  write(line: string): void;
  pollMs?: number;
}

const POLL_MS = 250;

/** The steps a run has written so far, whole lines only: a goal run's decisions in `inferred.jsonl`, a walk's `steps.jsonl`. */
async function stepsOf(out: string, walk: boolean): Promise<Record<string, unknown>[]> {
  const path = join(out, walk ? "steps.jsonl" : "inferred.jsonl");
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => typeof entry.step === "number" && (walk ? "kind" in entry : "operation" in entry));
}

function lineOf(entry: Record<string, unknown>, walk: boolean): string {
  return stepLine({
    step: entry.step as number,
    operation: (walk ? entry.kind : entry.operation) as string,
    label: (entry.label ?? null) as string | null,
    value: (entry.value ?? null) as string | null,
    confidence: (entry.confidence ?? null) as number | null,
  });
}

/**
 * `soab tail <session>`: prints the steps of the session's newest run as they land, in the form a run prints them on
 * stderr, until its `status.json` leaves `running`. A run that already ended prints its steps and returns.
 */
export async function tail(scopes: Scopes, session: string, options: TailOptions): Promise<void> {
  const out = latestRun(scopes, session);
  if (out === null) throw new Error(`session ${session} has no runs`);
  let printed = 0;
  for (;;) {
    const state = readState(out);
    const walk = state !== null && state.goal === null;
    const steps = await stepsOf(out, walk);
    for (const entry of steps.slice(printed)) options.write(options.json ? JSON.stringify(entry) : lineOf(entry, walk));
    printed = steps.length;
    if (!going(state)) return;
    await new Promise((wake) => setTimeout(wake, options.pollMs ?? POLL_MS));
  }
}
