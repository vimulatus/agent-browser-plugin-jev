# soab

Your agent describes where it wants to go in a browser, and soab takes it there in one command. It can also walk a web app, find bugs, and hand back each one with a recording.

## Install

You need Node 20.18.1 or newer, [agent-browser](https://github.com/vercel-labs/agent-browser), and a [TypeSafe](https://docs.typesafe.ai) API key.

```bash
npm install -g soab
export TYPESAFE_API_KEY=your-key
```

## Reach a page

```bash
soab run "log in as alice@example.com with password secret and open Settings" --url http://localhost:3000/login
```

soab only types what your goal contains. When a page asks for something it lacks, such as a one-time code, the run stops and names the field. Give it the value and it carries on from the same page:

```bash
soab resume <session> --value "Verification code=482913"
```

## Find bugs

```bash
soab run --policy bug-hunt --url http://localhost:3000/
```

soab tries every button and link it finds, then writes `findings.json` with a screenshot and a recording for each bug. It won't delete, send or pay for anything unless you add `--allow`.

## Let your agent use it

```bash
npx skills add vimulatus/soab
```

This teaches your agent when to run soab and what to do when a run stops.

## Learn more

- [Goal runs](docs/goal-runs.md): signing in, resuming, recording
- [Walks](docs/walks.md): checking one page, walking an app, test data
- [Policies](docs/policies.md): writing your own checks
- [State and output](docs/state.md): where runs are saved, and what `findings.json` holds

Run `soab` with no arguments to see every command.
