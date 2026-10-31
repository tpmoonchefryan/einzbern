# 4.0.0 — Codex independent conversation coordination

- Replace the Codex native collector controller and private bridge with one main
  decision conversation and an independent economy coordinator. Only an
  explicitly selected Codex host uses this workflow; Claude Code, DeepSeek Harness
  and dot retain their existing policies.
- Remove the documented `codexNativeDynamicToolSpecs`,
  `createCodexNativeController`, `createCodexNativeHookBridge` and
  `waitCodexNativeCollector` exports and the `collector-wait` helper. This is a
  breaking change from 3.4.0. Existing isolated controller integrations must move
  to supported host conversation operations and the current coordination contract.
- Add `execution-codex-peer-record` and `execution-codex-peer-evidence` for fixed
  batch recovery. Bind actual conversation identities, worker attempts, work
  revisions, model policy and observation cutoffs; preserve unknown, failed,
  cancelled and completed outcomes without redispatching work.
- Release a worker's occupancy only for a unique, consistent identity association.
  Identity drift, collisions, missing outcomes and conflicting evidence retain
  responsibility. Preserve premature-report findings after later completion;
  final-report association requires terminal evidence strictly before send
  preparation, separately from transport confirmation.
- Guide model setup through stable main, economy and optional flagship categories.
  Main and economy require usable model groups; supplementation preserves user
  selections, custom categories and other hosts. Normal setup retires only proven
  engine-owned collector hooks, preserving user-edited and unrelated entries.
- Keep native scheduling, waiting and report delivery as actual host capabilities.
  Receipt validation and fixture tests do not certify those capabilities, send
  messages, authorize dispatch or establish global exactly-once delivery.

[4.0.0 module directory](Release-Notes-4.0.0.md) · [All releases](Release-Notes.md)
