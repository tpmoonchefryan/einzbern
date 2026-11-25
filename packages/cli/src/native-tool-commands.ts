import { codexWorkerArguments, observedCodexCapacity, observedCodexUsage, observedHooks } from "../../core/src/codex-dispatch-input.js";
import { armBatchRun, advanceBatchRun, batchRunStatus, registerBatchReceipt } from "../../core/src/codex-batch-run.js";
import { prepareCodexBatch } from "../../core/src/codex-batch-prepare.js";
import { reconcileImplementationQueue } from "../../core/src/implementation-queue.js";
import { planImplementationBatch } from "../../core/src/implementation-batch.js";
import { isCodexNativeSpawn } from "../../core/src/native-tool-evidence.js";
import { recordCodexPeerBatch, normalizeCodexPeerBatch, normalizeCodexPeerBatchForEnrolledRole } from "../../core/src/codex-peer-batch.js";
import type { CodexPeerBatchInput } from "../../core/src/codex-peer-batch.js";
import type { CodexPeerBatch } from "../../core/src/codex-peer-batch.js";
import { recordAntigravitySwarmBatch, normalizeAntigravitySwarmBatch, stageAntigravitySwarmGuardFromBatch } from "../../core/src/antigravity-swarm-batch.js";
import type { AntigravitySwarmBatch, AntigravitySwarmBatchInput } from "../../core/src/antigravity-swarm-batch.js";
import { gateRunsDirectory, readGateEvidence } from "../../core/src/gates-run.js";
import { persistCodexPeerRole, resolveCodexPeerHistoricalReceipt, resolveCodexPollingPolicy } from "../../core/src/codex-peer-hooks.js";
import { codexNativeGuardHealth } from "../../core/src/codex-native-health.js";
import type { CodexHookObservation } from "../../core/src/codex-native-health.js";
import { verifyWriteAuthorization } from "../../core/src/write-authorization.js";
import { homedir } from "node:os";
import { stageCodexPeerReceipt } from "../../core/src/codex-peer-hooks.js";
import { deviceHome } from "../../core/src/device-home.js";
import { readEngineModelPolicyFile } from "../../core/src/engine-model-policy.js";
import { validateHostExecutionRequest } from "../../core/src/execution-fallback.js";
import { prepareHostNativeDispatch } from "../../core/src/dispatch-workflow.js";
import { resolvePackDispatchContext } from "../../core/src/pack-dispatch.js";
import { stageCodexSettingsIntent } from "../../core/src/codex-peer-settings.js";
import { recordHostNativeEvents, normalizeHostNativeRecord } from "../../core/src/native-tool-evidence.js";
import type { HostNativeEvent } from "../../core/src/native-tool-evidence.js";
import type { HostSelection } from "../../core/src/host-capabilities.js";
// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { canonicalJson } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import type { RuntimeCommandCatalogEntry, RuntimeCommandFlag } from "../../core/src/runtime-input-contract.js";
import { dotObject, validateDotExecutionRequest } from "../../core/src/dot-execution.js";
import { prepareNativeDispatch, recordNativeDispatch, reserveDispatchArtifact, writeDispatchArtifact } from "../../core/src/dispatch-workflow.js";
import type { NativeDispatchPreparation } from "../../core/src/dispatch-workflow.js";
import { normalizeNativeToolEvidence } from "../../core/src/native-tool-evidence.js";
import type { NativeToolAttempt, NativeToolResponseInput, NativeRetryReconciliation } from "../../core/src/native-tool-evidence.js";
import {
  inspectAntigravityProcessPreparation,
  inspectKiroProcessPreparation,
  normalizeAntigravityProcessEvidence,
  normalizeKiroProcessEvidence,
  recordAntigravityProcessEvidence,
  recordKiroProcessEvidence,
} from "../../core/src/native-tool-evidence.js";
import { planSharedSubmit, readSharedSubmitAdvisory, validateSharedSubmitAdvisory, writeSharedSubmitAdvisory } from "../../core/src/shared-submit.js";
import type { SharedSubmitInput } from "../../core/src/shared-submit.js";
import type { WorkspaceState, WorkspaceWriteLockOptions } from "../../core/src/workspace.js";

