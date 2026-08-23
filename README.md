# Canon for DeepSeek Harness

`@canonmsg/deepseek-harness-plugin` adds Canon as a channel inside a DeepSeek
Harness (DSH) profile. Canon becomes an additional surface beside the normal
DSH Web UI; this bundle does not replace DSH's Web, session, approval, tool, or
persistence rows.

Use the Canon app at [canonmail.com](https://canonmail.com) to approve your
agent and message it after setup.

The plugin uses DSH's public `ctx.agents` and session-event contracts. DSH owns
the model, tools, permissions, persistence, and execution environment; Canon
only adapts messages, visible activity, one-shot approvals, and runtime signals.

## Requirements

- Node.js 22.19 or newer (or Node 24+)
- DeepSeek Harness `0.1.1-rc.2`
- A Canon agent registered with client type `deepseek-harness`

DSH is a developer preview and warns that breaking changes are expected. Canon
therefore pins the direct DSH service APIs to the exact tested `0.1.1-rc.2`
line rather than advertising a broad prerelease range.

## Register the Canon agent

```sh
canon-dsh-register \
  --name "My DSH Agent" \
  --description "Coding agent in DeepSeek Harness" \
  --phone "+15551234567" \
  --profile my-dsh
```

After Canon approval, install the published bundle into a selected DSH profile:

```sh
dsh plugin --profile my-dsh-profile add @canonmsg/deepseek-harness-plugin
```

DSH's plugin manager recognizes `dsh.bundle.patch` and adds the package to that
profile's ordered bundle list automatically. Check the composed row without
booting the agent:

```sh
CANON_AGENT=my-dsh dsh --profile my-dsh-profile --dump-config
```

Confirm that row `canon-dsh` is present and enabled. Then start DSH from the
project workspace:

```sh
cd /path/to/project
CANON_AGENT=my-dsh dsh --profile my-dsh-profile
```

The Canon profile (`my-dsh`) and DSH profile (`my-dsh-profile`) are separate
concepts. The first selects Canon credentials. The second selects the DSH
bundle stack.

## Configuration

The bundle row reads these environment expressions:

| Variable | Purpose | Default |
| --- | --- | --- |
| `CANON_AGENT` | Canon profile in `~/.canon/agents.json` | empty; Canon auto-selects only when exactly one matching profile is available |
| `CANON_DSH_WORKSPACE` | Absolute DSH workspace root | DSH invocation directory |
| `DSH_PROVIDER` | Optional provider route for Canon-created agents | DSH model settings/default selection |
| `DSH_MODEL` | Optional model for Canon-created agents | DSH model settings/default selection |
| `CANON_DSH_DISABLED` | Set to `1` to disable only the Canon row | enabled |

`DSH_PROVIDER` and `DSH_MODEL` must be supplied together. Omit both to use the
profile's normal model selection.

## What the bridge supports

- One durable DSH session per Canon conversation, resumed from DSH's
  event-sourced session log after restart.
- A Canon message batch mapped to one immutable DSH user message.
- Visible assistant text streaming.
- Runtime activity for DSH turns and tool calls/results without exposing raw
  tool arguments.
- One-shot Canon approval cards for DSH approval requests.
- Interrupt, stop-and-drop, and new-session signals.

Canon interrupt aborts the active DSH turn with `keepInbox: true`. Stop-and-drop
uses DSH's default cancellation behavior and clears queued inbox work. New
session advances Canon's durable generation mapping without deleting the old
DSH event log.

Canon's conversation-to-session map is stored under `CANON_HOME` (normally
`~/.canon`), never inside the project workspace.

## Approval semantics

DSH requests carry a tool name, optional call correlation, and a reason; they do
not carry raw tool arguments. Canon does not fabricate arguments.

The mapping preserves DSH's closed vocabulary:

- explicit Canon allow → `allowed-once`
- explicit Canon denial by a human → `rejected`
- DSH/Canon request abort → `cancelled`
- timeout, transport failure, missing responder, or indeterminate result →
  `unavailable`

`unavailable` is never treated as permission. Canon session rules are disabled
for this bridge because DSH has only one-shot grants.

## Current limitations

- Canon attachments are represented as safe text placeholders; they are not yet
  converted into native DSH image attachments.
- DSH user questions remain owned by the selected DSH surface. They are not
  conflated with Canon approval cards.
- Provider/model, permission mode, effort, workspace selection, execution mode,
  session-state snapshots, rich cards, and steering/interleave are not
  advertised as Canon controls until the bridge can validate and enforce each
  control end to end.
- The initial package is tested against DSH `0.1.1-rc.2` only.

## Troubleshooting

1. Run `CANON_AGENT=<profile> dsh --profile <dsh-profile> --dump-config`.
2. Confirm row id `canon-dsh` and package name
   `@canonmsg/deepseek-harness-plugin`.
3. Set `CANON_DSH_DISABLED=0` or unset it if the row is disabled.
4. Check that `~/.canon/agents.json` contains the selected profile with
   `clientType: "deepseek-harness"`.
5. Start DSH from the intended project directory or set
   `CANON_DSH_WORKSPACE` to its absolute path.

## Development

```sh
npm install
npm run check
```

The bundle patch intentionally inserts only `canon-dsh`; it does not replace or
deep-merge any DSH-owned row.

DeepSeek Harness is in developer preview. This repository pins the exact DSH
release it is tested against; compatibility updates are reviewed and released
explicitly rather than inferred from a broad prerelease range.
