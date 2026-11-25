# Engine Model Policy V3

## Status and scope

The model policy is engine/device state. There is one file at
`<deviceHome>/engine-model-policy.json`; it is not copied into project or library settings.
The file has one shared `categoryCatalog`; the top-level `hosts` object keeps each host's
ordered tiers, escalation `{enabled, threshold, ceiling}` tuple, and optional host-local
concurrency/quota overrides. An absent file is an empty store: the engine does not invent a
model choice.

This contract covers storage, validation, provenance, runtime tier resolution, and the CLI/Atelier read and write surfaces.
The catalogue identifies the policy source and preserves project `models.*` values as
read-only compatibility inputs with their recorded source. A project value does not override a
configured device policy. No write to the engine policy changes a project event or its old value.

## Codex peer-mode onboarding (INIT076)

Installation guidance and the selected-host model editor offer stable categories
`main` (主力), `economy` (经济), and `flagship` (旗舰). These are category defaults,
not default actual models or proof of a configured group. The initial store remains
unconfigured until an authorized policy write through the existing governed setter;
no invented actor, decision, model or effort is saved by onboarding.

Codex independent peer coordination requires usable main and economy groups in
that device's Codex host partition. A category row alone does not satisfy readiness:
the group must resolve actual configured model/effort tuples under the existing
resolver and capability checks. Offer flagship in the same guidance but allow its
model group to remain empty; an empty optional group must not be selected as a
worker model or active escalation ceiling. Plans refer to categories, while dispatch
retains resolved tuples, policy origin and actual host acceptance separately.

Default-category supplementation on update/repair is idempotent and preserves
existing model choices, custom categories, escalation settings and other hosts.
Do not silently save a draft or override a user's policy; unresolved readiness is
reported, not repaired with a guessed model. This readiness requirement gates only
explicit Codex peer mode, not general policy storage or Claude Code/DSH's existing
single-conversation coordination. Dot is independent. Unknown host must not activate
Codex mode. Missing required groups never trigger a project-policy or collector
fallback. The coordination contract is in `docs/codex-native-controller.md`.

## File schema and migration

The device reads the historical `tcrn.engine-model-policy.v1` and
`tcrn.engine-model-policy.v2` schemas and projects their categories into the shared catalog.
Native receipt replay validates the policy schema and host digests recorded at dispatch.

The closed file shape is:

```json
{
  "schemaVersion": "tcrn.engine-model-policy.v3",
  "revision": 1,
  "categoryCatalog": [
    { "id": "flagship", "name": "Flagship", "description": "", "order": 10 },
    { "id": "main", "name": "Main", "description": "", "order": 20 },
    { "id": "economy", "name": "Economy", "description": "", "order": 30 }
  ],
  "hosts": {
    "codex": {
      "revision": 1,
      "tiers": [
        { "order": 10, "category": "economy", "runner": "codex", "model": "<owner-selected-model>", "effort": "max", "note": "" }
      ],
      "escalation": { "enabled": true, "threshold": 1, "ceiling": "main" },
      "maxConcurrentSubagents": 3,
      "quota": { "fiveHourWaitPercent": 85 },
      "digest": "<sha256 of the canonical policy fields>",
      "updatedAt": "2026-10-17T00:00:00Z",
      "actor": "agent:codex",
      "decidedIn": "minutes:<24-hex-id>#D1",
      "decidedInLibraryId": "library:<24-hex-id>"
    }
  },
  "operations": {}
}
```

`categoryCatalog` and `tiers` use the existing closed record formats from
`specs/settings-catalog-v1.md`. Every tier's `runner` must equal its enclosing host, and each
tier category and escalation ceiling must exist in the one shared category catalog. The threshold
is a safe positive integer no larger than the engine's existing models escalation bound. Host ids
are lowercase ids. The file rejects unknown fields, invalid host partitions, impossible revisions,
invalid actor/decision/library identities, malformed UTC instants, and digest mismatches.

A host may set `maxConcurrentSubagents` to a positive safe integer or null; null inherits the
device's generic value. The `quota` field may be a partial object with any of
`fiveHourParallelOffPercent`, `fiveHourWaitPercent`, `weeklyParallelOffPercent`, and
`weeklyWaitPercent`. An omitted field inherits the device's generic threshold. Each supplied
threshold is an integer from 1 through 100; `weeklyWaitPercent` also accepts null (explicitly no
weekly wait). A wait threshold must not be below its parallel-off threshold after generic and host
values are combined. These are policy thresholds, never account usage or balances.

The device's generic settings are `models.maxConcurrentSubagents` (default 8) and
`models.quota.*` (defaults 75 / 90 / 95 / null), all in `machine-settings.json` and shown on the
standalone Models page. An unset generic value resolves to its catalog default. Quota provenance is
`engine-default` when no generic or host value is configured, `device-generic` when a generic
device value applies, and `device-host-policy` when the selected host overrides a quota field.
`execution.maxConcurrentAgents` remains a separate device hard cap. Heavy-run slots
(`execution.maxConcurrentHeavyRuns`) are also device-local and have no host override.

