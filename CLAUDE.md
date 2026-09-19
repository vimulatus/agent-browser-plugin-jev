# CLAUDE.md

Load the `coding` skill before you write or edit code.

## Product

An agent-browser plugin. An agent hands it one goal or one policy file, and Jev drives the browser and classifies what it shows, so the agent spends no tool calls on navigation and no thinking time between recorded actions.

**Stage:** walking. The map is issue #1 in this repo. #6 built the manifest, `observe()` and the page hash; #7 made `run "<goal>"` drive the browser, one Jev request per step; #9 recorded the run with a human-looking pointer; #8 put `jev.run` and `jev.status` behind `agent-browser plugin run`, checked against agent-browser 0.38.1. Slice 1 (#2) is done bar its manual check with a real key; the policy engine (#3) is next.

- **Users** — any agent that runs agent-browser, and the people who run those agents. Today an agent drives it one command at a time and thinks between each one. First user: Vasu's coding agents.
- **Works when** — `agent-browser plugin add vimulatus/agent-browser-plugin-jev` installs it, `agent-browser-plugin-jev run "<goal>"` lands on the goal page from one command, and `run --policy <file>` writes a `findings.json` an agent can turn into a report.
- **Non-goals** — no change to agent-browser core: this speaks the `agent-browser.plugin.v1` protocol and calls the `agent-browser` binary on PATH. No text written by Jev: values come from the goal or a fixture file, because Jev only picks and judges. No destructive action unless the run allows it. Nothing that only one user's skills need.

## Ship

- **Run** — `pnpm install && pnpm build`, then `node dist/main.js run "<goal>" --session <name>`, or `node dist/main.js` with a plugin envelope on stdin. Needs an installed `agent-browser` binary on PATH, and `TYPESAFE_API_KEY` for any run that reaches the model — without it a run writes `status: "failed"` to `<out>/status.json` and never opens the browser. A run exits 0 when it reaches the goal and 2 when it is blocked. Register the local build with `agent-browser plugin add ./ --name jev`, then drive it with `agent-browser plugin run jev jev.run --payload '{"goal":"...","session":"...","wait":true}'` and `jev.status`. `plugin add` writes `./agent-browser.json` (gitignored), and deleting that file unregisters it, since 0.38.1 has no `plugin remove`.
- **Gate** — `pnpm test`. Tests replay recorded agent-browser output from `test/fixtures/` and Jev answers from `test/replay/`; they never open a browser or call the paid API. The Jev answers are written by hand to the documented response shape, so one manual check with a real key stays in the README.
- **Ship** — `agent-browser plugin add vimulatus/agent-browser-plugin-jev` pulls `main` through `npx -y github:...`, and `prepare` builds `dist/` on that install; no npm publish yet.
