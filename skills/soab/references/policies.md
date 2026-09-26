# Writing a policy

A policy is YAML: what to `collect`, how to `measure` numbers, what to ask Jev in `judge`, and `report` rules that turn it into findings.

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

Save a repo's policy as `./.soab/policies/<name>.yaml` (`soab init` creates the directory) and run it with `--policy <name>`. A name is looked up in `./.soab/policies/`, then `~/.soab/policies/`, then the shipped policies; a path is read as a path. The policy is checked when it loads, so a bad one fails the run at once with the reason.

## collect

Anything a rule or a question reads must be collected.

| Name | Gathers |
|---|---|
| `console` | `console.messages`, `console.errors`, `console.warnings` |
| `errors` | The errors the page threw |
| `requests` | The page's requests, without timings |
| `snapshot` | The page's controls, URL and title |
| `content` | The whole page text, banners and labels included |
| `har` | One HAR over a reload, the only source of `request.time`. A policy that collects it judges one page (`--max-steps 0`) and cannot walk |

## measure

Jev does not compare numbers, so code buckets them. Each maps bucket names to ranges (`<n`, `<=n`, `>n`, `>=n`, or inclusive `a-b`); the first bucket that holds the value wins.

| Name | Reads | Needs |
|---|---|---|
| `http_status` | Each request's status | `requests` or `har` |
| `latency` | Each request's duration in ms | `har` |
| `page_unchanged_after_click` | `1` when a click changed nothing | `snapshot`, and a walk |

## judge

Each question runs once per item of its `over`: `page`, `request`, `element`, or `finding`. `type: choice` answers one of its `criteria` (two or more); `type: noul` answers a probability from 0 to 1. `instructions` may use `{{ }}` paths of its own scope only.

`over: finding` grades severity: name it `severity`, make it a `choice` with one criterion per level, and set no `severity` in any rule. Without it, every rule sets `severity`.

## report

`when` compares with `==` and `!=` against a bucket name, a criterion, a quoted string or a number, and with `<`, `<=`, `>`, `>=` against a noul. Combine with `not`, `and`, `or` and parentheses. `errors.any` is true when the list holds something.

`title` uses `{{ }}` on the same paths. A rule that names `request.*` fires once per request, `element.*` once per element, neither once per page; it cannot name both.
