---
name: soab
description: Drive a browser to a goal, check a page for errors or slow requests, or walk a web app for bugs with repro evidence, using the soab command. Use when a task needs a browser taken through several steps to a page, a page judged against a policy, or a bug hunt with recordings. Not for one browser command, which agent-browser runs on its own.
---

# soab

Run the whole task as one `soab` command instead of stepping the browser yourself. `soab` with no arguments prints every command and flag. If it is missing: `npm install -g soab`.

| The task | Command |
|---|---|
| Reach a page or finish a flow | `soab run "<goal>" --url <start>` |
| Check one page | `soab run --policy <policy> --max-steps 0 [--url <url>]` |
| Hunt for bugs | `soab run --policy bug-hunt --url <start> --max-steps 40` |

Shipped policies: `errors` (5xx, page and console errors), `perf` (slow requests the page needs; one page only), `bug-hunt`. For anything else, write a policy with [references/policies.md](references/policies.md).

## Before you run

- Put every value to type in the goal: soab types nothing the goal does not contain. Leave real passwords out, since the goal lands in shell history; give them to `resume` instead.
- Reuse one `--session` per app. It keeps its sign-in, so your person signs in once.
- Pass `--allow <verbs>` (`delete`, `send`, `pay`, `publish`, `submit`, `all`) only for actions your person agreed to.
- Start a long walk in the background. Stderr's first line names `<out>`; `<out>/status.json` shows progress.

## When it blocks

Exit 2 means blocked, and the result carries `blocker: { kind, fields, reason }`. `soab resume <session>` goes on from the same page.

| `kind` | Do |
|---|---|
| `otp`, `sign_in`, `missing_value` | Ask your person for each label in `fields`, then `resume` with `--value-env "<label>=<VAR>"` or `--value "<label>=<value>"` |
| `sign_in` on a page that emails a link | Ask for the link, then `resume --open <url>` |
| `approval` | Ask your person to approve, then `resume` |
| `permission` | Ask whether the refused action is wanted; on yes, `resume --allow <verb>` |
| `rate_limit` | Wait `blocker.retryAfter` seconds, then `resume` |
| `captcha`, `error_page`, `unknown` | Tell your person the `reason`; `resume` once they have dealt with it |

If stderr says `the page needs a person, finish it on the window at <url>`, pass that on; the run waits.

## Report findings

A policy run writes `findings.json` at `findingsFile`. Read `summary` first. For each finding give its title, severity, where, whether it `reproduced`, and its `recording` and screenshots. Keep the policy's titles; do not claim more than the evidence shows. Field details are in [references/output.md](references/output.md).
