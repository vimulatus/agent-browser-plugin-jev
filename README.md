# soab

`soab`, the system one agent browser, is a command that drives a browser for an agent. Give it one goal and it drives the browser there. Give it one policy and it judges what the browser shows and writes the findings to a file. [Jev](https://docs.typesafe.ai) picks every action and answers every question in about 100 ms, so nothing thinks between the steps.

soab drives the browser through the [agent-browser](https://github.com/vercel-labs/agent-browser) binary on PATH. The rest of soab sees the browser only through the `Browser` interface in `src/browser.ts`, so another driver, such as Playwright, plugs in at `openBrowser` without a change to the run, the walk or the policies.

The plan is [issue #1](https://github.com/vimulatus/soab/issues/1).

The `agent-browser-plugin-jev` package on npm is deprecated in favour of `soab`.

## Install

You need Node 20 or newer, the `agent-browser` binary on PATH, and a TypeSafe API key.

```bash
npm install -g soab
soab    # prints the usage
```

From a clone instead:

```bash
git clone https://github.com/vimulatus/soab
cd soab
pnpm install && pnpm build && npm link
```

After a `git pull`, run `pnpm build` again. The linked command runs `dist/`, and only the build writes it.

### The key

```bash
export TYPESAFE_API_KEY=...
```

Export it in the shell that runs `soab`. A policy with no `judge` section asks Jev nothing and needs no key.

## Scopes

soab keeps its state in two scopes, like Claude Code does:

- **global**, `~/.soab/`, for every repo on the machine
- **project**, `./.soab/`, found by walking up from the working directory. It wins over the global scope

```bash
soab init
```

`soab init` makes the current directory a project: it creates `./.soab/` with a `config.json` and an empty `policies/`, and adds `.soab/sessions/` to `.gitignore`, so the rest of `.soab/` can be committed. It prints `{ dir, created }` as JSON. Running it again changes nothing.

`--policy <name>` looks for `<name>.yaml` in three places, and loads the first it finds:

1. the project's `./.soab/policies/`
2. the global `~/.soab/policies/`
3. the policies that ship with soab

So a `./.soab/policies/perf.yaml` replaces the shipped `perf` for that repo, and deleting it brings the shipped one back. A path such as `./checks/mine.yaml` is read as a path.

`config.json` in the project merges over the one in `~/.soab/`, key by key. A string in it can read the environment with `${VAR}`, so the file can be committed with no secret in it. A `${VAR}` that is not set is an error that names it. A run reads `store.maxBytes` from it; `store.type` is always `local` until the remote store arrives.

```json
{ "store": { "type": "local", "maxBytes": 1073741824 } }
```

Each scope keeps its state in a store, under keys like `policies/<policy>.yaml`. The local store, the only one today, keeps each key as a file in the scope directory.

### Storage cap

`store.maxBytes` caps the active scope's store: 1 GiB (`1073741824`) when `config.json` sets none. Before each write into the store, the run evicts the least recently used state until the write fits:

1. run directories, `sessions/<session>/runs/<timestamp>/`, whole, least recently used first
2. then each session's `auth.json`, least recently used first, once no run is left to evict

Never evicted: policies, `config.json`, and the run that is writing, while it runs. A write that does not fit once everything evictable is gone fails the run, with the cap and the size in `reason`; the write does not happen. A running run keeps 4 KiB of the cap free (half the cap, under 8 KiB), so its last `status.json` still lands when the cap stops it. Near the cap, a run rewrites `status.json` in place rather than evict another run to make room for a second copy.

Last use is the store's own record, in `sessions/.used.json`, not file access times, which macOS does not keep reliably. A run is used while it writes, and a sign-in when a run loads it. `soab session reset` deletes through the same path as eviction.

A recording or a screenshot is written by agent-browser, so its size is known only after it lands. The run measures it then: it evicts to fit it, or deletes it and fails. Until a recording stops, it can take the store past the cap by its own size. Only files in the store count: a run under an `--out` outside the store writes uncapped, though the sign-in it saves is still capped, and `--record <file>` lands where it names, relative to the working directory, so it is capped only when that file is in the run directory.

## Run a goal

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix soab)"
soab run "log in as alice@example.com with password secret and open Settings" \
  --url http://127.0.0.1:8765/login.html
```

It prints `{ status, url, steps, actions, findings, snapshot, out, record, recordings, reason, durationMs }` as JSON, and exits 0 when the goal is met, 2 when the run is blocked. `durationMs` is the whole milliseconds the command took, off a monotonic clock.

| Flag | Value | What it does |
|---|---|---|
| `--url` | `<url>` | Opens this page before the first step |
| `--session` | `<name>` | The agent-browser session; default `$AGENT_BROWSER_SESSION` |
| `--max-steps` | `<n>` | Stops after n steps; default 60. `0` judges the page and moves nothing |
| `--out` | `<dir>` | Where the run writes its artifacts; default a new `.soab/sessions/<session>/runs/<timestamp>/`, see [What a run writes](#what-a-run-writes) |
| `--allow` | `<verbs>` | Lets the run `delete`, `send`, `pay`, `publish` or `submit`, comma separated, or `all` |
| `--model` | `<name>` | The System One model; default `jev-latest` |
| `--policy` | `<file>` | The policy to judge with, by path or by name: project, then global, then shipped |
| `--fixtures` | `<file>` | The values a walk types into forms; replaces a built-in key or adds one |
| `--record` | `<file>` | Records the run to this `.webm` or `.mp4`, cursor included |
| `--human` | | Moves the pointer along a curve instead of jumping to each target |
| `--no-handoff` | | Ends the run blocked at a login page instead of opening a window for it |
| `--login-timeout` | `<seconds>` | How long the window stays open for the person to sign in; default 300 |

One step is one request to [System One](https://docs.typesafe.ai/api): a Choice for the operation, one speculative Choice of target per operation, one Choice per typeable field of which span of the goal belongs in that field, a Noul for whether the click is irreversible, and a Noul for whether the page shows the goal's outcome. A page offers at most 20 typeable fields, so one step stays inside the request's token budget. Jev writes no text: a value the goal does not contain cannot be typed, and the run stops instead.

Jev reads the page from its whole accessibility tree, cut at 6000 characters, so it sees the alerts and messages around the controls; the controls it can pick come from the interactive tree. A run ends `done` only on a page that shows the goal's outcome: the page the goal names, a signed-in view, a confirmation, a saved value. Filled fields and a clicked submit are not the outcome. When Jev answers DONE but judges the outcome absent, the run ends `blocked` with `the page does not show the goal's outcome`. Still on the page of the last click, the reason says the page did not move on: `the page did not move on after clicking Verify: it does not show the goal's outcome`, or without the second half when the page reads exactly as it did before the click. A BLOCKED on the page of the last click says the same after its reason. A DONE at 0.5 confidence or less ends `blocked` too.

A goal run with `--policy` judges every page it reaches, before each decision, and writes `findings.json` the way the walk does; the result and `status.json` carry the count and add `findingsFile`, the absolute path of that file. A policy that collects `har` is refused for a goal run, because the HAR needs a reload: judge that page with `--max-steps 0` instead.

### Signing in

A run that cannot act on a page with a password field, because the goal holds no value for it or Jev sees no move, signs in instead of stopping. It tries two things, in this order:

1. **The agent-browser auth vault.** `agent-browser auth list` names the saved profiles and their URLs. A profile saved on the page's origin and path, query aside, is used through `agent-browser auth login <name>`: agent-browser types the credentials, so Jev still writes no text. The step is logged with its value masked. Save one with `agent-browser auth save <name> --url <login url> --username <user> --password-stdin`.
2. **A window for the person.** With no profile for the page, the run closes the headless browser and opens the same session in a window, with `--headed`, on the login page. `status.json` reads `{ "status": "login", "url": ... }`, and stderr says `soab: sign in on the window at <url>`, so the calling agent can tell the person to sign in. This is the path for SSO and 2FA. The run polls the page every second until the person is on a URL that is not the login page, on an origin the run has already been on, with no password field left; an SSO page on the way is not taken for the app. Then the run saves the window's cookies and storage, the window closes, the session opens headless where they landed with that sign-in loaded, and the run goes on from the next step.

`--login-timeout` bounds the wait, 300 seconds by default. When it runs out, the window closes, the session goes back headless to the login page, and the run ends `blocked` with a reason that names it. `--no-handoff` keeps an unattended run out of both paths: it ends `blocked` at the login page with today's reason. A headed window needs a display: on a Linux host without one, agent-browser starts Xvfb, nobody sees the window, and the timeout ends the run.

agent-browser 0.38.1 has no live switch between headed and headless, so each leg is a relaunch. Into the window the run carries nothing; back out, it carries the sign-in through a temp file: `state save` from the window, then `state load <file> --headed false` before the headless `open`. The `--headed false` matters: after a window closes, agent-browser 0.38.1 launches the next browser headed again unless the command names the mode, and the command after that relaunches it headless without what it loaded (#67). The run uses no `--restore`, so it writes nothing under `~/.agent-browser/sessions/`. A recorded run stops the recording before the window and starts it again after, on a second file (`login.webm`, then `login-2.webm`); `recordings` in the result and in `status.json` names every file. A page that shows its login form and its app on the same URL is not detected as signed in, and the wait runs out.

A session's sign-in carries to its next run. A goal run and a walk load `sessions/<session>/auth.json` from the store into the browser before its first step, when the file exists, so the second run of a session starts signed in and logs no login step. The run writes the file with agent-browser's `state save`: from the window, as soon as the person has signed in there, and that same file is what the run loads to go on headless; and again when a goal run ends `done`. A run that ends `blocked` leaves the file as it was. The file holds the session's cookies and storage as plain JSON, in `./.soab/` when the repo has one, else in `~/.soab/`, which `soab init` keeps out of git. It never lands in the run directory.

### Recording

```bash
soab run "log in as alice@example.com with password secret and open Settings" \
  --url http://127.0.0.1:8765/login.html --record ./login.webm --human
```

`--record` starts `record start <file> --cursor` once the start page is open and stops it after the last step, and the result names the file. `--human` sets `--input-mode human` on every agent-browser call and clicks with `--human`, so the pointer eases from target to target. Neither flag sleeps: agent-browser's own movement timing sets the pace. Recording needs ffmpeg on PATH, and `agent-browser doctor` says whether you have it.

## Judge one page

`--max-steps 0` observes the page the session is on, applies the policy once and moves nothing:

```bash
agent-browser --session soab-check open http://127.0.0.1:8765/orders.html
soab run --policy perf --max-steps 0 --session soab-check
```

It prints `{ findings, inferred, durationMs }`: the findings the rules raised, the path of the file holding every answer Jev gave, and how long the command took. A policy with no `judge` section prints the findings alone, because it asked nothing. This is the one form that reads `--policy`, `--max-steps`, `--session` and `--out` and nothing else, because it takes no action: `--allow`, `--fixtures`, `--record` and `--human` have nothing to do.

## Walk an app

With a policy and no goal, `run` walks the app on its own: it tries every control it finds once, applies the policy after every step, and writes down what it found.

```bash
soab run --policy bug-hunt --url http://127.0.0.1:8765/ --allow all --max-steps 40
```

It prints `{ status, url, steps, actions, findings, findingsFile, out, record, reason, durationMs }` as JSON. `findingsFile` is the absolute path of `findings.json`, so an agent opens it without knowing the layout of `out`.

Each step is one Jev request of its own: `next_element`, a Choice over the controls on this page the walk has not tried yet; a Choice per editable field for the fixture value that belongs in it; and `action_is_destructive` for whatever it picks. A page that leaves one untried control is taken without a question.

The frontier holds one entry per page path, role and label, so the same button on two pages is two entries and the same button under two query strings is one. When a page has nothing untried left the walk opens the page of the oldest entry still pending, and when nothing is pending it stops. `--max-steps` is the budget. The walk never leaves the origin it started on: a control that navigates away is undone by reopening the start page. `--allow` gates the irreversible controls exactly as a goal run does, and a control Jev calls destructive without it is marked tried and never activated.

A policy that collects `har` cannot walk, because a HAR is recorded over a reload of the page. Judge one page with `--max-steps 0` instead.

### Test data

An editable field is filled from a fixture dictionary. The built-in keys are `email`, `password`, `name`, `phone` and `address`. `--fixtures <file>` takes a YAML mapping that replaces a key or adds one:

```yaml
email: qa@acme.test
company: Acme Ltd
```

Jev picks the key per field, with a `NONE` option for a field no value fits. Nothing is typed unless the chosen key is over 0.5, and every field left empty lands in `unfilled.json` with its label and its page.

### The replay behind a finding

A new finding is reproduced on the spot. The walk takes the last three actions before it from `steps.jsonl` and replays them on a fresh tab from the page it started on, under `record start <out>/evidence/<n>.webm --cursor`, with a screenshot after each act has finished loading. Each action is found again by its role and its label, because a ref dies with its snapshot, and each field gets the same fixture value the walk typed, the real one rather than the mask `steps.jsonl` keeps. If the policy raises the same title on the page the replay lands on, the finding carries `reproduced: true`, its `repro` actions, its `recording`, and the `console` and `errors` lines that page printed. If the page no longer offers the control, or the policy stays quiet, the finding is kept with `reproduced: false`.

The replay runs on a session named `<session>-repro`, so it disturbs nothing the walk holds: its own recording, its own active tab, its own refs. Before each replay the walk saves its cookies and storage to `<out>/state.json` with `state save`, and the replay loads them before it opens the start page, so a finding past a login is reached logged in. It is closed when the walk ends, and every act in it is human-paced whether or not the walk is: the recording is evidence someone watches. It needs ffmpeg on PATH.

## Policy files

A policy is a YAML file with four sections under an optional `name`. `--policy` takes a path, or a name it looks up in `./.soab/policies/`, then `~/.soab/policies/`, then among the policies that ship with the package.

### collect

What to gather at every step. Every name a rule or a question reads has to be collected, or the policy is refused when it loads.

| Name | What it gathers |
|---|---|
| `console` | Every console message, split into `console.messages`, `console.errors` and `console.warnings` |
| `errors` | The errors the page threw |
| `requests` | The requests the page made, without their duration |
| `snapshot` | The page's controls, its URL and its title |
| `content` | The whole page text, so Jev reads the banners and labels `snapshot` drops |
| `har` | One HAR over a reload, so every request carries `time` in ms |

### measure

Jev does not compare numbers, so code buckets them. Each name maps bucket names to ranges, and a fact falls into the first bucket whose range holds it. A range is `<n`, `<=n`, `>n`, `>=n` or the inclusive `a-b`.

| Name | What it reads | Needs |
|---|---|---|
| `http_status` | The status of each request | `requests` or `har` |
| `latency` | The duration of each request, in ms | `har` |
| `page_unchanged_after_click` | `1` when the click left the page as it was, `0` when it changed it | `snapshot`, and a walk to click |

```yaml
measure:
  latency: { good: "<200", ok: "200-1000", bad: ">1000" }
```

A fact no bucket holds has no value, and a rule that compares it does not fire.

### judge

The questions Jev answers. `over` says what each question runs over, one question per item, all of them in one request:

- `page`, once per step.
- `request`, once per request collected.
- `element`, once per control on the page.
- `finding`, once per finding the rules raised, after they have raised them.

A `choice` answers with one of its `criteria`, which need at least two options. A `noul` answers with a probability between 0 and 1 and takes no criteria. `instructions` can name what the browser showed with `{{ }}`, and a question over one scope cannot name another: a question `over: request` cannot read `{{element.label}}`.

`over: finding` is read as the severity of every finding, so it only works under the name `severity`, only as a `choice`, and one criterion per level. A policy that judges `severity` forbids its rules to set one, and a policy that does not judge it makes every rule set one.

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
```

### report

The rules that turn all of it into findings. `when` decides, `title` names the finding, and `severity` grades it unless `judge` does.

`when` compares a measured bucket, a judged answer or anything collected. `==` and `!=` take a bucket name, a criterion, a quoted string or a number, and a name that is neither a bucket nor a criterion of that question is refused when the policy loads. `<`, `<=`, `>` and `>=` need numbers on both sides, which is how you read a noul. Combine with `not`, `and`, `or` and parentheses, in that precedence. `errors.any` is true when the list holds something, and `console.errors[0].text` reads into it.

`title` is text with `{{ }}` placeholders on the same paths. The paths a rule names decide what it runs over: name `request.method` and the rule fires once per request, name `element.label` and it fires once per element, name neither and it fires once per page. A rule cannot name a request and an element at once.

```yaml
report:
  - when: latency == bad and request_kind == content_for_this_page
    title: "{{request.method}} {{request.path}} took {{request.time}} ms"
    severity: high
  - when: stuck_loading > 0.7
    title: "{{page.url}} is still loading"
    severity: medium
```

### The policies that ship

| `--policy` | What it finds |
|---|---|
| `errors` | A request that returned 500 or worse, an error the page threw, an error it logged. It asks Jev nothing, so it needs no key. `errors.yaml` |
| `perf` | A request slower than a second that the page needs, told apart from a slow beacon or third party, and a page still showing a spinner. `perf.yaml` |
| `bug-hunt` | A control that does nothing or does the wrong thing, a 500, an error shown to the user, a page stuck loading. It judges the severity of each finding itself. `bug-hunt.yaml` |

## From an agent

An agent runs `soab` like any other command and reads one JSON line from stdout when it ends. A run blocks until it is done, blocked or failed, so an agent that wants to go on meanwhile starts it in the background.

Two lines go to stderr while the run is in flight:

| Line | When |
|---|---|
| `soab: writing to <out>` | At the start. `<out>/status.json` reports the run from then on |
| `soab: sign in on the window at <url>` | The run opened a window for a login. Tell the person to sign in there |

`status` in `status.json` is `running`, `login`, `done`, `blocked` or `failed`.

## What a run writes

Everything lands in `--out`. When you name none, every run, the walk and `--max-steps 0` included, gets a new directory under its session:

```
./.soab/sessions/<session>/runs/<timestamp>/     when ./.soab/ exists here or in a parent directory
~/.soab/sessions/<session>/runs/<timestamp>/     otherwise
```

A second run of the same session adds a directory beside the first, and the names sort in the order the runs started. The session's sign-in sits beside `runs/` as `auth.json`, see [Signing in](#signing-in). `soab init` keeps `.soab/sessions/` out of git. The result and `status.json` both carry the path.

To start a session clean:

```bash
soab session reset checkout
```

It closes the agent-browser session named `checkout`, so its browser holds no sign-in, then deletes `sessions/checkout/` from the active scope's store: every run and the saved `auth.json`. Last it deletes the sign-in agent-browser saved for a login handoff, `~/.agent-browser/sessions/checkout-checkout.json` (or `.json.enc`, under `namespaces/<ns>/state/` when `AGENT_BROWSER_NAMESPACE` is set). Other sessions, `checkout-repro` included, are left alone. It prints `{ session, deleted }` as JSON, where `deleted` lists the directory and each file it removed, and is empty when the session had nothing to delete; stderr says the same in words. It exits 0 either way.

| File | What is in it |
|---|---|
| `status.json` | `{ status, goal, url, steps, actions, out, record, model, reason, startedAt, updatedAt, durationMs }`, rewritten at every step. `durationMs` grows while the run is `running` and holds still once it ends. A goal run adds `recordings`. A walk sets `goal` to null and adds `policy`, `findings`, `findingsFile` and `unfilled`; a goal run with `--policy` adds the same `findingsFile` |
| `state.json` | The walk's cookies and storage, saved before each replay for the `-repro` session to load |
| `observed.jsonl` | The page at every step: its URL, its controls, its console, its errors, its requests |
| `inferred.jsonl` | One line per decision on a goal run: the operation, the target, the value, whether it ran, and every probability behind it. One line per answer when a policy judges: the question, what it ran over, the item and the answer |
| `findings.json` | What a walk found, below |
| `evidence/` | `<n>.webm` and `<n>-<step>.png` per finding, from the replay |
| `frontier.json` | Every control the walk has seen, with `tried` |
| `unfilled.json` | `{ label, url }` for each field no fixture value fitted |
| `steps.jsonl` | One line per walk step: the control, the value, whether it ran and why not |
| `worker.log` | What the run printed when the protocol started it |

`findings.json` holds `{ findings, summary }`: every finding in the order the walk raised them, then `{ title, severity, where }` for each, for an agent to read first.

```json
{
  "title": "Clicking Save on /orders.html does nothing",
  "severity": "high",
  "where": "http://127.0.0.1:8765/orders.html",
  "step": 2,
  "evidence": { "element": { "index": "1", "role": "button", "label": "Save" } },
  "repeats": [{ "step": 7, "where": "http://127.0.0.1:8765/orders.html?page=2" }],
  "reproduced": true,
  "repro": [
    {
      "action": "click \"Save\"",
      "url": "http://127.0.0.1:8765/orders.html",
      "screenshot": "<out>/evidence/1-1.png"
    }
  ],
  "recording": "<out>/evidence/1.webm",
  "console": ["error: TypeError: order is not defined"],
  "errors": []
}
```

`severity` is null when the policy sets none. `step` is the step the walk was on when the policy saw it, so the lines of `steps.jsonl` below that number are the actions that led there. A finding the policy raises again is not added twice: a `same_as_finding_<k>` Noul runs against every finding so far, and over 0.8 the new sighting joins `repeats` instead.

## Checked by hand

The test suite replays recorded Jev answers and never calls the paid API, so the checks below are the ones that prove the real thing. Each needs a real `TYPESAFE_API_KEY`, a local fixture site and an agent-browser session of its own.

| Check | The command | Run for real |
|---|---|---|
| A goal run reaches its page | `run "log in as alice@example.com with password secret and open Settings" --url .../login.html` | Yes. Four actions, `status: "done"`, ending on `/settings.html` |
| A policy judges one page | `run --policy bug-hunt --max-steps 0 --session <name>` on a page that fetches a 500 and shows a banner | Yes, with `errors`, `perf` and `bug-hunt` on that page. `bug-hunt` raised two findings, and `inferred.jsonl` shows the probabilities behind them |
| A walk tries every control | `run --policy bug-hunt --url .../login.html --allow all --max-steps 12` | Yes. Three frontier entries, all tried, one finding, stopped inside the budget |
| A walk reproduces what it finds | the same, with ffmpeg on PATH | Yes. Three findings, two reproduced with a `.webm` and a screenshot each |
| A recording of a goal run | `run "<goal>" --record ./login.webm --human` | No. `--input-mode human`, `record start --cursor` and `click --human` were checked against agent-browser 0.38.1 without Jev, and gave a playable VP8 `.webm` with a cursor that eases between targets |
| A login handed to a window | `run "open the settings page" --url <a login page>`, then sign in on the window | No. The handoff itself ran against agent-browser 0.38.1 without Jev, on a local page that sets a cookie and a localStorage key, with a script in the person's place opening the signed-in page on the window's session: `close`, `open <url> --headed`, the poll saw them land, `state save`, `close`, `state load <file> --headed false`, `open <landed>`, and every command after that reused the one headless browser, on the landed page with the cookie and the key (#67). Earlier, the first read after a relaunch threw `SecurityError` until a `wait --load` ran first. The poll has not run against a real login page, and no person has signed in on the window |
| A sign-in carries to the next run | a goal run that signs in on a real login page, then a second run of the same `--session` | No. `state save` from a signed-in browser, then `state load` before the first `open` of a fresh session, were checked against agent-browser 0.38.1 without Jev, and carried a cookie and a localStorage key. No safe real login page was at hand, and a run with Jev in the loop needs a paid key |

The Jev answers under `test/replay/` are written by hand to the response shape the [API page](https://docs.typesafe.ai/api) documents, not recorded from a paid call. Replace a file with a real recording when a key is at hand; the tests read the same fields either way.

### Pages that block a run

`test/site/` holds one static page per blocker a goal run can hit: one-time codes in five shapes, a magic link, a push approval, a form missing values, a captcha, a typed delete confirmation, a 500, a 429, an identifier-first login, and an article with a newsletter box as a control. Each page's source states the value it accepts. The replay tests do not use them. Serve them on a free port and run one:

```bash
node test/site/serve.mjs 8792
soab run "sign in with one-time code 123456" --url http://127.0.0.1:8792/otp-single.html --session lab-otp --no-handoff --max-steps 6
```

`http://127.0.0.1:8792/` lists every page.

### A page for the perf policy

`perf.yaml` has to tell a slow request the page needs from a slow request it does not. Save this outside the repo and run it:

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

```bash
agent-browser --session soab-perf open http://127.0.0.1:8791/index.html
soab run --policy perf --max-steps 0 --session soab-perf
```

Expect one finding, `GET /api/products took 2501 ms`, and nothing about the beacon. The file at `inferred` says why: `/api/products` is `content_for_this_page`, the beacon is `analytics`.
