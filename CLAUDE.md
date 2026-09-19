# CLAUDE.md

Load the `coding` skill before you write or edit code.

## Product

An agent-browser plugin. An agent hands it one goal or one policy file, and Jev drives the browser and classifies what it shows, so the agent spends no tool calls on navigation and no thinking time between recorded actions.

**Stage:** skeleton. The map is issue #1 in this repo. #6 built the manifest, `observe()` and the page hash; #7 (`run "<goal>"`) is next.

- **Users** — any agent that runs agent-browser, and the people who run those agents. Today an agent drives it one command at a time and thinks between each one. First user: Vasu's coding agents.
- **Works when** — `agent-browser plugin add vimulatus/agent-browser-plugin-jev` installs it, `agent-browser-plugin-jev run "<goal>"` lands on the goal page from one command, and `run --policy <file>` writes a `findings.json` an agent can turn into a report.
- **Non-goals** — no change to agent-browser core: this speaks the `agent-browser.plugin.v1` protocol and calls the `agent-browser` binary on PATH. No text written by Jev: values come from the goal or a fixture file, because Jev only picks and judges. No destructive action unless the run allows it. Nothing that only one user's skills need.

## Ship

- **Run** — `pnpm install && pnpm build`, then `node dist/main.js` with a plugin envelope on stdin. Needs an installed `agent-browser` binary on PATH; `TYPESAFE_API_KEY` once `run` lands. Register the local build with `agent-browser plugin add ./ --name jev`: it writes `./agent-browser.json` (gitignored), and deleting that file unregisters it, since 0.38.1 has no `plugin remove`.
- **Gate** — `pnpm test`. Tests replay recorded agent-browser output from `test/fixtures/` and recorded Jev responses; they never open a browser or call the paid API.
- **Ship** — `agent-browser plugin add vimulatus/agent-browser-plugin-jev` pulls `main` through `npx -y github:...`, and `prepare` builds `dist/` on that install; no npm publish yet.
