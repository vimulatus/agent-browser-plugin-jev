# soab

`soab`, the system one agent browser, is a command that drives a browser for an agent. Give it one goal and it drives the browser there. Give it one policy and it judges what the browser shows and writes the findings to a file. [Jev](https://docs.typesafe.ai) picks every action and answers every question in about 100 ms, so nothing thinks between the steps.

soab drives the browser through the [agent-browser](https://github.com/vercel-labs/agent-browser) binary on PATH. The plan is [issue #1](https://github.com/vimulatus/soab/issues/1). The `agent-browser-plugin-jev` package on npm is deprecated in favour of `soab`.

## Install

You need Node 20.18.1 or newer, the `agent-browser` binary on PATH, and a TypeSafe API key.

```bash
npm install -g soab
export TYPESAFE_API_KEY=...
soab    # prints the usage
```

A policy with no `judge` section asks Jev nothing and needs no key. Behind a proxy that adds the key, leave it unset: soab calls through `HTTPS_PROXY`, and a 401 or 403 from it fails the run as a missing key does.

From a clone: `pnpm install && pnpm build && npm link`, and `pnpm build` again after a `git pull`.

To give an agent the skill that teaches it soab: `npx skills add vimulatus/soab`.

## Use

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix soab)"

# reach a page
soab run "log in as alice@example.com with password secret and open Settings" \
  --url http://127.0.0.1:8765/login.html

# judge the page the session is on
soab run --policy perf --max-steps 0

# walk the app and write findings.json
soab run --policy bug-hunt --url http://127.0.0.1:8765/ --allow all --max-steps 40
```

A run blocks until it ends and prints one JSON line on stdout. It exits 0 when done, 1 when it failed, 2 when blocked, 3 when stopped. Its first stderr line is `soab: writing to <out>`, and `<out>/status.json` reports the run while it goes. A blocked run names what stopped it in `blocker`, and `soab resume <session> --value "<label>=<value>"` goes on from that page.

## Docs

- [Goal runs](docs/goal-runs.md): flags, when a run ends, blockers, `resume`, signing in, recording
- [Walks](docs/walks.md): judging one page, walking an app, fixtures, the replay behind a finding
- [Policies](docs/policies.md): the policy file, and the `errors`, `perf` and `bug-hunt` policies that ship
- [State and output](docs/state.md): scopes, `soab init`, run files, `findings.json`, `tail`, `stop`, `soab session reset`, the storage cap
- [Checked by hand](docs/manual-checks.md): what has run with a real key, and the local pages to try it on
