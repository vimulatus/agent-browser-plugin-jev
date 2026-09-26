# Walks and one-page judges

A run with `--policy` and no goal judges what the browser shows. `--max-steps 0` judges one page; anything more walks the app. The policy file is described in [Policies](policies.md).

## Judge one page

```bash
soab run --policy perf --url http://127.0.0.1:8765/orders.html --max-steps 0 --session soab-check
```

It opens `--url` when you give one, else stays on the page the session is on, applies the policy once and moves nothing. It prints `{ status, url, findings, findingsFile, inferred, out, durationMs }`: the page it judged, the findings, the absolute path of `findings.json`, the file holding every answer Jev gave, and the run directory. A policy with no `judge` section leaves out `inferred`. It exits 0, and 1 with `status: "failed"` when it could not judge. `--allow`, `--fixtures`, `--record` and `--human` do nothing here. A policy never asks Jev about an `about:` page, so a session that has opened nothing raises no finding.

## Walk an app

```bash
soab run --policy bug-hunt --url http://127.0.0.1:8765/ --allow all --max-steps 40
```

The walk tries every control it finds once, applies the policy after every step, and writes `findings.json`. It prints `{ status, url, steps, actions, findings, findingsFile, out, record, reason, durationMs }`, and exits 0 when done, 2 when a sign-in or a code step blocked it, 3 when it was stopped.

The frontier holds one entry per page path, role and label, so the same button on two pages is two entries and the same button under two query strings is one. When a page has nothing untried left the walk opens the page of the oldest pending entry, and it stops when nothing is pending or `--max-steps` runs out. It never leaves the origin it started on. `--allow` gates irreversible controls as a goal run does: one Jev calls destructive without it is marked tried and never clicked. A control agent-browser refuses to act on is marked tried, with `executed: false` and agent-browser's reason in `steps.jsonl`.

A sign-in or a code step no fixture fills ends the walk `blocked` with a `blocker`, as in [Goal runs](goal-runs.md#when-a-run-is-blocked). `soab resume <session> --value "<label>=<value>"` walks on from that page with the frontier, the findings and the steps it had left, into the same `findings.json`.

A policy that collects `har` cannot walk, because a HAR is recorded over a reload. Judge one page with `--max-steps 0` instead.

## Test data

A walk fills an editable field from a fixture dictionary. The built-in keys are `email`, `password`, `name`, `phone` and `address`. `--fixtures <file>` takes a YAML mapping that replaces a key or adds one:

```yaml
email: qa@acme.test
company: Acme Ltd
```

Jev picks the key per field, with a `NONE` option. Nothing is typed unless the chosen key is over 0.5, and every field left empty lands in `unfilled.json` with its label and its page.

## The replay behind a finding

A new finding is reproduced on the spot. The walk replays the last three actions before it on a second session, `<session>-repro`, from the page it started on, with the walk's cookies and storage loaded, recording to `<out>/evidence/<n>.webm` with a screenshot after each act. If the policy raises the same title where the replay lands, the finding carries `reproduced: true`, its `repro` actions, its `recording`, and the page's `console` and `errors`. Otherwise it is kept with `reproduced: false`, plus `evidenceMissing` when the replay itself failed. The replay is always human-paced and needs ffmpeg on PATH.

A finding the policy raises again is not added twice: a `same_as_finding_<k>` Noul over 0.8 adds the new sighting to `repeats` instead.