V1 and V2 files remain readable. Reads promote them in memory and do not rewrite the device file.
On the next authorized write the store is persisted as V3 with one root category catalog. Legacy
built-in category rows are replaced with the canonical built-ins; custom ids and their tier and
escalation references are unioned across hosts. Repeated custom ids with matching name and
description are kept once; conflicting definitions fail for Owner reconciliation instead of
discarding either record. Existing tiers, escalation, quotas, actors, decisions and operation
receipts remain associated with their hosts.

The digest is SHA-256 of canonical JSON for `{host, categories, tiers, escalation}` when no
override fields are present, preserving existing digests. A present `quota` and/or
`maxConcurrentSubagents` member is included in that digest. Each host revision increases on
replacement of that host; the file revision increases on every successful write. Writers serialize
through the device lock for `engine-model-policy.json`, replace the single file atomically, and
validate the persisted file again before releasing the lock. A write receipt is built from that
lock-held snapshot, so a later write cannot mix its host row or audit metadata into the earlier
receipt.

## CLI and Atelier

- `engine-model-policy-catalog [--host <id>]` reads the device store. With `--host`, it returns
  either that host's configured record or an explicit `unconfigured` status.
- `engine-model-policy-set [--workspace <library>] --host <id> --policy <json> --at <instant>
  --actor <id> --decided-in minutes:<id>#D<n>` validates an Owner decision naming
  `models.engine-policy`, writes that host record and the shared category catalog, and returns the
  stored policy readback. The optional `--expected-store-revision` rejects a write based on a stale
  shared catalog or another host's concurrent edit. When multiple hosts share the catalog, a
  per-host write without this revision keeps categories omitted by that host. Pass the revision
  when replacing the whole shared catalog.
  An unconfigured host's draft uses the current shared categories and preserves their order.
  The workspace locates the decision; if omitted, the device registry resolves it from the current
  directory under the CLI's existing rules. It does not scope the resulting policy.
- `settings-catalog` keeps its existing project/library setting rows and adds `modelPolicy`, the
  device-engine catalogue plus the legacy model setting values and their source/declaration
  provenance. When both sources contain values, both remain visible and the device host record is
  identified as the model-policy source; the compatibility values are not silently rewritten.
- Atelier exposes the same engine catalogue and governed write through `/api/model-policy` and
  an **Engine model policy** page. Its host selector queries the device catalogue, displays the
  selected host's revision, source, audit decision, and legacy-precedence statement, and never
  changes the selected project configuration target. The page reuses the portal's save and undo
  controls; saving requires a cited Owner decision and sends the portal's actual actor through the
  governed endpoint. Reads and writes do not require a selected project target.

The generic concurrency, quota, device hard-cap and heavy-run controls are machine settings on the
standalone **Models** page. The legacy Settings page has no Models group. The engine-host editor
holds only nullable host concurrency and quota overrides; heavy-run concurrency has no host field.

## Portal interaction contract

The historical rows for `models.category`, `models.tiers`, and the escalation keys on the Models
page identify their project compatibility source and link to the engine-host editor. They do not
render project-setting write controls for a compatible Codex policy. The category and tier pages use the
same editor, table, choice, numeric-entry, focus, keyboard, and receipt behaviors as the portal
collections; they are projections of the selected engine host rather than copies of project
configuration.

Every route that reads a model policy, including a full portal refresh, captures the requested
host, selected library identity, library epoch, and monotonically increasing read sequence. A
response is accepted only if all four still identify the same target. Switching hosts leaves an
old host's save unavailable while its replacement reads; switching libraries clears the old
library's drafts. A valid host id is an engine contract value, so per-host drafts and pending
writes use own-entry maps rather than prototype-keyed objects.

An unconfigured host is offered the stable `main`, `economy`, and `flagship` category
template without fabricating a persisted model policy. The editor can complete every policy field: category `order`, `id`, `name`, and `description`;
tier `order`, `category`, `runner`, `model`, `effort`, and `note`; and escalation `enabled`,
`threshold`, and `ceiling`. Reset / undo discards an unsubmitted draft only; it never invents a
policy-delete operation.

The portal permits one write per host at a time. It records the exact draft version sent, keeps
Save unavailable until that request settles, and shows either the governed receipt or a failure
receipt. A success clears a draft only when the draft is still the exact sent version. Edits,
Owner-decision changes, Undo, locale changes, and refreshes made after send retain their newer
draft. A write also names the library that resolved its Owner decision; the endpoint rejects a
request if that library changed before the write begins.

