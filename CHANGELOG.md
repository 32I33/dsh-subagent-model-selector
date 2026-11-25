# Changelog

## 0.1.0 — 2026-11-25

- Initial public release.
- Seeds and refreshes the `subagent/model-selection-policy` event from the live
  `ctx.llm` provider/model registry, so every currently connected model is
  selectable.
- Adds the `pick_subagent_model` Host tool: a cascading provider → model picker
  raised inside one tool call.
- Refreshes the policy before `list_subagent_models` / `subagent`, on
  `agent/created`, and on `llm/adapters-updated`.
- Child sessions inherit the parent policy.
