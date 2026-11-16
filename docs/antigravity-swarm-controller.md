<!-- SPDX-License-Identifier: Apache-2.0 -->
# Antigravity swarm orchestration controller

## Scope and routing boundary

Interactive Google Antigravity sessions (`agy` CLI, Antigravity IDE, and Antigravity 2.0 App) support two native delegation mechanisms:

- **`swarm` (first-class multi-agent batch orchestration)**: use `swarm` when work requires multiple coordinated workers, task-category model routing (`main`, `economy`, `flagship`), isolated author workspaces, or peer-to-peer / verifier handoffs on the shared message board.
- **`invoke_subagent` (single-shot lightweight delegation)**: keep `invoke_subagent` for isolated, one-off subagent calls that do not require a shared message board, role separation, or workspace landing checks (`specs/host-fallback-v1.md`, `specs/antigravity-host-v1.md`).

This contract governs `swarm` orchestration over supported Antigravity tools. It does not claim provider-side execution proof or token-usage telemetry beyond what the host exposes.

## Model policy, quota, and escalation orthogonality

Resolve requested models and efforts from the device's `hosts.antigravity` partition in `engine-model-policy.json` (`specs/engine-model-policy-v1.md`). Never hardcode concrete vendor model identifiers as normative constants in plans, briefs, or specs.

1. **Category dispatch**:
   - `author`, `verifier`, and `narrator` members use the resolved tier for their assigned `category` (`main`, `economy`, or `flagship`).
   - `monitor` is optional and **must** use `category: "economy"`.
   - `narrator` is **off by default** and is refused unless `narratorAuthorizedBy` is explicitly provided in the batch manifest.
2. **Quota inspection (`swarm{action:"models", all:true}`)**:
   - Parse `quotas[model].quota_remaining` and `quotas[model].quota_note`.
   - A selection with `quota_remaining` equal to `0%` is `unsupported` **unless** `quota_note` indicates AI credits / overage / paid fallback coverage (in which case it remains `supported`).
   - Missing or unparseable quota fields remain `unknown`.
3. **Orthogonality of quota fallback vs. quality escalation**:
   - On `quota-exhausted` or `capacity-exhausted`, keep `rejections` unchanged (`nextRejections = currentRejections`) and select the next highest-priority remaining supported tier within the same `category`.
   - On `quality-rejected`, increment `rejections` by `1` and resolve via the policy's `escalation` (`threshold` and `ceiling`).
   - In both cases, switch the waiting worker **in-place** with `swarm{action:"model", name, model}`—never `kill` and re-`add` a worker merely to change its model.

## Workspaces, landing verification, and PreToolUse guard

1. **Single-repo vs. multi-repo umbrella workspaces**:
   - When the Antigravity Active Workspace is a single Git repository, authors use `workspace: "share"` or `workspace: "branch"`.
   - When the Active Workspace is a multi-repo umbrella directory (`VCS type Unknown` for `swarm{workspace:"share"}`), spawn authors with `workspace: "inherit"` and create an isolated `git worktree add` per author inside the target repository, recording the worktree path in `member.workspacePath`.
   - `verifier`, `monitor`, and `narrator` members **must** use `workspace: "inherit"` and `workspacePath: null` (or equal to `coordinator.workspaceRoot`).
   - Member names must be lowercase, non-empty, and contain no whitespace; `"all"` and `"coordinator"` are reserved.
2. **Landing before `kill`**:
   - Any member with an isolated workspace (`workspace` is `"share"` or `"branch"`, or `workspacePath` resolves outside `coordinator.workspaceRoot`) must not be killed until either:
     - Its working tree is clean (`git status --porcelain --untracked-files=normal` is empty) and its `workerHead` is an ancestor of the coordinator's target ref (`git merge-base --is-ancestor`), recorded as `disposition: "merged"`, **or**
     - Its work is explicitly abandoned by a recorded decision (`minutes:<id>#D<n>`), recorded as `disposition: "abandoned"`.
3. **Worker mutation denial & `PreToolUse` guard**:
   - Business workers (`author`, `verifier`, `monitor`, `narrator`) are **forbidden** from calling `swarm` with `action: "add" | "model" | "kill"`.
   - `PreToolUse` (matcher `read_file|view_file|swarm`) reads staged guard files from `runtimeHome(deviceHome)/cache/antigravity-swarm-guards/<sha256(coordinatorConversationId)>.json` (`einzbern.antigravity-swarm-guard.v1`), denying worker `add`/`model`/`kill` calls (`HOOK_ANTIGRAVITY_SWARM_WORKER_MUTATION_DENIED`) and coordinator `kill` calls on unlanded isolated-workspace members (`HOOK_ANTIGRAVITY_SWARM_UNLANDED_KILL_DENIED`).

## Briefs, recall, and board handoffs

- **`PreInvocation` recall**: Antigravity `PreInvocation` runs recall only when `invocationNum === 0` (or omitted), covering the first turn of a user prompt and the first turn of each spawned worker conversation.
- **Coordinator brief requirements**: Every worker `brief` must state its `workId` and `workRevision`, its exclusive file ownership (so two workers never edit the same file), and concrete acceptance criteria.
- **Message board discipline**: Reference prior board posts by `#seq` rather than re-quoting them. Use `@name` strictly as a wakeup doorbell for the peer(s) who act next, not as a CC.

## Audit and evidence closed loop

1. Prepare each member dispatch with `execution-host-prepare` (`hostKind: "antigravity"`, `invocationKind: "native-tool"`, `toolName: "swarm"`), binding its `attempt.id` to `member.preparationAttemptId` in `tcrn.antigravity-swarm-manifest.v1`.
2. Record batch state, `statusSnapshots`, `modelSwitches`, `switchPreparations`, `boardDeliverables`, and `landings` with:
   ```text
   execution-antigravity-swarm-record --workspace <library> --manifest <json> --preparations <json> --observations <json> [--prior <json>] --output <new-file>
   ```
   A valid recording writes `tcrn.antigravity-swarm-batch.v1` to the private create-new output file and stages `einzbern.antigravity-swarm-guard.v1` in device home. Invalid inputs retain `ANTIGRAVITY_SWARM_RECORD_INVALID` in the output file and exit non-zero.
3. Recompute and verify saved receipts read-only with:
   ```text
   execution-antigravity-swarm-evidence --from-file <file>
   ```
4. **No fabricated actuals**: `actual.model`, `actual.effort`, and `actual.usage` **must** remain `"unknown"`. Antigravity `swarm` status reports roster configuration, not provider execution proof or per-worker token usage.
