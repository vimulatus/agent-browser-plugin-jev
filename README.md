# soab

`soab` drives a browser for an agent. Give it a goal and it takes the browser there. Give it a policy and it judges what the browser shows and writes the findings to a file. [Jev](https://docs.typesafe.ai) picks every action, so the agent spends no tool calls on navigation.

## Install

Needs Node 20.18.1 or newer and [agent-browser](https://github.com/vercel-labs/agent-browser) on PATH.

```bash
npm install -g soab
export TYPESAFE_API_KEY=...
```

To teach an agent to use it: `npx skills add vimulatus/soab`.

## Use

```bash
# reach a page
soab run "log in as alice@example.com with password secret and open Settings" --url http://localhost:3000/login

# check the current page for errors
soab run --policy errors --max-steps 0

# walk the app for bugs and write findings.json
soab run --policy bug-hunt --url http://localhost:3000/ --max-steps 40
```

A run prints one JSON line and exits 0 when done, 1 when failed, 2 when blocked, 3 when stopped. `soab` with no arguments prints every command and flag.

## Docs

- [Goal runs](docs/goal-runs.md): when a run ends, blockers, `resume`, signing in, recording
- [Walks](docs/walks.md): judging one page, walking an app, test data, evidence
- [Policies](docs/policies.md): writing a policy, and the ones that ship
- [State and output](docs/state.md): `soab init`, run files, `findings.json`, sessions
- [Checked by hand](docs/manual-checks.md): for contributors, what has run for real
