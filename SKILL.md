---
name: jev-browser
description: Drive a browser from one goal, or judge what it shows from one policy file, through the agent-browser plugin agent-browser-plugin-jev. Use when a task needs a browser taken to a page, a page checked for errors or slow requests, or an app walked for bugs with evidence. Not for a single browser command, which agent-browser runs on its own.
---

# Jev over agent-browser

One command reaches a page. One policy file turns what the browser shows into findings you can report. Jev picks every action and answers every question, so you do not think between the steps.

## Install

From any directory, including a bun or yarn project:

```bash
git clone https://github.com/vimulatus/agent-browser-plugin-jev
cd agent-browser-plugin-jev
pnpm install && pnpm build && npm link
```

Then write `~/.agent-browser/config.json`:

```json
{
  "plugins": [
    {
      "name": "jev",
      "command": "agent-browser-plugin-jev",
      "capabilities": ["command.run", "jev.run", "jev.status"]
    }
  ]
}
```

Check it: `agent-browser plugin run jev jev.status --payload '{"runId":"x"}'` answers `no run x`. After a `git pull`, run `pnpm build` again.

`agent-browser plugin add vimulatus/agent-browser-plugin-jev` is the per-project form. It registers `npx -y github:...` in `./agent-browser.json`, which npm refuses to run in a project whose `package.json` pins another package manager through `devEngines` (`EBADDEVENGINES`).

Export `TYPESAFE_API_KEY` in the shell that runs `agent-browser`. A policy with no `judge` section needs no key.

## The three things it does

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix jev)"

# 1. reach a page
agent-browser-plugin-jev run "log in as alice@example.com with password secret and open Settings" \
  --url http://127.0.0.1:8765/login.html

# 2. judge the page the session is already on
agent-browser-plugin-jev run --policy perf --max-steps 0

# 3. walk the app and write findings.json
agent-browser-plugin-jev run --policy bug-hunt --url http://127.0.0.1:8765/ --allow all --max-steps 40
```

The goal carries every value that gets typed: Jev writes no text, so a password the goal does not name cannot be typed and the run stops instead. A goal run does not apply `--policy`; use form 2 or form 3.

| Flag | Value | What it does |
|---|---|---|
| `--url` | `<url>` | Opens this page before the first step |
| `--session` | `<name>` | The agent-browser session; default `$AGENT_BROWSER_SESSION` |
| `--max-steps` | `<n>` | Stops after n steps; default 60. `0` judges the page and moves nothing |
| `--out` | `<dir>` | Where the run writes; default a fresh directory under the temp dir |
| `--allow` | `<verbs>` | Lets the run `delete`, `send`, `pay`, `publish` or `submit`, or `all` |
| `--model` | `<name>` | The System One model; default `jev-latest` |
| `--policy` | `<file>` | A path, or `errors`, `perf` or `bug-hunt` by name |
| `--fixtures` | `<file>` | YAML values a walk types into forms; built-in keys are `email`, `password`, `name`, `phone`, `address` |
| `--record` | `<file>` | Records to this `.webm` or `.mp4`, cursor included; needs ffmpeg |
| `--human` | | Moves the pointer along a curve instead of jumping |

Through the protocol instead of the CLI: `agent-browser plugin run jev jev.run --payload '{"goal":"...","wait":true}'` takes the same options as JSON and answers `{ runId, out, status }`. agent-browser kills a plugin at 60 s, so the run is detached and `wait: true` holds the answer for at most 55 s. `agent-browser plugin run jev jev.status --payload '{"runId":"..."}'` reports it after that. `plugin.manifest` is what `plugin add` reads.

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

Everything lands in `--out`, named in the result and in `status.json`.

- A goal run prints `{ status, url, steps, actions, snapshot, out, record, reason }` and exits 0 when done, 2 when blocked.
- `--max-steps 0` prints `{ findings, inferred }`.
- A walk prints `{ status, url, steps, actions, findings, out, record, reason }` and writes `findings.json`.

`findings.json` is `{ findings, summary }`. Read `summary` first: `{ title, severity, where }` per finding. Each entry of `findings` adds `step`, `evidence`, `repeats` (the later steps that saw the same thing), and, when the walk replayed it, `reproduced`, `repro` (each action with the screenshot of the page it produced), `recording`, `console` and `errors`. Write your report from those fields. The plugin writes titles from templates and no prose.

Also in `--out`: `observed.jsonl` (the page at every step), `inferred.jsonl` (every decision and every Jev answer, with probabilities), `steps.jsonl`, `frontier.json` (every control seen, with `tried`), `unfilled.json` (fields no fixture value fitted) and `evidence/`.
