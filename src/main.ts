#!/usr/bin/env node
import { parseRunArgs, USAGE, UsageError } from "./args.js";
import { answer } from "./protocol.js";
import { judgePage, judgePageOptions } from "./policy/index.js";
import { defaultOut, run } from "./run.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv: string[]): Promise<number> {
  const judge = judgePageOptions(argv);
  if (judge) {
    process.stdout.write(`${JSON.stringify(await judgePage(judge))}\n`);
    return 0;
  }
  if (argv[0] === "run") {
    const options = parseRunArgs(argv.slice(1));
    if (options.goal === "") throw new UsageError('run needs a goal: run "<goal>"');
    if (options.out === "") options.out = defaultOut();
    const result = await run(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "done" ? 0 : 2;
  }
  if (argv.length > 0) throw new UsageError(`unknown command ${argv[0]}`);
  const stdin = await readStdin();
  if (stdin.trim() === "") {
    process.stderr.write(USAGE);
    return 1;
  }
  process.stdout.write(JSON.stringify(await answer(stdin)));
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  if (error instanceof UsageError) process.stderr.write(USAGE);
  process.exitCode = 1;
}
