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

It prints `{ status, url, steps, actions, snapshot, out, reason }` as JSON, and exits 0 when the goal is met, 2 when the run is blocked.

| Flag | What it does |
|---|---|
| `--url <url>` | Opens this page before the first step |
| `--session <name>` | The agent-browser session; default `$AGENT_BROWSER_SESSION` |
| `--max-steps <n>` | Stops after n steps; default 60 |
| `--out <dir>` | Where the run writes its artifacts; default a fresh directory under the temp dir |
| `--allow <verbs>` | Lets the run delete, send, pay, publish, submit; or `all` |
| `--model <name>` | The System One model; default `jev-latest` |

One step is one request to [System One](https://docs.typesafe.ai/api): a Choice for the operation, one speculative Choice of target per operation, a Choice of which span of the goal belongs in a field, and a Noul for whether the click is irreversible. Jev writes no text: a value the goal does not contain cannot be typed, and the run stops instead.

The run writes `observed.jsonl` (the page at every step), `inferred.jsonl` (the decision at every step, executed or not) and `status.json` to `--out`.

## Checked by hand

The paid API is never called from the test suite, so one check stays manual. It needs a real `TYPESAFE_API_KEY`.

```bash
# 1. serve a login fixture that asks for an email and a password, and shows Settings after sign-in
# 2. run the goal against it
agent-browser-plugin-jev run "log in as alice@example.com with password secret and open Settings" \
  --url http://127.0.0.1:8765/login.html --session jev-manual
# 3. expect status "done", url ending /settings.html, and three actions in inferred.jsonl
```

This check has not been run yet: no `TYPESAFE_API_KEY` was available when `run` was built.

The replayed Jev answers under `test/replay/` are written by hand to the response shape the [API page](https://docs.typesafe.ai/api) documents, not recorded from a paid call. Replace a file with a real recording when a key is at hand; the tests read the same fields either way.