const flag = (name: string, required: boolean, valueKind = "path", valueShape?: string): RuntimeCommandFlag => ({ name, required, valueKind: valueKind === "path" ? "string" : valueKind, ...(valueShape === undefined ? {} : { valueShape }) });
export const NATIVE_TOOL_COMMAND_CATALOG: readonly RuntimeCommandCatalogEntry[] = Object.freeze([
  { name: "execution-queue-reconcile", availability: "cli", mutates: false, flags: [flag("workspace", true), flag("scope", true, "path", "All current authorized INIT grants, independent of the queue."), flag("assessments", false, "path", "Revision-bound findings and native attempt/report observations.")] },
  { name: "execution-batch-plan", availability: "cli", mutates: false, flags: [flag("from-file", true, "path", "Observed free slots, frozen candidate inputs and package write sets.")] },
  { name: "execution-antigravity-preflight", availability: "cli", mutates: true, flags: [flag("binding", true, "path", "Saved HostExecutionPreparation v1 JSON; validates Antigravity CLI scope without launching a process."), flag("reserve-output", false, "path", "Optionally reserve the private create-new evidence destination before launching Antigravity CLI.")] },
  { name: "execution-antigravity-record", availability: "cli", mutates: true, flags: [flag("binding", true, "path", "Saved Antigravity HostExecutionPreparation v1 JSON."), flag("result", false, "path", "Actual Antigravity child process return JSON; omit only for a refused preflight."), flag("output", true, "path", "Create-new private Antigravity process evidence outside device/library roots.")] },
  { name: "execution-antigravity-evidence", availability: "cli", mutates: false, flags: [flag("from-file", true, "path", "Antigravity process evidence JSON.")] },
  { name: "execution-antigravity-swarm-record", availability: "cli", mutates: true, flags: [flag("workspace", true), flag("manifest", true), flag("preparations", true), flag("observations", true), flag("prior", false), flag("output", true)] },
  { name: "execution-antigravity-swarm-evidence", availability: "cli", mutates: false, flags: [flag("from-file", true)] },
  { name: "execution-codex-batch-arm", availability: "cli", mutates: true, flags: [flag("workspace", true), flag("initiative", true, "string"), flag("coordinator", true, "string"), flag("decided-in", true, "string"), flag("existing", false)] },
  { name: "execution-codex-batch-status", availability: "cli", mutates: false, flags: [flag("coordinator", true, "string")] },
  { name: "execution-codex-batch-adopt", availability: "cli", mutates: true, flags: [flag("workspace", true), flag("from-file", true), flag("timing", false)] },
  { name: "execution-codex-batch-observe", availability: "cli", mutates: true, flags: [] },
  { name: "execution-codex-batch-prepare", availability: "cli", mutates: true, flags: [flag("workspace", true), flag("from-file", true), flag("codex-admission", true), flag("codex-capacity", true), flag("codex-usage", false), flag("output", true)] },
  { name: "execution-codex-polling-policy", availability: "cli", mutates: false, flags: [] },
  { name: "execution-codex-peer-record", availability: "cli", mutates: true, flags: [flag("workspace", true), flag("manifest", true), flag("records", true), flag("capacity", true), flag("codex-admission", false), flag("role-change", false), flag("actor", false, "string"), flag("delivery", false), flag("prior", false), flag("timing", false), flag("output", true)] },
  { name: "execution-codex-peer-evidence", availability: "cli", mutates: false, flags: [flag("from-file", true)] },
  { name: "execution-host-prepare", availability: "cli", mutates: true, flags: [flag("workspace", true), flag("request", true, "path", "HostExecutionRequest v1 JSON"), flag("codex-usage", false, "path", "Timestamped native rate-limit capture"), flag("codex-capacity", false, "path", "Timestamped native roster and observed limit"), flag("arguments", true, "path", "{selection, argumentsValue} actual request JSON"), flag("codex-peer-worker", false, "boolean"), flag("codex-startup-evidence", false, "path", "Same-ID Codex App Server thread/start response retained as {conversationId, sourceRef, raw, conversationPointer}"), flag("codex-admission", false), flag("codex-settings-intent", false, "path", "Existing Owner decision and exact settings target source; never a query permission"), flag("prior-peer-receipt", false, "path", "Exact validated prior Pack receipt required before a new Codex Pack application attempt"), flag("output", true)] },
  { name: "execution-host-record", availability: "cli", mutates: true, flags: [flag("binding", true), flag("events", false, "path", "HostNativeEvent array; absent preserves pending"), flag("prior", false), flag("output", true)] },
  { name: "execution-host-evidence", availability: "cli", mutates: false, flags: [flag("from-file", true)] },
  { name: "execution-kiro-preflight", availability: "cli", mutates: true, flags: [flag("binding", true, "path", "Saved HostExecutionPreparation v1 JSON; validates Kiro V3 scope without launching a process."), flag("reserve-output", false, "path", "Optionally reserve the private create-new evidence destination before launching Kiro.")] },
  { name: "execution-kiro-record", availability: "cli", mutates: true, flags: [flag("binding", true, "path", "Saved Kiro HostExecutionPreparation v1 JSON."), flag("result", false, "path", "Actual Kiro child process return JSON; omit only for a refused preflight."), flag("output", true, "path", "Create-new private Kiro process evidence outside device/library roots.")] },
  { name: "execution-kiro-evidence", availability: "cli", mutates: false, flags: [flag("from-file", true, "path", "Kiro process evidence JSON.")] },
  { name: "execution-native-prepare", availability: "cli", mutates: true, flags: [flag("workspace", true), flag("request", true, "path", "DotExecutionRequest JSON including actual-session contextRead"), flag("tool", true, "string"), flag("tool-contract", true, "path", "{ref,sha256} JSON"), flag("arguments", true, "path", "actual tool arguments JSON"), flag("retry-from", false, "path", "previous saved native record, required for an explicit retry"), flag("reconciliation", false, "path", "NativeRetryReconciliation; paired with retry-from"), flag("output", true)] },
  { name: "execution-native-record", availability: "cli", mutates: true, flags: [flag("binding", true), flag("response", false, "path", "NativeToolResponseInput JSON; absent keeps pending attempt"), flag("prior", false, "path", "previous saved record/history for this same attempt"), flag("output", true)] },
  { name: "execution-native-evidence", availability: "cli", mutates: false, flags: [flag("from-file", true), flag("work-id", false, "string"), flag("work-revision", false, "integer")] },
  { name: "shared-submit-plan", availability: "cli", mutates: false, flags: [flag("from-file", true)] },
  { name: "shared-submit-evidence", availability: "cli", mutates: false, flags: [flag("from-file", true)] },
  { name: "shared-submit-advisory-read", availability: "cli", mutates: false, flags: [flag("workspace", true)] },
  { name: "shared-submit-advisory-write", availability: "cli", mutates: true, flags: [flag("workspace", true), flag("from-file", true), flag("actor", true, "string"), flag("handoff-evidence", true, "string"), flag("timeout-ms", false, "integer")] },
]);
export interface NativeToolCommandContext {
  /** Existing CLI registry/path resolution and real materialization, not an arbitrary evaluator. */
  readonly resolveWorkspace: (selector: string) => Promise<{ readonly root: string; readonly state: WorkspaceState }>;
  readonly home?: string;
  readonly writeLockOptions?: WorkspaceWriteLockOptions;
  /** Inject only after the integration reserved-root audit, never from input JSON or a flag. */
  readonly advisoryStorageAuditEvidenceRef?: string;
}
function json(value: unknown): JsonValue { return JSON.parse(canonicalJson(value)) as JsonValue; }
async function input(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")) as unknown; }
/** Return null only for unowned verbs; output guards/error mapping remain the integration seam. */
export async function runNativeToolCommand(command: string, values: Readonly<Record<string, string>>, context: NativeToolCommandContext): Promise<JsonValue | null> {
  const catalog = NATIVE_TOOL_COMMAND_CATALOG.find(entry => entry.name === command); if (!catalog) return null;
  for (const key of Object.keys(values)) if (!catalog.flags.some(entry => entry.name === key)) throw new Error(`unsupported --${key}`);
  for (const f of catalog.flags) if (f.required && !values[f.name]?.trim()) throw new Error(`--${f.name} is required`);
  if (command === "execution-codex-batch-arm") {
    const workspace = await context.resolveWorkspace(values.workspace!);
    const paths = values.existing === undefined ? [] : await input(values.existing);
    if (!Array.isArray(paths) || paths.some(path => typeof path !== "string")) throw new Error("Expected a list of native receipt paths");
    return json(await armBatchRun(context.home ?? deviceHome(), workspace.state, workspace.root, values.initiative!, values.coordinator!, values["decided-in"]!, await Promise.all(paths.map(input))));
  }
  if (command === "execution-codex-batch-status") return json(await batchRunStatus(context.home ?? deviceHome(), values.coordinator!));
  if (command === "execution-codex-batch-adopt") {
    const device = context.home ?? deviceHome();
    const actor = process.env["CODEX_THREAD_ID"] ?? process.env["CODEX_SESSION_ID"];
    if (!actor || (await resolveCodexPollingPolicy(device, actor)).scope !== "native-children") throw new Error("Only the original coordinator adopts a retained batch");
    const workspace = await context.resolveWorkspace(values.workspace!);
    const batch = normalizeCodexPeerBatch(await input(values["from-file"]!));
    if (batch.manifest.coordinator.conversationId !== actor || batch.schemaVersion === "tcrn.codex-peer-batch.v1") throw new Error("Use a scoped native receipt of this coordinator");
    await registerBatchReceipt(device, actor, workspace.state, batch, values.timing === undefined ? undefined : await input(values.timing));
    return json(await batchRunStatus(device, actor));
  }
  if (command === "execution-codex-batch-observe") {
    const device = context.home ?? deviceHome();
    const actor = process.env["CODEX_THREAD_ID"] ?? process.env["CODEX_SESSION_ID"];
    if (!actor || (await resolveCodexPollingPolicy(device, actor)).scope !== "native-children") throw new Error("Only an enrolled Economy coordinator observes native workers");
    await advanceBatchRun(device, actor);
    return json(await batchRunStatus(device, actor));
  }
  if (command === "execution-codex-batch-prepare") {
    const workspace = await context.resolveWorkspace(values.workspace!);
    const prepared = await prepareCodexBatch(workspace.state, await input(values["from-file"]!), await input(values["codex-capacity"]!),
      await input(values["codex-admission"]!), values["codex-usage"] === undefined ? undefined : await input(values["codex-usage"]!), context.home ?? deviceHome());
    await writeDispatchArtifact(values.output!, prepared, [workspace.root], context.home);
    return json(prepared);
  }
  if (command === "execution-codex-polling-policy") {
    return json(await resolveCodexPollingPolicy(context.home ?? deviceHome(), process.env["CODEX_THREAD_ID"] ?? process.env["CODEX_SESSION_ID"]));
  }
  if (command === "execution-queue-reconcile") {
    const workspace = await context.resolveWorkspace(values.workspace!);
    const assessments = values.assessments === undefined ? {} : await input(values.assessments);
    return json(reconcileImplementationQueue(workspace.state, await input(values.scope!), assessments));
  }
  if (command === "execution-batch-plan") return json(planImplementationBatch(await input(values["from-file"]!)));
  if (command === "execution-antigravity-swarm-evidence") return json(normalizeAntigravitySwarmBatch(await input(values["from-file"]!)));
  if (command === "execution-antigravity-swarm-record") {
    const workspace = await context.resolveWorkspace(values.workspace!);
    const manifest = await input(values.manifest!) as AntigravitySwarmBatchInput["manifest"];
    const preparations = await input(values.preparations!) as AntigravitySwarmBatchInput["preparations"];
    const observations = await input(values.observations!) as AntigravitySwarmBatchInput["observations"];
    const prior = values.prior === undefined ? undefined : await input(values.prior);
    const policy = await readEngineModelPolicyFile(context.home);
    const referenced = new Set([manifest?.workId, ...(Array.isArray(manifest?.members) ? manifest.members.map(member => member?.workId) : [])]);
    const workRevisions = workspace.state.work.filter(row => !row.tombstone && referenced.has(row.id)).map(row => ({ id: row.id, revision: row.revision }));
    let result: unknown;
    const observationCutoff = new Date().toISOString();
    try {
      const batch = recordAntigravitySwarmBatch({ observationCutoff, manifest, preparations, observations, policy, workRevisions, ...(prior === undefined ? {} : { prior }) });
      const libraryId = workspace.state.metadata.workspaceId;
      const directory = gateRunsDirectory(libraryId, context.home);
      for (const entry of batch.observations.boardDeliverables ?? []) {
        if (entry.gateRunIds === undefined) continue;
        const workId = entry.author === "coordinator"
          ? batch.manifest.workId
          : batch.manifest.members.find(member => member.name === entry.author)?.workId;
        if (!workId) throw new Error("gate evidence requires a bound swarm member or coordinator");
        for (const id of entry.gateRunIds) {
          if (!await readGateEvidence(directory, id, libraryId, workId)) {
            throw new Error(`gate evidence unavailable for swarm member ${entry.author}: ${id}`);
          }
        }
      }
      result = batch;
    } catch (error) {
      result = { reasonCode: "ANTIGRAVITY_SWARM_RECORD_INVALID", observationCutoff, manifest, preparations, observations, ...(prior === undefined ? {} : { prior }), validation: { status: "invalid" }, problems: [String(error)] };
    }
    await writeDispatchArtifact(values.output!, result, [workspace.root], context.home);
    if ((result as { schemaVersion?: unknown }).schemaVersion === "tcrn.antigravity-swarm-batch.v1") {
      await stageAntigravitySwarmGuardFromBatch(result as AntigravitySwarmBatch, context.home ?? deviceHome(), workspace.state.metadata.workspaceId);
    }
    return json(result);
  }
  if (command === "execution-codex-peer-evidence") {
    const value = await input(values["from-file"]!);
    try {
      return json(normalizeCodexPeerBatch(value));
    } catch (error) {
      let recovery;
      try { recovery = await resolveCodexPeerHistoricalReceipt(context.home ?? deviceHome(), value); }
      catch { throw error; }
      if (recovery.status === "matched") return json(normalizeCodexPeerBatchForEnrolledRole(value, recovery.identity));
      if (recovery.status === "wrong-batch") throw new Error("legacy v2 receipt attempt is recorded in the enrolled role under another batch");
      if (recovery.status === "tampered") throw new Error("legacy v2 receipt differs from the exact receipt stored in enrolled role history");
      throw error;
    }
  }
  if (command === "execution-codex-peer-record") {
    const workspace = await context.resolveWorkspace(values.workspace!);
    const manifest = await input(values.manifest!) as CodexPeerBatchInput["manifest"];
    const records = await input(values.records!) as CodexPeerBatchInput["records"];
    const capacity = await input(values.capacity!) as CodexPeerBatchInput["capacity"];
    const delivery = values.delivery === undefined ? undefined : await input(values.delivery!) as CodexPeerBatchInput["delivery"];
    const prior = values.prior === undefined ? undefined : await input(values.prior);
    const policy = await readEngineModelPolicyFile(context.home);
    const referenced = new Set([manifest?.workId, manifest?.pack?.packId, ...(Array.isArray(manifest?.members) ? manifest.members.map(member => member?.workId) : [])]);
    const workRevisions = workspace.state.work.filter(row => !row.tombstone && referenced.has(row.id)).map(row => ({ id: row.id, revision: row.revision }));
    let result: unknown;
    const observationCutoff = new Date().toISOString();
    try {
      if (manifest.pack) {
        for (const member of manifest.members) {
          resolvePackDispatchContext(workspace.state, {
            packId: manifest.pack.packId, packRevision: manifest.pack.packRevision, assignmentId: member.assignmentId,
            batchId: manifest.batchId, batchAttemptId: manifest.attemptId,
            assignmentIds: manifest.pack.assignmentIds, capacity: manifest.pack.capacity,
          }, member.workId, member.workRevision);
        }
      }
      result = recordCodexPeerBatch({ observationCutoff, manifest, records, capacity, policy, workRevisions, ...(delivery === undefined ? {} : { delivery }), ...(prior === undefined ? {} : { prior }) });
    }
    catch (error) { result = { reasonCode: "CODEX_PEER_RECORD_INVALID", observationCutoff, manifest, records, capacity, ...(delivery === undefined ? {} : { delivery }), ...(prior === undefined ? {} : { prior }), validation: { status: "invalid" }, problems: [String(error)] }; }
    await writeDispatchArtifact(values.output!, result, [workspace.root], context.home);
    if (["tcrn.codex-peer-batch.v2", "tcrn.codex-peer-batch.v3"].includes(String((result as { schemaVersion?: unknown }).schemaVersion))) {
      try {
        const change = values["role-change"] === undefined ? undefined : dotObject(await input(values["role-change"]), "peer role lifecycle", ["operation", "decidedIn"]);
        if (change && !["retire", "activate", "recover"].includes(String(change.operation))) throw new Error("unknown peer role lifecycle operation");
        let decidedIn: string | null = null;
        if (change && change.operation !== "recover") {
          if (!values.actor) throw new Error("role lifecycle requires the actual --actor");
          const authorization = await verifyWriteAuthorization({ state: workspace.state, decidedIn: String(change.decidedIn), target: `codex-peer-roles.${manifest.coordinator.conversationId}.${String(change.operation)}`, ...(context.home ? { home: context.home } : {}) });
          decidedIn = authorization.decidedIn;
        }
        const role = await persistCodexPeerRole({ receipt: result as CodexPeerBatch, device: context.home ?? deviceHome(),
          sessionId: process.env["CODEX_THREAD_ID"] ?? process.env["CODEX_SESSION_ID"], libraryId: workspace.state.metadata.workspaceId,
          actor: values.actor ?? "agent:codex", ...(change ? { change: { operation: change.operation as "retire" | "activate" | "recover", decidedIn } } : {}) });
        if (role.status === "active") {
          const admission = values["codex-admission"] === undefined ? undefined : await input(values["codex-admission"]) as { native?: CodexHookObservation; state?: string; trust?: string; preToolUse?: boolean };
          const health = await codexNativeGuardHealth({ device: context.home ?? deviceHome(), home: homedir(), cwd: process.cwd(), ...(admission?.state === "supported" && admission.trust === "permitted" && admission.preToolUse === true && admission.native ? { observation: admission.native } : {}) });
          if (!health.ready) return json({ reasonCode: "CODEX_PEER_GUARD_NOT_READY", receipt: result, role, nativeGuard: health, receiptFile: values.output });
        }
        await stageCodexPeerReceipt(result as CodexPeerBatch, context.home ?? deviceHome(), process.env["CODEX_THREAD_ID"] ?? process.env["CODEX_SESSION_ID"]);
        if (role.status === "active") await registerBatchReceipt(context.home ?? deviceHome(), process.env["CODEX_THREAD_ID"] ?? process.env["CODEX_SESSION_ID"], workspace.state,
          result as CodexPeerBatch, values.timing === undefined ? undefined : await input(values.timing));
      } catch (error) {
        return json({ reasonCode: "CODEX_PEER_GUARD_NOT_READY", receipt: result, problems: [String(error)], receiptFile: values.output });
      }
    }
    return json(result);
  }
  if (command === "execution-host-prepare") {
    const workspace = await context.resolveWorkspace(values.workspace!);
    const raw = await input(values.request!) as Record<string, unknown>;
    const caps = raw.capabilities as Record<string, unknown> | undefined;
    let requestValue: unknown = raw;
    if (values["codex-usage"] || values["codex-capacity"]) {
      if (caps?.hostKind !== "codex") throw new Error("Codex observations require a Codex request");
      const usage = values["codex-usage"] ? observedCodexUsage(await input(values["codex-usage"])) : undefined;
      const capacity = values["codex-capacity"] ? observedCodexCapacity(await input(values["codex-capacity"])) : undefined;
      requestValue = { ...raw, capabilities: { ...caps, ...(usage ? { usage } : {}), ...(capacity ? { platformCapacity: capacity } : {}) } };
    }
    const request = validateHostExecutionRequest(requestValue);
    const tool = dotObject(await input(values.arguments!), "tool request", ["selection", "argumentsValue"]);
    if (!Object.hasOwn(tool, "argumentsValue")) throw new Error("actual tool arguments are required");
    if (values["codex-peer-worker"] !== undefined && !["true", "false"].includes(values["codex-peer-worker"])) throw new Error("codex-peer-worker must be true or false");
    const admission = values["codex-admission"] === undefined ? undefined : await input(values["codex-admission"]) as { native?: CodexHookObservation; state?: string; trust?: string; preToolUse?: boolean };
    const settingsIntent = values["codex-settings-intent"] === undefined ? undefined : await input(values["codex-settings-intent"]);
    const priorPeerReceipt = values["prior-peer-receipt"] === undefined ? undefined : await input(values["prior-peer-receipt"]);
    if (values["codex-startup-evidence"] !== undefined && values["codex-peer-worker"] !== "true") throw new Error("--codex-startup-evidence applies only to --codex-peer-worker true");
    const startupEvidence = values["codex-startup-evidence"] === undefined ? undefined : await input(values["codex-startup-evidence"]);
    const preparedTool = request.capabilities.hostKind === "codex" && isCodexNativeSpawn(request.capabilities.toolName)
      ? codexWorkerArguments(request, { selection: tool.selection, argumentsValue: tool.argumentsValue })
      : tool as { selection: HostSelection; argumentsValue: unknown };
    const hooks = observedHooks(admission);
    const result = await prepareHostNativeDispatch(workspace.state, request, { ...preparedTool, workspaceRoot: workspace.root, peerWorker: values["codex-peer-worker"] === "true", ...(startupEvidence === undefined ? {} : { codexCoordinatorStartup: startupEvidence }), ...(settingsIntent === undefined ? {} : { codexSettingsIntent: settingsIntent }), ...(priorPeerReceipt === undefined ? {} : { priorPeerReceipt }), ...(hooks ? { codexObservation: hooks } : {}) }, context.home);
    await writeDispatchArtifact(values.output!, result, [workspace.root], context.home);
    if (settingsIntent !== undefined && result.attempt) {
      const sessionId = process.env["CODEX_THREAD_ID"] ?? process.env["CODEX_SESSION_ID"];
      if (!sessionId) throw new Error("settings preparation lost its native session");
      await stageCodexSettingsIntent({ device: context.home ?? deviceHome(), sessionId, workspaceRoot: workspace.root,
        workId: result.decision.request.workId, workRevision: result.decision.request.workRevision,
        attemptId: result.attempt.id, argumentsValue: result.attempt.argumentsValue, intent: settingsIntent });
    }
    return json({ reasonCode: result.attempt ? "HOST_PREPARATION_READY" : "HOST_PREPARATION_NOT_EXECUTABLE", ...result });
  }
  if (command === "execution-host-record") {
    const binding = await input(values.binding!);
    const events = values.events === undefined ? [] : await input(values.events!) as HostNativeEvent[];
    const prior = values.prior === undefined ? undefined : await input(values.prior);
    let result: unknown;
    try { result = recordHostNativeEvents(binding, events, prior); }
    catch (error) { result = { reasonCode: "HOST_RECORD_INVALID", binding, events, ...(prior === undefined ? {} : { prior }), validation: { status: "invalid" }, problems: [String(error)] }; }
    await writeDispatchArtifact(values.output!, result, [], context.home);
    return json(result);
  }
  if (command === "execution-host-evidence") return json(normalizeHostNativeRecord(await input(values["from-file"]!)));
  if (command === "execution-antigravity-preflight") {
    const preflight = inspectAntigravityProcessPreparation(await input(values.binding!));
    if (values["reserve-output"] === undefined) return json(preflight);
    const reservation = await reserveDispatchArtifact(values["reserve-output"], [], context.home);
    return json({ ...preflight, reservation });
  }
  if (command === "execution-antigravity-record") {
    const preparation = await input(values.binding!);
    const processReturn = values.result === undefined ? undefined : await input(values.result!);
    const result = recordAntigravityProcessEvidence(preparation, processReturn);
    await writeDispatchArtifact(values.output!, result, [], context.home);
    return json(result);
  }
  if (command === "execution-antigravity-evidence") return json(normalizeAntigravityProcessEvidence(await input(values["from-file"]!)));
  if (command === "execution-kiro-preflight") {
    const preflight = inspectKiroProcessPreparation(await input(values.binding!));
    if (values["reserve-output"] === undefined) return json(preflight);
    const reservation = await reserveDispatchArtifact(values["reserve-output"], [], context.home);
    return json({ ...preflight, reservation });
  }
  if (command === "execution-kiro-record") {
    const preparation = await input(values.binding!);
    const processReturn = values.result === undefined ? undefined : await input(values.result!);
    const result = recordKiroProcessEvidence(preparation, processReturn);
    await writeDispatchArtifact(values.output!, result, [], context.home);
    return json(result);
  }
  if (command === "execution-kiro-evidence") return json(normalizeKiroProcessEvidence(await input(values["from-file"]!)));
  if (command === "execution-native-prepare") {
    const workspace = await context.resolveWorkspace(values.workspace!);
    const request = validateDotExecutionRequest(await input(values.request!));
    const contract = dotObject(await input(values["tool-contract"]!), "tool contract", ["ref", "sha256"]);
    if ((values["retry-from"] === undefined) !== (values.reconciliation === undefined)) throw new Error("--retry-from and --reconciliation must be supplied together");
    const retry = values["retry-from"] === undefined ? undefined : { previous: await input(values["retry-from"]!), reconciliation: await input(values.reconciliation!) as NativeRetryReconciliation };
    const result = await prepareNativeDispatch(workspace.state, request, { toolName: values.tool!, toolContractObservation: contract as unknown as NativeToolAttempt["toolContractObservation"], argumentsValue: await input(values.arguments!) }, context.home, retry);
    await writeDispatchArtifact(values.output!, result, [workspace.root], context.home);
    return json({ reasonCode: result.attempt ? "NATIVE_PREPARATION_READY" : "NATIVE_PREPARATION_REFUSED", ...result });
  }
  if (command === "execution-native-record") {
    const preparation = await input(values.binding!) as NativeDispatchPreparation;
    const response = values.response === undefined ? undefined : await input(values.response!) as NativeToolResponseInput;
    const prior = values.prior === undefined ? undefined : await input(values.prior);
    let result: unknown;
    try { result = recordNativeDispatch(preparation, response, prior); }
    catch (error) {
      // Preserve raw failed/unassociated source material in the same private create-new path.
      result = { reasonCode: "NATIVE_RECORD_INVALID", preparation, ...(prior === undefined ? {} : { prior }), ...(response === undefined ? {} : { response }), normalized: { requested: true, evidenceType: "native-tool", valid: false, complete: false, status: "invalid", problems: [String(error)] } };
    }
    await writeDispatchArtifact(values.output!, result, [], context.home);
    return json(result);
  }
  if (command === "execution-native-evidence") {
    const revision = values["work-revision"];
    if (revision !== undefined && (!/^[1-9][0-9]*$/u.test(revision) || !Number.isSafeInteger(Number(revision)))) throw new Error("--work-revision must be a positive safe integer");
    return json(normalizeNativeToolEvidence(await input(values["from-file"]!), { ...(values["work-id"] === undefined ? {} : { workId: values["work-id"] }), ...(revision === undefined ? {} : { workRevision: Number(revision) }) }));
  }
  if (command === "shared-submit-plan" || command === "shared-submit-evidence") return json(planSharedSubmit(await input(values["from-file"]!) as SharedSubmitInput));
  const workspace = await context.resolveWorkspace(values.workspace!);
  if (command === "shared-submit-advisory-read") return json(await readSharedSubmitAdvisory(workspace.root, context.home));
  if (command === "shared-submit-advisory-write") {
    if (!context.advisoryStorageAuditEvidenceRef) throw new Error("shared-submit advisory storage has not passed the integration reserved-root audit");
    const advisory = validateSharedSubmitAdvisory(await input(values["from-file"]!));
    return json(await writeSharedSubmitAdvisory(workspace.root, advisory, { actor: values.actor!, handoffEvidenceRef: values["handoff-evidence"]!, storageAuditEvidenceRef: context.advisoryStorageAuditEvidenceRef, ...(context.home === undefined ? {} : { home: context.home }), ...(context.writeLockOptions === undefined ? {} : { writeLockOptions: context.writeLockOptions }) }));
  }
  throw new Error(`cataloged native command has no handler: ${command}`);
}
