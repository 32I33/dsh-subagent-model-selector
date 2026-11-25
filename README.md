# dsh-subagent-model-selector

[![test](https://github.com/32I33/dsh-subagent-model-selector/actions/workflows/test.yml/badge.svg)](https://github.com/32I33/dsh-subagent-model-selector/actions/workflows/test.yml)
[![license](https://img.shields.io/github/license/32I33/dsh-subagent-model-selector)](https://github.com/32I33/dsh-subagent-model-selector/blob/main/LICENSE)

A small [DeepSeek Harness](https://github.com/deepseek-ai/dsh) bundle that makes
subagent model selection see **every model that is connected right now** — and
asks you to pick one with a cascading provider → model card.

## Why

DSH freezes the allowed subagent models into a session when that session is
created. The stock settings plugin fills the snapshot from a hand-written
allowlist, so connecting a new provider or model later does not make it
selectable until the next session and a settings edit.

`dsh-subagent-model-selector` writes the same durable
`subagent/model-selection-policy` event, but derives it from the live model
registry:

```text
ctx.llm.listProviders()
  -> ctx.llm.listModels(provider)
  -> [{ provider, model }, ...]
```

The policy is refreshed when a top-level agent is created, before
`list_subagent_models` / `subagent` run, and when `llm/adapters-updated` fires.
Child sessions inherit their parent's policy.

## Cascading picker

The bundle also registers a Host tool named `pick_subagent_model`. It asks for
a provider first, then immediately shows **only that provider's models**. Both
cards are raised inside the **same tool call**, so the model does not take
another turn between them.

```text
pick_subagent_model({ task: "review the migration" })
  -> provider card: deepseek-account / workbuddy2api-hub / magpie-agy / baiduqianfan
  -> model card: only the models of the chosen provider
  -> { provider, model }
```

Use the returned route with `subagent`. If the user skips either card, the tool
returns `{ skipped: true, reason }` and no subagent should start.

The picker is registered only when the profile mounts a user-question service
(`ctx.userQuestions`). On a headless profile the live catalog still works; only
the interactive picker tool is absent.

## Install

The package declares `dsh.bundle.patch`, so it installs like any other DSH
bundle. Point the Plugin Manager / `plugin_manager` tool at this directory, or
add it to a profile through the normal bundle install flow.

```text
plugin_manager install_bundle -> C:\path\to\dsh-subagent-model-selector
```

The `subagent` tool must have `modelSelection: true` (the standard preset does).
No other setting is required.

## Configuration

All fields are optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set to `false` to keep the bundle installed but inactive. |
| `includeProviders` | `[]` | If non-empty, only these provider routes are offered. |
| `excludeProviders` | `[]` | Provider routes to leave out. |
| `refreshBeforeToolCalls` | `true` | Refresh before `list_subagent_models` / `subagent`. |
| `refreshOnAdapterChange` | `true` | Refresh live sessions when providers change. |

Example row config:

```yaml
- id: subagent-model-selector
  config:
    excludeProviders:
      - some-embedding-only-provider
```

## How it works

The plugin uses only public Harness extension points:

- `agent/created` seeds a session that has no policy yet;
- `tools/pre-execute` refreshes the calling session before the two subagent
  tools run;
- `llm/adapters-updated` refreshes all live top-level sessions;
- `ctx.sessions.list()` backfills sessions that were already live when the
  plugin was activated;
- `ctx.tools.register()` exposes `pick_subagent_model` when `ctx.userQuestions`
  is available; `ctx.userQuestions.ask()` raises its provider and model cards
  inside one tool execution.

It does not replace the `subagent` tool, does not call a model, and does not
persist its own state. The session log remains the source of truth: the policy
is still a normal session event, so resume, fork, and replay keep working.

The stock `subagent-model-selection-settings` row may stay enabled as a
fallback. It writes its own snapshot first; this plugin replaces it with the
live list before any selection happens.

## Pairing with an ask-before-spawn rule

This bundle supplies the catalog and the picker; it does not force the Lead to
ask. If you want the Lead to ask you before every delegation, add a rule to your
global `AGENTS.md` (or agent preset) such as:

```md
Before creating a subagent, call `pick_subagent_model` with the subagent task
summary, then use the `provider` and `model` it returns. Do not start the
subagent until the user has chosen.
```

## Compatibility

Developed against `@deepseek-ai/dsh` `0.2.2-rc.1`. It depends on:

- `ctx.llm.listProviders()` and `ctx.llm.listModels(provider)`;
- `ctx.sessions.get()` / `ctx.sessions.list()`;
- `ctx.tools.register()` and, when present, `ctx.userQuestions.ask()` for the
  picker tool;
- the existing `subagent/model-selection-policy` session event and the
  `list_subagent_models` / `subagent` tool names.

A DSH upgrade that renames any of these needs a matching update.

## Development

Plain ESM, no build step, no runtime dependencies. Runtime files are `index.js`,
the Cordis patch, locale metadata, and the icon. Run:

```sh
npm test
```

The tests use Node's built-in test runner.

## License

MIT
