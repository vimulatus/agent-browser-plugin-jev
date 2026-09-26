---
name: soab
description: Drive a browser to a goal, check a page for errors or slow requests, or walk a web app for bugs with repro evidence, using the soab command. Use when a task needs a browser taken through several steps to a page, a page judged against a policy, or a bug hunt with recordings. Not for one browser command, which agent-browser runs on its own.
---

# soab

`soab` drives a browser from one goal or one policy file and prints one JSON line when it ends. Jev picks every action, so run it as one command rather than stepping the browser yourself. `soab` with no arguments prints every command and flag.

It needs `soab` and `agent-browser` on PATH, and `TYPESAFE_API_KEY` unless `HTTPS_PROXY` points at a proxy that adds it. If `soab` is missing, `npm install -g soab`. A run with no key fails at once with `status: "failed"`.

## Pick the form

| The task | Command |
|---|---|
| Reach a page or finish a flow | `soab run "<goal>" --url <start>` |
| Check the page the session is on, or one URL | `soab run --policy <policy> --max-steps 0 [--url <url>]` |
| Hunt for bugs across an app | `soab run --policy bug-hunt --url <start> --max-steps 40` |

The shipped policies are `errors` (5xx, page errors, console errors; needs no key), `perf` (slow requests the page needs; one page only) and `bug-hunt` (a walk with severity). To check something they do not, write a policy: read [references/policies.md](references/policies.md) first.

## Write the goal

The goal carries every value the run types, because Jev writes no text: "log in as alice@example.com with password secret and open Settings". A value the goal lacks ends the run blocked and names the field. The run masks secrets in its files, but the goal stays in shell history, so leave a real password out of the goal and pass it to `resume` with `--value-env` or `--value-file`.

## Run it

Set one session per app and reuse it: a session keeps its sign-in between runs, so the person signs in once.

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix soab)"
```

Pass `--allow <verbs>` (`delete`, `send`, `pay`, `publish`, `submit`, or `all`) only for actions your person agreed to. Without it the run refuses the click and ends blocked with `kind: "permission"`.

A run blocks until it ends. Start a long walk in the background; the first stderr line names `<out>`, and `<out>/status.json` reports progress. `soab tail <session>` follows it, `soab stop <session>` stops it after its current step.

## Act on the result

Exit 0 is done, 1 failed (`reason` says why), 2 blocked, 3 stopped. A blocked result carries `blocker: { kind, fields, reason }`:

| `kind` | Do |
|---|---|
| `otp`, `sign_in`, `missing_value` | Ask your person for each label in `fields`, then `soab resume <session> --value-env "<label>=<VAR>"` (or `--value "<label>=<value>"`) |
| `sign_in` on a page that emails a link | Ask your person for the link, then `soab resume <session> --open <url>` |
| `approval` | Ask your person to approve on their device, then `soab resume <session>` |
| `permission` | Ask whether the refused action is wanted; on yes, `soab resume <session> --allow <verb>` |
| `rate_limit` | Wait `blocker.retryAfter` seconds when present, then `soab resume <session>` |
| `captcha`, `error_page`, `unknown` | Tell your person what `reason` says; resume only once they have dealt with the page |

`resume` goes on in the same browser from the page the run stopped on, with the goal and the steps left, and exits the same way. A run with a terminal and a display may open a window for a captcha instead of blocking; stderr then says `soab: the page needs a person, finish it on the window at <url>`: pass that on to your person.

## Report findings

A policy run writes `findings.json` at `findingsFile`. Read its `summary` first, then each finding's `evidence`, `repeats`, `reproduced`, `repro` screenshots and `recording`. Report each finding with its title, severity, where, and its evidence files; say whether it reproduced. Titles come from the policy's templates, so do not reword them into claims the evidence does not show.

Result shapes and every file a run writes are in [references/output.md](references/output.md). Read it when you need a field this page does not name.

To start a session clean, `soab session reset <session>` deletes its runs and sign-in.
