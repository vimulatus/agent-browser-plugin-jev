#!/usr/bin/env node
import { answer } from "./protocol.js";

const USAGE = `agent-browser-plugin-jev

Speaks agent-browser.plugin.v1 on stdin. Register it with
  agent-browser plugin add vimulatus/agent-browser-plugin-jev
`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const stdin = process.argv.length > 2 ? "" : await readStdin();
if (stdin.trim() === "") {
  process.stderr.write(USAGE);
  process.exit(1);
}
process.stdout.write(JSON.stringify(answer(stdin)));
