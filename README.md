# agent-browser-plugin-jev

An [agent-browser](https://github.com/vercel-labs/agent-browser) plugin. Give it one goal or one policy, and [Jev](https://docs.typesafe.ai) picks each action and classifies what the browser shows.

Install it with `agent-browser plugin add vimulatus/agent-browser-plugin-jev`. The plan is at [issue #1](https://github.com/vimulatus/agent-browser-plugin-jev/issues/1).

## run

```bash
export TYPESAFE_API_KEY=...
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix jev)"
agent-browser-plugin-jev run "log in as alice@example.com with password secret and open Settings" \
  --url http://127.0.0.1:8765/login.html
```

It prints `{ status, url, steps, actions, snapshot, out, record, reason }` as JSON, and exits 0 when the goal is met, 2 when the run is blocked.

| Flag | What it does |
|---|---|
| `--url <url>` | Opens this page before the first step |
| `--session <name>` | The agent-browser session; default `$AGENT_BROWSER_SESSION` |
| `--max-steps <n>` | Stops after n steps; default 60 |
| `--out <dir>` | Where the run writes its artifacts; default a fresh directory under the temp dir |
| `--allow <verbs>` | Lets the run delete, send, pay, publish, submit; or `all` |
| `--model <name>` | The System One model; default `jev-latest` |
| `--record <file>` | Records the run to this `.webm` or `.mp4`, cursor included |
| `--human` | Moves the pointer along a curve instead of jumping to each target |

One step is one request to [System One](https://docs.typesafe.ai/api): a Choice for the operation, one speculative Choice of target per operation, one Choice per typeable field of which span of the goal belongs in that field, and a Noul for whether the click is irreversible. A page offers at most 20 typeable fields, so one step stays inside the request's token budget. Jev writes no text: a value the goal does not contain cannot be typed, and the run stops instead.

The run writes `observed.jsonl` (the page at every step), `inferred.jsonl` (the decision at every step, executed or not) and `status.json` to `--out`.

### Recording the run

```bash
agent-browser-plugin-jev run "log in as alice@example.com with password secret and open Settings" \
  --url http://127.0.0.1:8765/login.html --record ./login.webm --human
```

`--record` starts `record start <file> --cursor` once the start page is open and stops it after the last step, and the result names the file. `--human` sets `--input-mode human` on every agent-browser call and clicks with `--human`, so the pointer eases from target to target. Neither flag sleeps: the CLI's own movement timing sets the pace. Recording needs ffmpeg on PATH — `agent-browser doctor` says whether you have it.

## As a plugin

Once `agent-browser plugin add` has registered it, an agent starts the same run through the protocol:

```bash
agent-browser plugin run jev jev.run --payload '{"goal":"open the settings page","wait":true}'
agent-browser plugin run jev jev.status --payload '{"runId":"jev-run-2f9c1d40aa"}'
```

`jev.run` takes `{ goal, policy, url, session, maxSteps, allow, fixtures, record, human, out, wait }` and starts `run` as a detached worker, so a run outlives agent-browser's 60 s plugin timeout. It answers `{ runId, out, status: "running" }` at once; `wait: true` holds the answer for up to 55 s and returns the run's final status when it ends in time, and `wait: <milliseconds>` holds it for less.

`jev.status` takes `{ runId }` or `{ out }` and answers with the run's `status.json`: `{ status, url, steps, actions, reason, ... }`, where `status` is `running`, `done`, `blocked` or `failed`. A worker that died before writing a status is reported `failed` with the last line of `<out>/worker.log`.

The session comes from the payload, else from `$AGENT_BROWSER_SESSION` in the environment agent-browser passes down. Anything that goes wrong answers `{ success: false, error }`, and nothing but JSON reaches stdout.

## Checked by hand

The paid API is never called from the test suite, so one check stays manual. It needs a real `TYPESAFE_API_KEY`.

```bash
# 1. serve a login fixture that asks for an email and a password, and shows Settings after sign-in
# 2. run the goal against it
agent-browser-plugin-jev run "log in as alice@example.com with password secret and open Settings" \
  --url http://127.0.0.1:8765/login.html --session jev-manual
# 3. expect status "done", url ending /settings.html, and three actions in inferred.jsonl
# 4. record the same run and play the file: the cursor curves from field to field
agent-browser-plugin-jev run "log in as alice@example.com with password secret and open Settings" \
  --url http://127.0.0.1:8765/login.html --session jev-manual --record ./login.webm --human
```

This check has not been run yet. The flags it drives were checked against agent-browser 0.38.1 without Jev, by filling the same fixture through the plugin's own command builder: `--input-mode human`, `record start <file> --cursor` and `click --human` produce a playable VP8 `.webm` with a visible cursor that eases between targets.

The replayed Jev answers under `test/replay/` are written by hand to the response shape the [API page](https://docs.typesafe.ai/api) documents, not recorded from a paid call. Replace a file with a real recording when a key is at hand; the tests read the same fields either way.
## Policies

A policy is a YAML file with four sections. `errors.yaml` and `perf.yaml` ship with the plugin, so `--policy perf` finds one by name.

- `collect` — what to gather: `console`, `errors`, `requests`, `snapshot`, `har`. `har` records one over a reload of the page, so every request the page makes is timed.
- `measure` — the numbers code buckets, because Jev does not compare numbers. `http_status` and `latency` today.
- `judge` — the questions Jev answers.
- `report` — the rules that turn all of it into findings.

`judge` fans each question out over `page`, `request` or `element`: one question per item, all of them in one Jev request. A choice answers with one of its criteria, a noul with a probability, and `report.when` reads either:

```yaml
judge:
  request_kind:
    type: choice
    over: request
    instructions: What does this request fetch for the page the user is looking at?
    criteria:
      content_for_this_page: data the page shows now
      analytics: tracking or telemetry
  stuck_loading:
    type: noul
    over: page
    instructions: Does the page show a spinner or a skeleton with no content in its place?
report:
  - when: latency == bad and request_kind == content_for_this_page
    title: "{{request.method}} {{request.path}} took {{request.time}} ms"
    severity: high
  - when: stuck_loading > 0.7
    title: "{{page.url}} is still loading"
    severity: medium
```

Every answer, with its probabilities, is written to `inferred.jsonl` in the run directory. A policy with no `judge` section never calls Jev and needs no `TYPESAFE_API_KEY`.

## Checking perf.yaml by hand

`perf.yaml` has to tell a slow request the page needs from a slow request it does not. The replay tests prove the fan-out; this proves the judgment. Save this server outside the repo and run it:

```js
import { createServer } from "node:http";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = `<html><head><title>Products</title><script src="/app.js" defer></script></head><body><h1>Products</h1><ul id="list"></ul></body></html>`;
const app = `fetch("/analytics/beacon?event=pageview", { method: "POST" });
fetch("/api/products").then((r) => r.json()).then((p) => { list.innerHTML = p.map((x) => "<li>" + x.name + "</li>").join(""); });`;
createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://127.0.0.1:8791");
  if (pathname === "/app.js") return res.writeHead(200, { "content-type": "application/javascript" }).end(app);
  if (pathname === "/api/products") { await sleep(2500); return res.writeHead(200, { "content-type": "application/json" }).end('[{"name":"Kettle"}]'); }
  if (pathname === "/analytics/beacon") { await sleep(1200); return res.writeHead(204).end(); }
  res.writeHead(200, { "content-type": "text/html" }).end(page);
}).listen(8791, "127.0.0.1");
```

Both requests are slower than a second, so `latency` buckets both as `bad` and only Jev separates them:

```
agent-browser --session perf open http://127.0.0.1:8791/index.html
TYPESAFE_API_KEY=... node dist/main.js run --policy perf --max-steps 0 --session perf
```

One finding, `GET /api/products took 2501 ms`, and nothing about the beacon. `inferred.jsonl` at the path printed under `inferred` shows why: `/api/products` is `content_for_this_page`, the beacon is `analytics`.
