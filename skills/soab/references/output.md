# What a run prints and writes

## Results on stdout

| Form | Prints |
|---|---|
| Goal run, `resume` | `{ status, url, steps, actions, findings, snapshot, out, record, recordings, reason, durationMs }`, plus `blocker` when blocked and `findingsFile` with `--policy` |
| `--max-steps 0` | `{ status, url, findings, findingsFile, inferred, out, durationMs }`, with `findings` as a list |
| Walk | `{ status, url, steps, actions, findings, findingsFile, out, record, reason, durationMs }`, plus `blocker` when blocked |

`blocker` is `{ kind, fields, reason }`, with `fields` a list of `{ ref, label }` and `retryAfter` on a `rate_limit`. `findingsFile` is an absolute path. `durationMs` is whole milliseconds.

`status` in `status.json` is `running`, `login`, `done`, `blocked`, `stopped` or `failed`.

## Files in `<out>`

With no `--out`, a run writes to `.soab/sessions/<session>/runs/<timestamp>/` under `./.soab/` when the repo has one, else `~/.soab/`.

| File | Holds |
|---|---|
| `status.json` | The run's state, rewritten every step |
| `findings.json` | `{ findings, summary }` |
| `observed.jsonl` | The page at every step |
| `inferred.jsonl` | Every decision and Jev answer, with probabilities |
| `steps.jsonl` | Each walk step: the control, the value, whether it ran and why not |
| `frontier.json` | Every control a walk has seen, with `tried` |
| `unfilled.json` | Fields no fixture value fitted |
| `evidence/` | `<n>.webm` and `<n>-<step>.png` per reproduced finding |

## A finding

`summary` is `{ title, severity, where }` per finding. Each entry of `findings` adds:

- `step`: the step the policy saw it on; `steps.jsonl` before it is how the walk got there
- `evidence`: what the rule fired on, such as the element or the request
- `repeats`: later steps that saw the same thing
- `reproduced`, `repro` (each replayed action with its screenshot), `recording`, `console`, `errors`: from the replay on `<session>-repro`
- `evidenceMissing`: why a replay left no evidence

`severity` is null when the policy sets none.

## Test data for a walk

`--fixtures <file>` is a YAML mapping of values a walk may type, over the built-in keys `email`, `password`, `name`, `phone` and `address`. Jev picks a key per field; a field no value fits lands in `unfilled.json`.