## Compatibility

Historical `settings.updated` events and existing project `models.*`/`quota.*` records stay
readable through the ordinary settings catalogue and replay paths. This storage change does not
migrate, delete, or re-emit them. The V3 engine policy file and generic machine settings are the
device-local authorities. Consumers must report their effective source and may not substitute a
project's old Codex value when the device policy for Codex is unconfigured or invalid. Each host
continues to use its own tiers, escalation and optional local overrides.

## Runtime resolution and evidence boundary

`resolveEngineExecutionPolicy({host, category, rejections, home?})` reads the current device
policy and generic machine settings, then delegates to the same ordered tier/escalation algorithm used by
`resolveEngineExecutionPolicyFromSnapshot(snapshot, input)`. The snapshot version validates
its complete input and binds the selected tier and origin to that single revision. Both return
`record`, `steps`, `atCeiling`, host/category/rejections, escalation, effective quota,
`quotaOrigin`, `hostConcurrencyLimit`, and origin `{kind: device-engine, path, revision, storeRevision, digest}`.
The file and host revisions are separate. This is a runtime handoff, not a portable project
configuration artifact, and does not alter a host application's default model.

Resolution starts at the selected category's largest-order tier, moves toward smaller orders
once per threshold rejections, and stops at the ceiling category's smallest-order tier.
All tiers remain within the requested host. Disabled escalation returns the base tier.
For example, a supplied economy group with four ordered tiers and a main ceiling,
with rejection threshold 2, selects successive economy tiers for rejections 0–1,
2–3, 4–5 and 6–7, then the main ceiling from 8 onward. Actual model and effort
values come solely from that policy; flagship is not an automatic escalation.

This describes a supplied policy, not an installed default or hardcoded fallback. Missing
hosts, blank selected model/effort, and a selected tuple absent from caller-supplied
`availableCombinations` fail with `ENGINE_MODEL_POLICY_UNAVAILABLE`. Invalid stores,
unknown categories, and malformed rejection counts retain their explicit validation errors.
No error substitutes another model, runner, or project's historical Codex policy.

Capability evidence is separate from policy validity. Without an adapter-supplied tuple list,
`capabilityStatus` is `unchecked`; a match reports `verified-by-caller`, not a claim that the
engine executed a live native tool. The resolver does not infer capabilities from a vendor roster.
Historical model-plan and settings events remain unchanged and replayable.

`resolveExecutionConcurrency(deviceLimit, projectLimit?, genericLimit?, hostLimit?)` combines the
device hard cap, an optional project budget, the generic device limit, and the selected host's
nullable override. It uses the smallest positive limit and reports its origin; no narrower budget
can raise a broader cap.
`evaluateExecutionQuota(policy, observation)` is a pure advisory decision with parallel,
serial, wait, or unknown results. Observations are separately supplied percentages; missing
windows are unknown, never zero. Known restrictions take priority in the order wait, serial, unknown, parallel; a missing
window never erases a known wait or serial restriction. The function does not retrieve account usage, attest its freshness, or dispatch work.
Tests of these helpers establish policy behavior, not actual account monitoring or native
host acceptance.

## Operator and dispatch integration

Before preparing an agent invocation, use the read-only command:

```
einzbern execution-policy-resolve --host codex --category economy --rejections 4
```

Use the returned `record.runner`, `record.model`, and `record.effort` verbatim. Keep the
returned origin revision and digest with the dispatch evidence, and retain the actual host
acceptance or refusal separately. An unavailable policy is a blocker, not permission to select
another model or use the host default. Rejection counts belong to the work's existing ledger;
this command neither increments nor resets that ledger.

`--project-budget <positive integer>` can tighten, never raise, the device
`execution.maxConcurrentAgents` cap. `--usage <json>` can pass separately observed
`fiveHourUsedPercent` and `weeklyUsedPercent`. The command returns the effective concurrency
and quota decision alongside `observationSource`: absent usage is unavailable, supplied usage
is caller-supplied-unverified. Do not interpret absent observations as spare quota. A returned
wait decision means the orchestrator must defer dispatch; the read-only command itself does
not acquire a slot, launch a process or wait for an account reset.

`work-project-context` and handoff carry the engine-host source separately from project
configuration. `settings-catalog` includes the configuration dictionary and typed declaration
readback; historical project model/quota values there are not the runtime selected tier.
Shared AGENTS content points to this runtime contract rather than embedding a device's chosen
models. These source-level integrations do not modify an external Skill repository, install a
live release, or prove native tool support.

Runtime project handoffs carry `executionConcurrency` resolved from device and generic limits; an
explicit host execution request can also apply that host's nullable override. Historical project
concurrency rows remain visible for compatibility but do not set an active cap. This is a bounded
scheduling contract, not proof that an external host acquired a slot. Quota observations and
restrictions remain separately identified.

