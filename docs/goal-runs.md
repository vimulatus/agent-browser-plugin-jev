# Goal runs

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix soab)"
soab run "log in as alice@example.com with password secret and open Settings" \
  --url http://127.0.0.1:8765/login.html
```

It prints `{ status, url, steps, actions, findings, snapshot, out, record, recordings, reason, durationMs }` as JSON, and exits 0 when the goal is met, 2 when the run is blocked, 3 when it was stopped. `durationMs` is the whole milliseconds the command took, off a monotonic clock. A blocked run adds `blocker`, see [When a run is blocked](#when-a-run-is-blocked).

| Flag | Value | What it does |
|---|---|---|
| `--url` | `<url>` | Opens this page before the first step |
| `--session` | `<name>` | The agent-browser session; default `$AGENT_BROWSER_SESSION` |
| `--max-steps` | `<n>` | Stops after n steps; default 60. `0` judges the page and moves nothing |
| `--out` | `<dir>` | Where the run writes; default a new `.soab/sessions/<session>/runs/<timestamp>/`, see [State and output](state.md) |
| `--allow` | `<verbs>` | Lets the run `delete`, `send`, `pay`, `publish` or `submit`, comma separated, or `all` |
| `--model` | `<name>` | The System One model; default `jev-latest` |
| `--policy` | `<file>` | The policy to judge with, by path or by name: project, then global, then shipped |
| `--fixtures` | `<file>` | The values a walk types into forms; replaces a built-in key or adds one |
| `--record` | `<file>` | Records the run to this `.webm` or `.mp4`, cursor included |
| `--human` | | Moves the pointer along a curve instead of jumping to each target |
| `--no-handoff` | | Ends the run blocked instead of signing in with a saved auth profile or opening a window for a captcha |
| `--login-timeout` | `<seconds>` | How long the window stays open for the person; default 300 |
| `--quiet` | | Prints no line per step on stderr |

## How a step works

One step is one request to [System One](https://docs.typesafe.ai/api): a Choice for the operation, one Choice of target per operation, one Choice per typeable field of which span of the goal belongs in it, a Noul for whether the click is irreversible, and a Noul for whether the page shows the goal's outcome. Jev writes no text: a value the goal does not contain cannot be typed, and the run stops instead. Jev reads the whole accessibility tree, cut at 6000 characters; a page offers it at most 20 typeable fields.

A code split over single-character boxes gets one character per box: when the picked field is the first of a row of adjacent fields with `maxlength` 1, one per character, the run fills them in order.

## When it ends

A run ends `done` only on a page that shows the goal's outcome: the page the goal names, a signed-in view, a confirmation, a saved value. Filled fields and a clicked submit are not the outcome. It ends `blocked`:

- when Jev answers DONE but judges the outcome absent, or answers DONE at 0.5 confidence or less. Still on the page of the last click, `reason` says the page did not move on: `the page did not move on after clicking Verify: it does not show the goal's outcome`;
- at the first click Jev judges irreversible whose verb is not in `--allow`: `delete is destructive and not in --allow: did not click Delete`;
- after three steps in a row that leave the page unchanged, WAITs included: `the page did not change after 3 WAITs in a row`.

A value typed into a field that takes a secret never lands in the run's files or on stdout. A password field is one, and Jev judges the rest with a `field_is_secret` Noul: a one-time code, a PIN, a card number or a government ID. The run writes `•••` for that value everywhere it would appear. The one leak this cannot close is the goal on your command line, in your shell history.

A goal run with `--policy` judges every page it reaches and writes `findings.json` the way a walk does; the result adds `findingsFile`. A policy that collects `har` is refused for a goal run: judge that page with `--max-steps 0`, see [Walks](walks.md).

## When a run is blocked

A blocked run's result, and its `status.json`, carry `blocker`:

```json
"blocker": { "kind": "otp", "fields": [{ "ref": "e25", "label": "Verification Code" }], "reason": "the goal holds no value for Verification Code" }
```

| `kind` | The page |
|---|---|
| `otp` | Asks for a one-time code |
| `sign_in` | Asks the user to sign in: an email, a password, or a link sent by email |
| `approval` | Waits for the user to approve on another device |
| `captcha` | Asks the user to prove they are a person |
| `missing_value` | Has a form that needs values the goal does not hold |
| `permission` | Offers a click the run refused as destructive, not in `--allow` |
| `error_page` | Shows a server error; the page's document request returned 5xx |
| `rate_limit` | Says there were too many requests; adds `retryAfter` in seconds when the page sent `Retry-After` |
| `unknown` | Stops the goal some other way, or Jev is unsure what stops it |

