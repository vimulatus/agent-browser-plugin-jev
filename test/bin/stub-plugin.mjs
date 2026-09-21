#!/usr/bin/env node
// The plugin bin as the jev.run tests need it: the protocol entry, and the worker jev.run spawns.
// As the worker it records its argv, then ends the way STUB_DELAY_MS and STUB_FAIL ask;
// STUB_LOGIN_MS makes it open a window for a login first, the way a run does.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answer } from "../../dist/protocol.js";

function status(out, state, url = "http://127.0.0.1:8765/settings.html") {
  writeFileSync(join(out, "status.json"), JSON.stringify({ status: state, out, steps: 2, url }));
}

if (process.argv[2] === "run") {
  const argv = process.argv.slice(2);
  const out = argv[argv.indexOf("--out") + 1];
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "argv.json"), JSON.stringify(argv));
  if (process.env.STUB_FAIL === "1") {
    process.stderr.write("the worker died before the first step\n");
    process.exit(1);
  }
  status(out, "running");
  if (process.env.STUB_LOGIN_MS !== undefined) {
    setTimeout(() => {
      status(out, "login", "http://127.0.0.1:8765/login.html");
    }, Number(process.env.STUB_LOGIN_MS));
  }
  setTimeout(() => {
    status(out, "done");
  }, Number(process.env.STUB_DELAY_MS ?? 0));
} else {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(JSON.stringify(await answer(Buffer.concat(chunks).toString("utf8"))));
}