## INIT065 separately governed exact saving (operation receipts)

Normal native execution does not call this path. `engine-model-policy-save --workspace <library> --host <id> --changes <json> --expected-host-revision <n> --expected-host-digest <digest|absent> --operation-id <nonsecret-id> --at <UTC> --actor <actual-actor> --decided-in <Owner-decision>` uses the same supported Owner decision verifier and models.engine-policy target as the existing setter. Existing saving authorization is reused; this command does not request repetitive approval or treat temporary execution permission as persistent-save authority.

For an existing host, changes is exactly `{tiers:[{order,model,effort},...]}`. Only explicitly named existing tier tuples change; categories, runner, tier order/category/note, escalation, quota, other tiers and other hosts remain intact. Unknown rows, duplicates and empty patches fail. For an absent host only, changes may instead contain an explicitly approved complete `{initialPolicy:...}` with expected revision 0 and digest `absent`. A tuple alone never invents the missing category/escalation configuration.

The writer validates actor/decision and patch, acquires the existing policy lock, reads the current valid store, checks an existing operation for exact idempotent replay, then compares expected **host** revision and digest. Other-host changes do not cause a false same-host conflict or get overwritten. After merging it validates the whole host policy, atomically writes and reads back under lock. No direct plugin projection write is supported. A same-host change returns ENGINE_MODEL_POLICY_CAS_CONFLICT and preserves bytes; reuse of an operation ID for different changes returns ENGINE_MODEL_POLICY_OPERATION_CONFLICT. There is no force-CAS bypass.

The first transactional save stores a closed `operations` map in the V3 envelope. Each operation stores id, host, changeDigest, expectedRevision/expectedDigest, committed storeRevision and exact result host entry (including actual actor/decision). All reside in the same atomic file: a crash after the write cannot commit policy without its replay receipt. The change digest binds host, expected snapshot, exact changes, actor and decision; retry time is not part of that identity. Digests establish consistency, not platform authentication.

Repeated same operation/change returns `replayed` with its original operation result and the current store readback, without a write or revision increment, even if a later authorized write changed that host. Never mistake the original operation result for current configuration. An unknown result is reconciled by reading this receipt/current policy before retry. Legacy V1/V2 envelopes are promoted in memory; the next authorized write retains V2 operation receipts while persisting the V3 shared-catalog envelope.

V1 and V2 stores remain readable and are not rewritten by reads or dispatch. Old engines with closed V1 schemas reject the V2/V3 envelope. Downgrading a binary alone is not a successful configuration rollback. Any approved downgrade migration must preserve the operation evidence and explicitly produce an old-compatible store through a separately supported migration; this delivery does not invent a destructive ledger-stripping command. Configuration rollback uses a new operation and current host CAS, creating a new revision rather than falsifying history.

Saving failure never revokes authorized temporary execution, unless the user explicitly required saving before execution. Saving tests/acceptance are recorded separately from core T01–T03. No real device configuration is changed by developing or testing this contract.

### Bounded waiting and failure reconciliation

`engine-model-policy-save --lock-timeout-ms <nonnegative integer>` bounds only lock waiting (default 30000 ms), not the authorization or number of calls. Timeout preserves the actual holder and performs no policy write; an unknown holder is not forcibly removed.

`engine-model-policy-operation --id <operation-id>` is the supported read-only reconciliation entry. It returns recorded/not-recorded, the original operation/result, currentHost separately and current storeRevision. A recorded earlier operation is not proof that its settings remain current. Read failure is an error, never a false not-recorded result. No new approval is needed to read one's receipt.

Errors after atomic writing starts report ENGINE_MODEL_POLICY_SAVE_RECONCILIATION_REQUIRED with operationId, host, phase, writeOutcome and a bounded causeCode, not arbitrary exception text. A completed atomic write followed by failed readback/return/lock release reports committed; an unclassified atomic failure remains unknown; replay release failure reports previously-committed. A deterministic failure before writing reports ENGINE_MODEL_POLICY_SAVE_FAILED/not-written. Ordinary validation/CAS/lock errors before writing retain their original reason codes. Read the operation/current state before retrying uncertain results; same operation/change replay never increments revision. Independent deterministic fixtures inject failures in memory at these phases, never fill a disk, kill a process or alter real permissions. Fault controls are not available through the CLI or installed configuration.

The fault matrix also retains the real writer and lock wrapper: an injected atomic rename ENOSPC leaves actual old bytes; loss of acknowledgement after a real atomic write leaves actual new bytes and conservatively reports unknown until queried. New-save and replay lock-release acknowledgement loss are separately simulated after the real lock helper releases. These are deterministic boundary fixtures, not claims of real disk exhaustion, OS permission failure or process death. The same outer phase-aware handler catches a real release rejection if it occurs.