`fields` lists every empty field the goal holds no value for when the kind is `otp`, `sign_in` or `missing_value`, and is empty for the others. After a wrong code no field is empty, so `fields` names every field on the page, to be typed again.

A `captcha` or an `approval`, or a `sign_in` with nothing in the goal to type such as a magic-link page, ends the run at that step with nothing clicked, because each act there counts as an attempt on a real app. `error_page` and `rate_limit` are read from the network before Jev is asked anything. The kind costs no extra call: every step asks Jev a `blocker_kind` Choice, logged in `inferred.jsonl` as `blockerProbabilities`.

## Resume a blocked run

A blocked run leaves the session's browser open on the page it stopped at:

```bash
soab run "sign in and open my invoices" --url https://app.example.com --session checkout
# exits 2: {"status":"blocked","blocker":{"kind":"otp","fields":[{"ref":"e25","label":"Verification Code"}],...}}
soab resume checkout --value "Verification Code=482913"
# exits 0: {"status":"done",...}
```

`soab resume <session>` reads the session's last run, which must have ended `blocked` or `stopped`, and goes on in the same browser from that page with its goal, `--allow`, model and the steps it had left. It prints one JSON line and exits like `run`.

| Flag | Value | What it does |
|---|---|---|
| `--value` | `"<label>=<value>"` or `<value>` | Types the value into the field of that label, as `blocker.fields` names it; bare, into the only field. Repeatable |
| `--value-env` | `"<label>=<VAR>"` or `<VAR>` | The same, read from the environment variable, out of shell history |
| `--value-file` | `"<label>=<path>"` or `<path>` | The same, read from the file, trimmed |
| `--allow` | `<verbs>` | Adds to the last run's allow list, so after a `permission` block it makes the click the run refused |
| `--open` | `<url>` | Opens this link in the session's browser first, for a magic-link sign-in |

With no value it looks at the page again and goes on: that covers a push approval and a retry after a 429. A label the blocker did not name, or a session whose last run is neither blocked nor stopped, exits 1 and names the problem. Every value `resume` receives is masked in every file and on stdout. It writes a new run directory under the same session, whose `status.json` names the run it went on from as `resumedFrom`.

## Signing in

A sign-in the goal holds no password for ends `blocked` with `kind: "sign_in"`, and the agent asks its person for the fields and goes on with `soab resume`. Two cases go another way first, unless `--no-handoff` is set:

1. **A saved auth profile.** A profile from `agent-browser auth list` saved on the page's origin and path is used through `agent-browser auth login <name>`, so agent-browser types the credentials and Jev still writes none. Save one with `agent-browser auth save <name> --url <login url> --username <user> --password-stdin`.
2. **A captcha, or a page Jev cannot name, in a window.** Only when stdin is a terminal, `CI` is unset, and on Linux `DISPLAY` or `WAYLAND_DISPLAY` is set. The run reopens the session in a window on that page, `status.json` reads `status: "login"`, and stderr says `soab: the page needs a person, finish it on the window at <url>`. Once the person lands on another URL of an origin the run has seen, with no password field left, the run saves the sign-in, closes the window and goes on headless. `--login-timeout` bounds the wait, 300 seconds by default; when it runs out the run ends `blocked`. A page that shows its login form and its app on the same URL is not detected as signed in, and the wait runs out.

A session's sign-in carries to its next run. The run saves it as `sessions/<session>/auth.json` when the person signs in on the window and when a goal run ends `done`, and a goal run or a walk of the session loads it before its first step. So reuse one `--session` per app and sign in once. The file is plain JSON cookies and storage; `soab init` keeps it out of git.

## Recording

```bash
soab run "log in as alice@example.com with password secret and open Settings" \
  --url http://127.0.0.1:8765/login.html --record ./login.webm --human
```

`--record` records from the start page to the last step, cursor included, and needs ffmpeg on PATH (`agent-browser doctor` says whether it is there). `--human` eases the pointer from target to target. A run that hands a page to a window splits the recording in two, `login.webm` then `login-2.webm`, and `recordings` names every file.
