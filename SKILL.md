---
name: soab
description: Drive a browser from one goal, or judge what it shows from one policy file, with the `soab` command. Use when a task needs a browser taken to a page, a page checked for errors or slow requests, or an app walked for bugs with evidence. Not for a single browser command, which agent-browser runs on its own.
---

# soab

One command reaches a page. One policy file turns what the browser shows into findings you can report. Jev picks every action and answers every question, so you do not think between the steps.

## Install

```bash
npm install -g soab
```

This puts `soab` on PATH. It needs the `agent-browser` binary on PATH too. From a clone: `pnpm install && pnpm build && npm link`, and `pnpm build` again after a `git pull`.

Export `TYPESAFE_API_KEY` in the shell that runs `soab`. A policy with no `judge` section needs no key. Behind a proxy that adds the key, as in a Claude Code cloud session, leave it unset: soab calls through `HTTPS_PROXY`.

## The three things it does

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix soab)"

# 1. reach a page
soab run "log in as alice@example.com with password secret and open Settings" \
  --url http://127.0.0.1:8765/login.html

# 2. judge the page the session is already on
soab run --policy perf --max-steps 0

# 3. walk the app and write findings.json
soab run --policy bug-hunt --url http://127.0.0.1:8765/ --allow all --max-steps 40
```

The goal carries every value that gets typed: Jev writes no text. A login page the goal cannot fill is signed in another way: through a saved `agent-browser auth` profile for that page when one exists, else in a window the run opens for the person. While the window is open, stderr says `soab: sign in on the window at <url>` and `status.json` reads `status: "login"`: tell the person to sign in there. The run closes the window once they are through and goes on headless, signed in. `--login-timeout` bounds the wait, and `--no-handoff` ends an unattended run blocked at the login page instead. A session's sign-in carries to its next run: the run saves it as `sessions/<session>/auth.json` once the person signs in on the window and when a run ends done, and a goal run or a walk of the session loads it before its first step, so reuse one `--session` per app and sign in once. A goal run does not apply `--policy`; use form 2 or form 3.

| Flag | Value | What it does |
|---|---|---|
| `--url` | `<url>` | Opens this page before the first step |
| `--session` | `<name>` | The agent-browser session; default `$AGENT_BROWSER_SESSION` |
| `--max-steps` | `<n>` | Stops after n steps; default 60. `0` judges the page and moves nothing |
| `--out` | `<dir>` | Where the run writes; default a new `.soab/sessions/<session>/runs/<timestamp>/` |
| `--allow` | `<verbs>` | Lets the run `delete`, `send`, `pay`, `publish` or `submit`, or `all` |
| `--model` | `<name>` | The System One model; default `jev-latest` |
| `--policy` | `<file>` | A path, or a name: `./.soab/policies/`, then `~/.soab/policies/`, then shipped `errors`, `perf`, `bug-hunt` |
| `--fixtures` | `<file>` | YAML values a walk types into forms; built-in keys are `email`, `password`, `name`, `phone`, `address` |
| `--record` | `<file>` | Records to this `.webm` or `.mp4`, cursor included; needs ffmpeg |
| `--human` | | Moves the pointer along a curve instead of jumping |
| `--no-handoff` | | Ends the run blocked at a login page instead of opening a window for it |
| `--login-timeout` | `<seconds>` | How long the window stays open for the person to sign in; default 300 |

## Scopes

`soab init` makes the working directory a project: it creates `./.soab/` with `config.json` and `policies/`, and adds `.soab/sessions/` to `.gitignore`. A second `init` changes nothing. The project scope is the nearest `./.soab/` up from the working directory; the global scope is `~/.soab/`.

`--policy <name>` loads `<name>.yaml` from `./.soab/policies/`, else `~/.soab/policies/`, else the shipped policies. Put a repo's own policy in `./.soab/policies/` and run it by name. A path is read as a path.

`soab session reset <session>` starts a session clean: it closes the agent-browser session of that name and deletes `sessions/<session>/`, its runs and its sign-in, from the active scope, and the sign-in agent-browser saved for that session after a login handoff. It prints `{ session, deleted }`, where `deleted` lists the directory and files it removed and is empty when there was nothing, and exits 0 either way.

`config.json` from the project merges over the global one. `${VAR}` in a string reads the environment; an unset one is an error that names it.

A run blocks until it ends and prints one JSON line on stdout. Its first stderr line is `soab: writing to <out>`, so a run you start in the background is read from `<out>/status.json` meanwhile.

## Write a policy

```yaml
name: my-policy
collect: [console, content, errors, requests, snapshot]
measure:
  http_status: { ok: "<400", client_error: "400-499", server_error: ">=500" }
