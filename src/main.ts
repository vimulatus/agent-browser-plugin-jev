#!/usr/bin/env node
import { parseRunArgs, USAGE, UsageError } from "./args.js";
import { openBrowser } from "./browser.js";
import { NAME } from "./name.js";
import { judgePage, judgePageOptions } from "./policy/index.js";
import { run, type RunOptions } from "./run.js";
import { stopSession } from "./runs.js";
import { tail } from "./tail.js";
import { discoverScopes, init } from "./scope.js";
import { newRunDir, resetSession } from "./session.js";
import { walk, type WalkOptions } from "./walk.js";

/** The exit code of a run that ended: 0 done, 2 blocked, 3 stopped. */
const EXIT = { done: 0, blocked: 2, stopped: 3 } as const;

/**
 * Ctrl-C and SIGTERM stop the run after the step it is on, so it ends `stopped` with its files and sign-in kept.
 * A second Ctrl-C exits at once.
 */
function stopOnSignals(options: RunOptions): void {
  const stop = new AbortController();
  options.signal = stop.signal;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stop.signal.aborted) process.exit(130);
      process.stderr.write(`${NAME}: stopping after this step\n`);
      stop.abort(signal);
    });
  }
}

async function main(argv: string[]): Promise<number> {
  const judge = judgePageOptions(argv);
  if (judge) {
    process.stdout.write(`${JSON.stringify(await judgePage(judge))}\n`);
    return 0;
  }
  if (argv[0] === "init") {
    if (argv.length > 1) throw new UsageError(`init takes no arguments, not "${argv[1]}"`);
    process.stdout.write(`${JSON.stringify(await init(process.cwd()))}\n`);
    return 0;
  }
  if (argv[0] === "session") {
    if (argv[1] !== "reset") throw new UsageError(`unknown session command ${argv[1] ?? "(none)"}: session reset <session>`);
    if (argv.length !== 3) throw new UsageError("session reset takes one session name");
    const reset = await resetSession(discoverScopes(), argv[2], openBrowser(argv[2]));
    process.stderr.write(
      reset.deleted.length === 0
        ? `${NAME}: session ${reset.session} had nothing to delete\n`
        : `${NAME}: deleted ${reset.deleted.join(", ")}\n`,
    );
    process.stdout.write(`${JSON.stringify(reset)}\n`);
    return 0;
  }
  if (argv[0] === "tail") {
    const json = argv.includes("--json");
    const names = argv.slice(1).filter((arg) => arg !== "--json");
    if (names.length !== 1 || names[0].startsWith("--")) throw new UsageError("tail takes one session name, and --json");
    await tail(discoverScopes(), names[0], { json, write: (line) => process.stdout.write(`${line}\n`) });
    return 0;
  }
  if (argv[0] === "stop") {
    if (argv.length !== 2) throw new UsageError("stop takes one session name");
    const stopped = stopSession(discoverScopes(), argv[1]);
    process.stderr.write(
      stopped.stopping ? `${NAME}: asked the run in ${stopped.out} to stop\n` : `${NAME}: session ${argv[1]} has no running run\n`,
    );
    process.stdout.write(`${JSON.stringify(stopped)}\n`);
    return 0;
  }
  if (argv[0] === "run") {
    const options = parseRunArgs(argv.slice(1));
    if (options.goal === "" && options.policy === undefined) {
      throw new UsageError('run needs a goal or a policy: run "<goal>", or run --policy <file>');
    }
    if (options.out === "") options.out = newRunDir(discoverScopes(), options.session);
    process.stderr.write(`${NAME}: writing to ${options.out}\n`);
    stopOnSignals(options);
    const result = options.goal === "" ? await walk(options as WalkOptions) : await run(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return EXIT[result.status];
  }
  if (argv.length > 0) throw new UsageError(`unknown command ${argv[0]}`);
  process.stderr.write(USAGE);
  return 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  if (error instanceof UsageError) process.stderr.write(USAGE);
  process.exitCode = 1;
}
