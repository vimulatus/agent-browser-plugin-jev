# What a run prints and writes

A run prints one JSON line with `status`, `url`, `out`, `reason` and `durationMs`. A blocked run adds `blocker`; a policy run adds `findings` and `findingsFile`, the absolute path of `findings.json`. `<out>/status.json` holds the same while the run goes, with `status` one of `running`, `login`, `done`, `blocked`, `stopped`, `failed`.

With no `--out`, a run writes to `.soab/sessions/<session>/runs/<timestamp>/`, under `./.soab/` when the repo has one (`soab init` creates it), else `~/.soab/`.

## findings.json

`{ findings, summary }`, with `summary` one `{ title, severity, where }` per finding. Each finding adds:

| Field | Holds |
|---|---|
| `step` | The step it was seen on; `steps.jsonl` up to it is how the walk got there |
| `evidence` | What the rule fired on, such as the element or the request |
| `repeats` | Later steps that saw the same thing |
| `reproduced` | Whether a replay on `<session>-repro` saw it again |
| `repro` | Each replayed action with its screenshot |
| `recording` | The replay's video |
| `console`, `errors` | What the page logged during the replay |
| `evidenceMissing` | Why a replay left no evidence |

## Other files in `<out>`

`inferred.jsonl` holds every decision with its probabilities, `observed.jsonl` the page at every step, `unfilled.json` the form fields a walk could not fill. Give a walk values to type with `--fixtures <file>`, a YAML mapping over the built-in keys `email`, `password`, `name`, `phone`, `address`.