judge:
  page_shows_error_to_user:
    type: noul
    over: page
    instructions: Does the page show the user an error, a failure, or an empty state where content belongs?
report:
  - when: http_status == server_error
    title: "{{request.method}} {{request.path}} returned {{request.status}}"
    severity: high
  - when: page_shows_error_to_user > 0.7
    title: "{{page.path}} shows the user an error"
    severity: medium
```

**`collect`** takes any of `console`, `errors`, `requests`, `snapshot`, `content` (the whole page text, not only its controls) and `har` (one HAR over a reload, the only source of request timings). Anything a rule or a question reads must be collected, or the policy is refused when it loads. A policy that collects `har` cannot walk: judge one page with `--max-steps 0`.

**`measure`** buckets a number, because Jev cannot compare numbers. The three are `http_status`, `latency` (needs `har`) and `page_unchanged_after_click` (a walk only). A range is `<n`, `<=n`, `>n`, `>=n` or the inclusive `a-b`, and the first bucket that holds the value wins.

**`judge`** asks Jev. `type` is `choice` (answers one of `criteria`, two or more) or `noul` (answers a probability). `over` is `page`, `request`, `element` or `finding`, and the question runs once per item of that scope. `instructions` can name what the browser showed with `{{ }}`, within its own scope. `over: finding` grades findings and only works under the name `severity`, as a choice with one criterion per level; use it, and no rule may set `severity`; skip it, and every rule must.

**`report`** turns it into findings. `when` compares a bucket name, a criterion, a quoted string or a number with `==` and `!=`, a noul with `<`, `<=`, `>`, `>=`, and combines with `not`, `and`, `or` and parentheses. `errors.any` is true when the list holds something. The paths a rule names decide what it runs over: `request.*` fires once per request, `element.*` once per element, neither once per page.

## Read what it wrote

Everything lands in `--out`, named in the result and in `status.json`. With no `--out`, each run of a session gets a new `sessions/<session>/runs/<timestamp>/` in `./.soab/` when the repo has one, else in `~/.soab/`; older runs of the session sit beside it until `store.maxBytes` in `config.json` (1 GiB by default) evicts the least recently used runs, then sign-ins.

- A goal run prints `{ status, url, steps, actions, findings, snapshot, out, record, recordings, reason, durationMs }` and exits 0 when done, 2 when blocked. Done means the page shows the goal's outcome; a run whose page did not move on after its last submit, such as a wrong code, ends blocked and its `reason` says so. So does a run that meets a destructive click not in `--allow`, at the first refusal, or whose page stays unchanged over three steps in a row, WAITs included. `recordings` names every file a `--record` went to: two when a login window split it.
- `--max-steps 0` prints `{ findings, inferred, durationMs }`.
- A walk prints `{ status, url, steps, actions, findings, findingsFile, out, record, reason, durationMs }` and writes `findings.json`; `findingsFile` is its absolute path. A goal run with `--policy` adds the same key.
- `durationMs` is how long the command took, in whole milliseconds. `status.json` carries it too, growing while the run is `running`, so it says how long a run has been going.

`findings.json` is `{ findings, summary }`. Read `summary` first: `{ title, severity, where }` per finding. Each entry of `findings` adds `step`, `evidence`, `repeats` (the later steps that saw the same thing), and, when the walk replayed it, `reproduced`, `repro` (each action with the screenshot of the page it produced), `recording`, `console` and `errors`. Write your report from those fields. Jev writes titles from templates and no prose.

Also in `--out`: `observed.jsonl` (the page at every step), `inferred.jsonl` (every decision and every Jev answer, with probabilities), `steps.jsonl`, `frontier.json` (every control seen, with `tried`), `unfilled.json` (fields no fixture value fitted) and `evidence/`.
