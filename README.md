# Canon for DeepSeek Harness

`@canonmsg/deepseek-harness-plugin` adds Canon as a channel inside a DeepSeek
Harness (DSH) profile. Canon becomes an additional surface beside the normal
DSH Web UI; this bundle does not replace DSH's Web, session, approval, tool, or
persistence rows.

Use the Canon app at [canonmail.com](https://canonmail.com) to approve your
agent and message it after setup.

The plugin uses DSH's public agent, attachment, approval, tool, and session-event
contracts. DSH owns the model, tools, permissions, persistence, and execution
environment; Canon adapts messages, native image references, visible activity,
one-shot approvals, optional user questions/plan review, runtime signals, and
one policy-filtered native `communicate` tool.

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

Two plugin fields are intentionally composition-owned rather than inferred:

- `questionProvider: external | canon` selects the one DSH user-question
  provider for this Cordis context. The published Web-compatible patch uses
  `external`; a headless Canon deployment uses `canon`.
- `planMode: boolean` advertises Canon's Plan turn mode and requires a composed
  `ctx.planMode` service. It is off in the generic patch.

## What the bridge supports

- One durable DSH session per Canon conversation, resumed from DSH's
  event-sourced session log after restart.
- Native Cordis lifecycle behavior: the plugin becomes active after launching
  Canon delivery, while the long-lived SSE loop remains owned by its reversible
  plugin effect and is stopped on unload or hot replacement.
- A Canon message batch mapped to one immutable DSH user message. Canon's SDK
  serializes batches per conversation; DSH's inbox remains the turn scheduler.
- PNG, JPEG, WebP, and GIF inputs committed through DSH's durable attachment
  store before the owning user message is appended. DSH's configured image
  count, byte, dimension, and normalization policies remain authoritative.
- Visible assistant text streaming.
- Runtime activity for DSH turns, tool calls/results, and aggregate todo
  progress without exposing raw tool arguments or todo contents.
- One-shot Canon approval cards for DSH approval requests.
- Structured `ask_user_question` requests rendered as Canon runtime-input
  cards when `questionProvider: canon`; selected labels and custom answers are
  mapped back into DSH's native answer vocabulary.
- DSH `plan-review` intent rendered as Canon's native plan-review card, with
  approve, keep-planning, and revision feedback mapped back to DSH.
- Optional Canon Plan turn mode backed by DSH's own logged `planMode` service.
- One DSH-native `communicate` tool for existing messages, new or latest direct
  conversations, groups, forwarding, contact sharing, and group membership.
  It is mounted only during an active Canon turn when the agent's outbound
  policy is `open` or `approval-required`; Canon remains the policy authority.
- Canon's standard `no_reply` tool during every active Canon turn. In groups,
  the trusted Canon prompt names it as the way to stay silent without posting
  a message or triggering another agent.
- Interrupt, stop-and-drop, and new-session signals.

Canon interrupt aborts the active DSH turn with `keepInbox: true`. Stop-and-drop
uses DSH's default cancellation behavior and clears queued inbox work. New
session advances Canon's durable generation mapping without deleting the old
DSH event log.

Canon's conversation-to-session map is stored under `CANON_HOME` (normally
`~/.canon`), never inside the project workspace.

Images that are unsupported, unavailable, or outside the active DSH policy are
left as Canon's safe text placeholders; their source URLs are never inserted
into the model prompt or DSH session log by this bridge.

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

- DSH `0.1.1-rc.2` permits only one active user-question provider in a Cordis
  context. Canon questions therefore require `questionProvider: canon` in a
  headless/Canon-owned composition; that setting must not be combined with the
  Web API proxy's provider. Supporting both surfaces simultaneously requires a
  future routed/multiplexed DSH provider seam.
- Non-image Canon attachments remain safe text placeholders.
- Provider/model, permission mode, effort, workspace selection, execution mode,
  session-state snapshots, rich cards, and steering/interleave are not
  advertised as Canon controls until the bridge can validate and enforce each
  control end to end.
- The package is tested against DSH `0.1.1-rc.2` only.

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

### Shared endpoint upgrade

Version 0.5 uses Canon SDK 11 and the shared endpoint journal. Run Node 22.22.3 or newer. On a managed host, set `CANON_ENDPOINT_STATE_DIR` to a private persistent volume (the fleet image uses `/data/canon-endpoint`); on a local machine, the default is the endpoint directory under `CANON_HOME` or `~/.canon`. Retain this state together with the existing DSH session mapping and native sessions.

Stop the existing writer before upgrading. Use `canon-endpoint-migrate` from Core 13 with the same credentials, environment and state directory to inventory and reconcile pre-cutover inputs against the DSH journals. Import the reviewed manifest before starting the plugin. A claimed turn with an unknown provider outcome remains uncertain; an unread/read marker is not an execution receipt. The plugin does not change model, provider, workspace or DSH session identity.
