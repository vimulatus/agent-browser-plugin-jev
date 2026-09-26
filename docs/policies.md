# Policies

A policy is a YAML file with four sections under an optional `name`: what to `collect`, how to `measure` numbers, what to ask Jev in `judge`, and the `report` rules that turn all of it into findings.

```yaml
name: my-policy
collect: [console, content, errors, requests, snapshot]
measure:
  http_status: { ok: "<400", client_error: "400-499", server_error: ">=500" }
judge:
  page_shows_error_to_user:
    type: noul
    over: page
    instructions: Does the page show the user an error, a failure, or an empty state where content belongs?
report:
  - when: http_status == server_error
    title: "{{request.method}} {{request.path}} returned {{request.status}}"
    severity: high
  - when: page_shows_error_to_user > 0.7
    title: "{{page.path}} shows the user an error"
    severity: medium
```

`--policy` takes a path, or a name it looks up as `<name>.yaml` in `./.soab/policies/`, then `~/.soab/policies/`, then the shipped policies. A project file replaces a shipped policy of the same name.

## collect

What to gather at every step. Everything a rule or a question reads has to be collected, or the policy is refused when it loads.

| Name | What it gathers |
|---|---|
| `console` | Every console message, split into `console.messages`, `console.errors` and `console.warnings` |
| `errors` | The errors the page threw |
| `requests` | The requests the page made, without their duration |
| `snapshot` | The page's controls, its URL and its title |
| `content` | The whole page text, so Jev reads the banners and labels `snapshot` drops |
| `har` | One HAR over a reload, so every request carries `time` in ms. A policy that collects it cannot walk |

## measure

Jev does not compare numbers, so code buckets them. Each name maps bucket names to ranges, and a value falls into the first bucket that holds it. A range is `<n`, `<=n`, `>n`, `>=n` or the inclusive `a-b`. A value no bucket holds has none, and a rule that compares it does not fire.

| Name | What it reads | Needs |
|---|---|---|
| `http_status` | The status of each request | `requests` or `har` |
| `latency` | The duration of each request, in ms | `har` |
| `page_unchanged_after_click` | `1` when the click left the page as it was, `0` when it changed it | `snapshot`, and a walk to click |

## judge

The questions Jev answers. `over` says what each question runs over, one question per item, all in one request: `page` once per step, `request` once per request, `element` once per control, `finding` once per finding the rules raised.

A `choice` answers with one of its `criteria`, at least two. A `noul` answers with a probability between 0 and 1. `instructions` can name what the browser showed with `{{ }}`, within its own scope: a question `over: request` cannot read `{{element.label}}`.

`over: finding` grades severity, so it only works under the name `severity`, as a `choice` with one criterion per level. A policy that judges `severity` forbids its rules to set one; a policy that does not makes every rule set one.

```yaml
judge:
  request_kind:
    type: choice
    over: request
    instructions: What does this request fetch for the page the user is looking at?
    criteria:
      content_for_this_page: data the page shows now
      analytics: tracking or telemetry
```

## report

`when` decides, `title` names the finding, and `severity` grades it unless `judge` does.

`==` and `!=` take a bucket name, a criterion, a quoted string or a number; a name that is neither a bucket nor a criterion of that question is refused when the policy loads. `<`, `<=`, `>` and `>=` need numbers, which is how you read a noul. Combine with `not`, `and`, `or` and parentheses, in that precedence. `errors.any` is true when the list holds something, and `console.errors[0].text` reads into it.

`title` takes `{{ }}` placeholders on the same paths. The paths a rule names decide what it runs over: `request.*` fires once per request, `element.*` once per element, neither once per page. A rule cannot name a request and an element at once.

```yaml
report:
  - when: latency == bad and request_kind == content_for_this_page
    title: "{{request.method}} {{request.path}} took {{request.time}} ms"
    severity: high
```

## The policies that ship

| `--policy` | What it finds |
|---|---|
| `errors` | A request that returned 500 or worse, an error the page threw, an error it logged. It asks Jev nothing, so it needs no key |
| `perf` | A request slower than a second that the page needs, told apart from a slow beacon or third party, and a page still showing a spinner. It collects `har`, so it judges one page |
| `bug-hunt` | A control that does nothing or does the wrong thing, a 500, a page or console error, an error shown to the user, a page stuck loading. It judges severity itself |

The files are in [`policies/`](../policies).
