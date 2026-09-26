# State and output

## Scopes

soab keeps its state in two scopes:

- **project**, `./.soab/`, found by walking up from the working directory. It wins over the global scope
- **global**, `~/.soab/`, for every repo on the machine

`soab init` makes the current directory a project: it creates `./.soab/` with a `config.json` and an empty `policies/`, and adds `.soab/sessions/` to `.gitignore`, so the rest of `.soab/` can be committed. It prints `{ dir, created }`. Running it again changes nothing.

`--policy <name>` loads the first `<name>.yaml` it finds in `./.soab/policies/`, then `~/.soab/policies/`, then the shipped policies. A path such as `./checks/mine.yaml` is read as a path.

`config.json` in the project merges over the one in `~/.soab/`, key by key. A string in it can read the environment with `${VAR}`, so the file can be committed with no secret in it; an unset `${VAR}` is an error that names it.

```json
{ "store": { "type": "local", "maxBytes": 1073741824 } }
```

## Where a run writes

Everything lands in `--out`. With none, every run gets a new directory under its session:

```
./.soab/sessions/<session>/runs/<timestamp>/     when ./.soab/ exists here or in a parent directory
~/.soab/sessions/<session>/runs/<timestamp>/     otherwise
```

The session's sign-in sits beside `runs/` as `auth.json`. The result and `status.json` both carry the path, and stderr names it first.

| File | What is in it |
|---|---|
| `status.json` | `{ status, goal, url, steps, actions, out, record, model, reason, startedAt, updatedAt, durationMs }`, rewritten at every step. `status` is `running`, `login`, `done`, `blocked`, `stopped` or `failed`. A goal run adds `recordings`; a walk adds `policy`, `findings`, `findingsFile` and `unfilled` |
| `findings.json` | What the policy found, below |
| `observed.jsonl` | The page at every step: its URL, its controls, its console, its errors, its requests |
| `inferred.jsonl` | Every decision and every Jev answer, with the probabilities behind it |
| `steps.jsonl` | One line per walk step: the control, the value, whether it ran and why not |
| `frontier.json` | Every control the walk has seen, with `tried` |
| `unfilled.json` | `{ label, url }` for each field no fixture value fitted |
| `state.json` | The walk's cookies and storage, for the replay session |
| `evidence/` | `<n>.webm` and `<n>-<step>.png` per finding, from the replay |

## findings.json

`{ findings, summary }`: every finding in the order the run raised it, then `{ title, severity, where }` for each, to read first.

```json
{
  "title": "Clicking Save on /orders.html does nothing",
  "severity": "high",
  "where": "http://127.0.0.1:8765/orders.html",
  "step": 2,
  "evidence": { "element": { "index": "1", "role": "button", "label": "Save" } },
  "repeats": [{ "step": 7, "where": "http://127.0.0.1:8765/orders.html?page=2" }],
  "reproduced": true,
  "repro": [{ "action": "click \"Save\"", "url": "http://127.0.0.1:8765/orders.html", "screenshot": "<out>/evidence/1-1.png" }],
  "recording": "<out>/evidence/1.webm",
  "console": ["error: TypeError: order is not defined"],
  "errors": []
}
```

`severity` is null when the policy sets none. `step` is the step the policy saw it on, so the lines of `steps.jsonl` before it are the actions that led there. Titles come from the policy's templates; Jev writes no prose.

## Sessions

```bash
soab tail checkout            # follow the newest run's steps from another shell; --json for JSON
soab stop checkout            # stop the running run after its current step
soab session reset checkout   # delete the session's runs and sign-in
```

`soab tail <session>` prints the steps as they land, until the run leaves `running`, then exits 0; `--json` prints each as the JSON object the run logged. A session with no runs exits 1.

`soab stop <session>` prints `{ session, out, stopping }`. Ctrl-C and SIGTERM do the same in the run's own shell; a second Ctrl-C exits at once. The run finishes its step, saves the sign-in, writes `status: "stopped"`, and exits 3 with the browser left on the page, so `soab resume` goes on from there.

`soab session reset <session>` closes the agent-browser session, deletes `sessions/<session>/` from the active scope with its runs and `auth.json`, and deletes the sign-in agent-browser saved for a login handoff. Other sessions, `<session>-repro` included, are left alone. It prints `{ session, deleted }`, empty when there was nothing, and exits 0 either way.

## Storage cap

`store.maxBytes` caps the active scope's store, 1 GiB by default. Before each write the run evicts the least recently used state until the write fits: whole run directories first, then sign-ins. Policies, `config.json` and the run that is writing are never evicted. A write that does not fit once everything evictable is gone fails the run, with the cap and the size in `reason`.

Recordings and screenshots are measured after agent-browser writes them, so a recording in progress can take the store past the cap by its own size. Only files in the store count: an `--out` outside it, or a `--record` file outside the run directory, is not capped.
