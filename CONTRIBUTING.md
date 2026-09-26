# Contributing

`pnpm install && pnpm build && npm link` puts your local build on PATH as `soab`. Run `pnpm build` again after a pull.

## Checked by hand

`pnpm test` replays recorded agent-browser output and hand-written Jev answers, and never calls the paid API. The checks below prove the real thing. Each needs a real `TYPESAFE_API_KEY`, a local fixture site and an agent-browser session of its own.

| Check | The command | Run for real |
|---|---|---|
| A goal run reaches its page | `run "log in as alice@example.com with password secret and open Settings" --url .../login.html` | Yes. Four actions, `status: "done"` on `/settings.html` |
| A policy judges one page | `run --policy bug-hunt --max-steps 0` on a page that fetches a 500 and shows a banner | Yes, with `errors`, `perf` and `bug-hunt`. `bug-hunt` raised two findings |
| A walk tries every control | `run --policy bug-hunt --url .../login.html --allow all --max-steps 12` | Yes. Three frontier entries, all tried, one finding |
| A walk reproduces what it finds | the same, with ffmpeg on PATH | Yes. Three findings, two reproduced with a `.webm` and a screenshot each |
| A code over six boxes | `run "enter the code 123456 and verify" --url .../otp-no-advance.html` | Yes. One TYPE over the six boxes, `status: "done"` on `/home.html` |
| Resume after a code step | `run "sign in to Acme" --url .../otp-single.html`, then `resume <session> --value 123456` | Yes. Blocks as `otp`; a wrong code blocks again on the same field; the right one lands `done`. Neither code is in any run file |
| A recording of a goal run | `run "<goal>" --record ./login.webm --human` | No. Checked without Jev: a playable `.webm` with an easing cursor |
| A page handed to a window | `run "open my invoices" --url <a captcha page>` from a terminal with a display | No. The window and the return to headless were checked without Jev; the poll has not run against a real login page |
| A sign-in carries to the next run | a goal run that signs in on a real login page, then a second run of the same `--session` | No. `state save` then `state load` carried a cookie and a localStorage key without Jev |

The Jev answers under `test/replay/` are written by hand to the response shape the [API page](https://docs.typesafe.ai/api) documents. Replace a file with a real recording when a key is at hand; the tests read the same fields either way.

## Pages that block a run

`test/site/` holds one static page per blocker a goal run can hit: one-time codes in five shapes, a magic link, a push approval, a form missing values, a captcha, a typed delete confirmation, a 500, a 429, an identifier-first login, and an article with a newsletter box. Each page's source states the value it accepts.

```bash
node test/site/serve.mjs 8792
soab run "sign in with one-time code 123456" --url http://127.0.0.1:8792/otp-single.html --session lab-otp --no-handoff --max-steps 6
```

`http://127.0.0.1:8792/` lists every page.

## A page for the perf policy

`perf.yaml` has to tell a slow request the page needs from one it does not. Save this outside the repo and run it:

```js
import { createServer } from "node:http";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = `<html><head><title>Products</title><script src="/app.js" defer></script></head><body><h1>Products</h1><ul id="list"></ul></body></html>`;
const app = `fetch("/analytics/beacon?event=pageview", { method: "POST" });
fetch("/api/products").then((r) => r.json()).then((p) => { list.innerHTML = p.map((x) => "<li>" + x.name + "</li>").join(""); });`;
createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://127.0.0.1:8791");
  if (pathname === "/app.js") return res.writeHead(200, { "content-type": "application/javascript" }).end(app);
  if (pathname === "/api/products") { await sleep(2500); return res.writeHead(200, { "content-type": "application/json" }).end('[{"name":"Kettle"}]'); }
  if (pathname === "/analytics/beacon") { await sleep(1200); return res.writeHead(204).end(); }
  res.writeHead(200, { "content-type": "text/html" }).end(page);
}).listen(8791, "127.0.0.1");
```

```bash
agent-browser --session soab-perf open http://127.0.0.1:8791/index.html
soab run --policy perf --max-steps 0 --session soab-perf
```

Expect one finding, `GET /api/products took 2501 ms`, and nothing about the beacon. `inferred.jsonl` says why: `/api/products` is `content_for_this_page`, the beacon is `analytics`.
