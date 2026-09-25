#!/usr/bin/env node
import { parseRunArgs, USAGE, UsageError } from "./args.js";
import { NAME } from "./name.js";
import { judgePage, judgePageOptions } from "./policy/index.js";
import { defaultOut, run } from "./run.js";
import { init } from "./scope.js";
import { walk, type WalkOptions } from "./walk.js";

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
  if (argv[0] === "run") {
    const options = parseRunArgs(argv.slice(1));
    if (options.goal === "" && options.policy === undefined) {
      throw new UsageError('run needs a goal or a policy: run "<goal>", or run --policy <file>');
    }
    if (options.out === "") options.out = defaultOut();
    process.stderr.write(`${NAME}: writing to ${options.out}\n`);
    if (options.goal === "") {
      process.stdout.write(`${JSON.stringify(await walk(options as WalkOptions))}\n`);
      return 0;
    }
    const result = await run(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "done" ? 0 : 2;
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
