// SPDX-License-Identifier: Apache-2.0

// INIT-076: a recoverable receipt for host-native independent Codex conversations. This
// module does not launch, poll, send messages, authenticate a host or grant authorization.
// Native lifecycle evidence has one implementation: native-tool-evidence.ts.
import { dotInstant } from "./dot-execution.js";
import { canonicalSha256, parseStrictInstant } from "../../protocol/src/index.js";
import { hasCodexReportSessionSetting } from "./codex-peer-settings.js";
import { hostObject, hostText, HostExecutionError } from "./host-capabilities.js";
import { codexPeerReadiness, resolveEngineExecutionPolicyFromSnapshot, validateEngineModelPolicySnapshot } from "./engine-model-policy.js";
import type { EngineModelPolicyFile } from "./engine-model-policy.js";
import { normalizeHostNativeRecord, recordHostNativeEvents, isCodexNativeSpawn } from "./native-tool-evidence.js";
import type { HostNativeRecord } from "./native-tool-evidence.js";
import { validatePackDispatchContext } from "./pack-dispatch.js";
import type { PackDispatchBinding } from "./pack-dispatch.js";
import type { WorkspaceState } from "./workspace.js";

export interface CodexPeerManifest {
  readonly schemaVersion: "tcrn.codex-peer-manifest.v1";
  readonly host: "codex";
  readonly batchId: string;
  readonly attemptId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly policyDigest: string;
  readonly main: { readonly conversationId: string; readonly sourceRef: string; readonly raw: unknown; readonly conversationPointer: string };
  readonly coordinator: CodexPeerCoordinatorStartupEvidence;
  readonly pack?: { readonly packId: string; readonly packRevision: number; readonly assignmentIds: readonly string[]; readonly capacity: { readonly limit: number; readonly active: number } };
  readonly recovery?: { readonly priorReceiptDigest: string; readonly previousCoordinatorIds: readonly string[] };
  readonly applicationRecovery?: { readonly priorReceiptDigest: string; readonly previousAttemptIds: readonly string[] };
  readonly members: readonly { readonly attemptId: string; readonly workId: string; readonly workRevision: number; readonly conversationId: string | null; readonly assignmentId?: string }[];
}
/** Same-conversation startup receipt returned by the supported Codex thread/start entry. */
export interface CodexPeerCoordinatorStartupEvidence {
  readonly conversationId: string;
  readonly sourceRef: string;
  readonly raw: unknown;
  readonly conversationPointer: string;
}
export interface CodexPeerDelivery {
  readonly record: HostNativeRecord;
  /** JSON pointer into the actual send arguments, not invented transport parameters. */
  readonly recipientPointer: string;
  /** Pointer to actual send text beginning with codexPeerReportPrefix(manifest). */
  readonly correlationPointer: string;
  readonly batchId: string;
  readonly batchAttemptId: string;
}
export interface CodexPeerBatchInput {
  /** Observation boundary supplied by the recorder, never by host input JSON. */
  readonly observationCutoff: string;
  readonly manifest: CodexPeerManifest;
  readonly records: readonly HostNativeRecord[];
  readonly policy: EngineModelPolicyFile;
  readonly capacity: { readonly limit: number; readonly active: number | null };
  readonly delivery?: CodexPeerDelivery | null;
  readonly prior?: unknown;
  readonly applicationHistory?: readonly CodexPeerApplicationAttempt[];
  readonly workRevisions?: readonly { readonly id: string; readonly revision: number }[];
}
export interface CodexPeerApplicationAttempt {
  readonly schemaVersion: "tcrn.codex-peer-application-attempt.v1";
  readonly receiptSchemaVersion: "tcrn.codex-peer-batch.v2" | "tcrn.codex-peer-batch.v3";
  readonly receiptDigest: string;
  readonly observationCutoff: string;
  readonly manifest: CodexPeerManifest;
  readonly records: readonly HostNativeRecord[];
  readonly applicationHistory?: readonly CodexPeerApplicationAttempt[];
  readonly policy: EngineModelPolicyFile;
  readonly capacity: { readonly limit: number; readonly active: number | null };
  readonly delivery: CodexPeerDelivery | null;
  readonly workRevisions: CodexPeerBatchInput["workRevisions"] | null;
  readonly readiness: ReturnType<typeof codexPeerReadiness>;
  readonly requestedPeers: {
    readonly main: ReturnType<typeof resolveEngineExecutionPolicyFromSnapshot>["record"];
    readonly coordinator: ReturnType<typeof resolveEngineExecutionPolicyFromSnapshot>["record"];
  } | null;
  readonly reportPrefix: string;
  readonly blockedReasons: readonly string[];
  readonly allTerminal: boolean;
  readonly deliveryStatus: "not-attempted" | "unknown" | "confirmed" | "failed";
  readonly reportEligible: boolean;
  readonly occupancy: number;
  readonly authority: "receipt-only-not-execution-authorization";
  readonly digest: string;
}
function fail(message: string): never { throw new HostExecutionError(`Codex peer receipt: ${message}`); }
function positive(value: unknown, name: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(`${name} must be a positive safe integer`);
}
function nativeId(value: unknown): void {
  hostText(value, "actual conversation id");
  if (String(value).startsWith("local-attempt:")) fail("local correlation is not a conversation identity");
}
function atPointer(value: unknown, path: string): unknown {
  if (typeof path !== "string" || !path.startsWith("/")) fail("actual native field needs a JSON pointer");
  let found = value;
  for (const segment of path.slice(1).split("/")) {
    if (/~(?![01])/u.test(segment)) fail("invalid JSON pointer escape");
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (found === null || typeof found !== "object" || !Object.hasOwn(found, key)) fail("native field was not returned");
    found = (found as Record<string, unknown>)[key];
  }
  return found;
}
/** Validate the actual effective permission returned with this coordinator's thread/start ID.
 * The two pointer pairs are the App Server 0.171.0 JSON-RPC response and its direct result.
 * A thread/read response with no sandbox field remains unknown; no permission pointer is caller-selected. */
export function assertCodexPeerCoordinatorStartup(value: unknown, actualSessionId?: string): CodexPeerCoordinatorStartupEvidence {
  const coordinator = hostObject(value, "coordinator startup evidence", ["conversationId", "sourceRef", "raw", "conversationPointer"]);
  nativeId(coordinator.conversationId);
  hostText(coordinator.sourceRef, "native startup evidence");
  const id = String(coordinator.conversationId);
  if (actualSessionId !== undefined && id !== actualSessionId) fail("coordinator startup conversation ID differs from the actual native session; effective Full Access is unknown for this session");
  const idPointer = String(coordinator.conversationPointer);
  const permissionPointer = idPointer === "/result/thread/id" ? "/result/sandbox/type"
    : idPointer === "/thread/id" ? "/sandbox/type"
      : null;
  if (permissionPointer === null) fail("coordinator startup evidence needs a supported thread/start response; effective Full Access is unknown");
  let returnedId: unknown;
  let permission: unknown;
  try {
    returnedId = atPointer(coordinator.raw, idPointer);
    permission = atPointer(coordinator.raw, permissionPointer);
  } catch {
    fail("coordinator thread/start response is missing its same-ID effective sandbox field; permission is unknown");
  }
  if (returnedId !== id) fail("coordinator conversation ID differs from the retained thread/start response; effective Full Access is unknown");
  if (permission === "workspaceWrite") fail("coordinator effective sandbox is restricted (workspaceWrite); Full Access is required before dispatch");
  if (permission !== "dangerFullAccess") fail(`coordinator effective sandbox is unknown (${permission === undefined ? "missing" : String(permission)}); dangerFullAccess is required before dispatch`);
  return structuredClone(coordinator) as unknown as CodexPeerCoordinatorStartupEvidence;
}
interface EnrolledRoleRecoveryIdentity {
  readonly coordinatorId: string;
  readonly mainId: string;
}

export function isRecognizedEnrolledThreadReadSource(sourceRef: unknown): boolean {
  const reference = String(sourceRef);
  return /(?:^|\s)thread\/read(?:\s|$)/u.test(reference) ||
    /(?:^|[\\/])thread-read\.economy\.(?:dispatch\.)?raw\.json$/u.test(reference);
}

/** Older enrolled v2 roles retain a native thread/read result rather than a startup permission
 * field. This proves the original thread identity only; it never supplies or implies sandbox access. */
function assertEnrolledLegacyCoordinatorReadback(
  coordinator: Record<string, unknown>,
  identity: EnrolledRoleRecoveryIdentity,
): void {
  if (coordinator.conversationId !== identity.coordinatorId || coordinator.conversationPointer !== "/result/thread/id" ||
      !isRecognizedEnrolledThreadReadSource(coordinator.sourceRef)) {
    fail("legacy coordinator receipt does not match the enrolled thread/read identity");
  }
  const raw = hostObject(coordinator.raw, "legacy coordinator thread/read receipt", ["id", "result"]);
  if (!Object.hasOwn(raw, "id") || (typeof raw.id !== "string" && typeof raw.id !== "number")) {
    fail("legacy coordinator thread/read receipt has no native response id");
  }
  const result = hostObject(raw.result, "legacy coordinator thread/read result", ["thread", "readState"]);
  if (!Object.hasOwn(result, "thread") || !Object.hasOwn(result, "readState")) {
    fail("legacy coordinator thread/read receipt is incomplete");
  }
  const thread = result.thread;
  const readState = result.readState;
  if (thread === null || typeof thread !== "object" || Array.isArray(thread) ||
      (readState === null || typeof readState !== "object" || Array.isArray(readState))) {
    fail("legacy coordinator thread/read receipt has invalid native fields");
  }
  if ((thread as Record<string, unknown>).id !== identity.coordinatorId ||
      atPointer(raw, "/result/thread/id") !== identity.coordinatorId) {
    fail("legacy coordinator thread/read ID differs from the enrolled role");
  }
}

function manifestOf(value: unknown, enrolledRole?: EnrolledRoleRecoveryIdentity): CodexPeerManifest {
  const m = hostObject(value, "peer manifest", ["schemaVersion", "host", "batchId", "attemptId", "workId", "workRevision", "policyDigest", "main", "coordinator", "pack", "recovery", "applicationRecovery", "members"]);
  if (m.schemaVersion !== "tcrn.codex-peer-manifest.v1" || m.host !== "codex") fail("explicit Codex manifest required; other hosts retain their own workflow");
  for (const key of ["batchId", "attemptId", "workId"]) hostText(m[key], key);
  positive(m.workRevision, "work revision");
  if (typeof m.policyDigest !== "string" || !/^[a-f0-9]{64}$/u.test(m.policyDigest)) fail("policy digest must bind the planned host policy");
  const main = hostObject(m.main, "main", ["conversationId", "sourceRef", "raw", "conversationPointer"]);
  const coordinator = hostObject(m.coordinator, "coordinator", ["conversationId", "sourceRef", "raw", "conversationPointer"]);
  for (const peer of [main, coordinator]) { nativeId(peer.conversationId); hostText(peer.sourceRef, "native identity evidence"); }
  if (main.conversationId === coordinator.conversationId) fail("main and economy coordinator must be independent conversations");
  if (atPointer(main.raw, String(main.conversationPointer)) !== main.conversationId) fail("peer conversation identity differs from retained native response");
  if (enrolledRole === undefined) {
    assertCodexPeerCoordinatorStartup(coordinator);
  } else {
    if (coordinator.conversationId !== enrolledRole.coordinatorId || main.conversationId !== enrolledRole.mainId) {
      fail("legacy coordinator receipt differs from its enrolled role identity");
    }
    try {
      assertCodexPeerCoordinatorStartup(coordinator);
    } catch {
      assertEnrolledLegacyCoordinatorReadback(coordinator, enrolledRole);
    }
  }
  const manifest = m as unknown as CodexPeerManifest;
  if (!Array.isArray(m.members) || m.members.length === 0) fail("fixed nonempty worker membership required");
  const attempts = new Set<string>();
  const conversations = new Set([manifest.main.conversationId, manifest.coordinator.conversationId]);
  const assignmentIds = new Set<string>();
  for (const value of m.members) {
    const member = hostObject(value, "member", ["attemptId", "workId", "workRevision", "conversationId", "assignmentId"]);
    hostText(member.attemptId, "member attempt"); hostText(member.workId, "member work"); positive(member.workRevision, "member revision");
    if (attempts.has(String(member.attemptId))) fail("duplicate member attempt");
    attempts.add(String(member.attemptId));
    if (member.conversationId !== null) {
      nativeId(member.conversationId);
      if (conversations.has(String(member.conversationId))) fail("worker conversation reused in fixed membership");
      conversations.add(String(member.conversationId));
    }
    if (m.pack !== undefined) {
      hostText(member.assignmentId, "Pack assignment id");
      if (assignmentIds.has(String(member.assignmentId))) fail("a Pack assignment may appear only once in a frozen Codex roster");
      assignmentIds.add(String(member.assignmentId));
    } else if (member.assignmentId !== undefined) fail("member assignment ids require a Pack manifest binding");
  }
  if (m.pack !== undefined) {
    const pack = hostObject(m.pack, "Pack manifest", ["packId", "packRevision", "assignmentIds", "capacity"]);
    hostText(pack.packId, "Pack id"); positive(pack.packRevision, "Pack revision");
    if (!Array.isArray(pack.assignmentIds) || pack.assignmentIds.length !== manifest.members.length || pack.assignmentIds.some(id => typeof id !== "string" || !id.trim()) ||
        new Set(pack.assignmentIds).size !== pack.assignmentIds.length || (pack.assignmentIds as string[]).some((id, index) => id !== manifest.members[index]?.assignmentId)) fail("Pack assignment roster must exactly match fixed Codex membership and stored order");
    const capacity = hostObject(pack.capacity, "Pack frozen capacity", ["limit", "active"]);
    positive(capacity.limit, "Pack capacity limit");
    if (!Number.isSafeInteger(capacity.active) || Number(capacity.active) < 0) fail("Pack capacity active must be an observed nonnegative count");
    if ((pack.assignmentIds as string[]).length > Math.max(0, Number(capacity.limit) - Number(capacity.active))) fail("Pack fixed membership exceeds capacity at freeze time");
  }
  if (m.recovery !== undefined) {
    const recovery = hostObject(m.recovery, "coordinator recovery", ["priorReceiptDigest", "previousCoordinatorIds"]);
    if (typeof recovery.priorReceiptDigest !== "string" || !/^[a-f0-9]{64}$/u.test(recovery.priorReceiptDigest)) fail("recovery must bind the exact prior receipt digest");
    if (!Array.isArray(recovery.previousCoordinatorIds) || recovery.previousCoordinatorIds.length === 0 || recovery.previousCoordinatorIds.some(id => typeof id !== "string" || !id.trim()) ||
        new Set(recovery.previousCoordinatorIds).size !== recovery.previousCoordinatorIds.length || (recovery.previousCoordinatorIds as string[]).includes(String(manifest.coordinator.conversationId))) fail("recovery must list unique prior coordinator conversation identities");
  }
  if (m.applicationRecovery !== undefined) {
    const recovery = hostObject(m.applicationRecovery, "application recovery", ["priorReceiptDigest", "previousAttemptIds"]);
    if (typeof recovery.priorReceiptDigest !== "string" || !/^[a-f0-9]{64}$/u.test(recovery.priorReceiptDigest)) fail("application recovery must bind the exact prior receipt digest");
    if (!Array.isArray(recovery.previousAttemptIds) || recovery.previousAttemptIds.length === 0 || recovery.previousAttemptIds.some(id => typeof id !== "string" || !id.trim()) ||
        new Set(recovery.previousAttemptIds).size !== recovery.previousAttemptIds.length || (recovery.previousAttemptIds as string[]).includes(String(manifest.attemptId))) fail("application recovery must list unique prior application attempts");
  }
  return structuredClone(manifest);
}
/** Correlation only: this marker grants neither authorization nor conversation identity. */
export function codexPeerReportPrefix(value: CodexPeerManifest): string {
  return reportPrefixFromManifest(manifestOf(value));
}
function reportPrefixFromManifest(value: CodexPeerManifest): string {
  return `Einzbern-Codex-Peer-Manifest-SHA256: ${canonicalSha256(value)}\n`;
}
function observedBy(record: HostNativeRecord, cutoff: bigint): void {
  const decision = record.preparation.decision;
  if (parseStrictInstant(decision.evaluatedAt) > cutoff) fail("native preparation evaluation is after observation cutoff");
  const capabilities = decision.request.capabilities;
  const observations = [...(capabilities.selectionObservations ?? []), ...(capabilities.usage ? [capabilities.usage] : [])];
  for (const observation of observations) {
    if (parseStrictInstant(observation.observedAt) > cutoff) fail("native preparation observation is after observation cutoff");
  }
  if (dotInstant(record.preparation.attempt?.requestedAt, "requestedAt") > cutoff) fail("native preparation is after observation cutoff");
  for (const event of record.events) {
    if (dotInstant(event.at, "event at") > cutoff) fail("native event is after observation cutoff");
  }
}
function codexRecord(value: unknown): HostNativeRecord {
  const record = normalizeHostNativeRecord(value);
  if (record.preparation.decision.request.capabilities.hostKind !== "codex") fail("non-Codex record cannot enable peer coordination");
  return record;
}
/** Resolve ownership symmetrically: a collision invalidates every claimant, not just
 * the record encountered last. Fixed identities remain reserved even without a receipt. */
function associatedMembers(manifest: CodexPeerManifest, records: readonly HostNativeRecord[], blockedReasons: string[]): Set<string> {
  const owners = new Map<string, Set<string>>();
  const reserve = (id: string, owner: string): void => {
    const claims = owners.get(id) ?? new Set<string>();
    claims.add(owner); owners.set(id, claims);
  };
  reserve(manifest.main.conversationId, "main");
  reserve(manifest.coordinator.conversationId, "coordinator");
  for (const member of manifest.members) if (member.conversationId !== null) reserve(member.conversationId, member.attemptId);
  const observations = records.map(record => {
    const attemptId = record.preparation.attempt!.id;
    const ids = new Set(record.events.filter(event => event.providerId).map(event => {
      const id = atPointer(event.raw, event.providerId!.pointer); nativeId(id); return String(id);
    }));
    for (const id of ids) reserve(id, attemptId);
    return { record, attemptId, ids };
  });
  const associated = new Set<string>();
  for (const { record, attemptId, ids } of observations) {
    const member = manifest.members.find(row => row.attemptId === attemptId)!;
    const drift = ids.size > 1 || (member.conversationId !== null && [...ids].some(id => id !== member.conversationId));
    const reused = [...ids].some(id => owners.get(id)!.size > 1);
    if (drift) blockedReasons.push(`native-identity-drift:${attemptId}`);
    if (ids.size === 0) blockedReasons.push(`native-identity-unknown:${attemptId}`);
    if (reused) blockedReasons.push(`native-identity-reused:${attemptId}`);
    if (record.conflicts.length > 0) blockedReasons.push(`native-conflict:${attemptId}`);
    if (ids.size === 1 && !drift && !reused && record.conflicts.length === 0) associated.add(attemptId);
  }
  return associated;
}
function derive(
  input: Omit<CodexPeerBatchInput, "prior">,
  version: CodexPeerBatch["schemaVersion"] = "tcrn.codex-peer-batch.v2",
  enrolledRole?: EnrolledRoleRecoveryIdentity,
): CodexPeerBatch {
  const cutoff = dotInstant(input.observationCutoff, "observation cutoff");
  const manifest = manifestOf(input.manifest, enrolledRole);
  const applicationHistory = version === "tcrn.codex-peer-batch.v3"
    ? validateApplicationHistory(input.applicationHistory, manifest)
    : undefined;
  if (version !== "tcrn.codex-peer-batch.v3" && input.applicationHistory !== undefined && input.applicationHistory.length > 0) {
    fail("application history requires the v3 peer receipt");
  }
  const policy = validateEngineModelPolicySnapshot(input.policy);
  const capacity = hostObject(input.capacity, "capacity", ["limit", "active"]);
  positive(capacity.limit, "capacity limit");
  if (capacity.active !== null && (!Number.isSafeInteger(capacity.active) || Number(capacity.active) < 0)) fail("capacity active must be observed nonnegative count or null");
  if (!Array.isArray(input.records)) fail("records must be an array");
  const records = input.records.map(codexRecord);
  for (const record of records) observedBy(record, cutoff);
  const seen = new Set<string>();
  const blockedReasons: string[] = [];
  const workRevisions = input.workRevisions ?? null;
  if (workRevisions === null) blockedReasons.push("work-revisions-unknown");
  else {
    if (!Array.isArray(workRevisions)) fail("current work revisions must be an array");
    const ids = new Set<string>();
    for (const row of workRevisions) {
      hostObject(row, "work revision", ["id", "revision"]); hostText(row.id, "work id"); positive(row.revision, "current revision");
      if (ids.has(row.id)) fail("duplicate current work revision"); ids.add(row.id);
    }
    for (const item of [{ workId: manifest.workId, workRevision: manifest.workRevision }, ...manifest.members]) {
      if (workRevisions.find(row => row.id === item.workId)?.revision !== item.workRevision) blockedReasons.push(`work-revision-drift:${item.workId}`);
    }
    if (manifest.pack && workRevisions.find(row => row.id === manifest.pack!.packId)?.revision !== manifest.pack.packRevision) blockedReasons.push(`pack-revision-drift:${manifest.pack.packId}`);
  }
  for (const record of records) {
    const attempt = record.preparation.attempt!;
    const member = manifest.members.find(row => row.attemptId === attempt.id);
    if (!member || seen.has(attempt.id)) fail("unexpected or duplicate worker attempt");
    seen.add(attempt.id);
    const request = record.preparation.decision.request;
    if (version === "tcrn.codex-peer-batch.v2" || version === "tcrn.codex-peer-batch.v3") {
      const permittedCoordinators = new Set([manifest.coordinator.conversationId, ...(manifest.recovery?.previousCoordinatorIds ?? [])]);
      if (!isCodexNativeSpawn(record.preparation.attempt?.toolName) || request.action === "coordination" ||
          !permittedCoordinators.has(String(record.preparation.codexPeerWorker?.coordinatorId))) fail("worker must bind the native coordinator and collaboration.spawn_agent; independent create/fork is not a worker");
      const dispatch = record.events.filter(event => event.kind === "host-response" && isCodexNativeSpawn(event.sourceTool) && event.providerId);
      if (record.events.some(event => event.providerId) && dispatch.length === 0) fail("worker identity needs the retained native spawn return, not only a wait/status response");
    }
    if (request.workId !== member.workId || request.workRevision !== member.workRevision) fail("member work revision drift");
    if (manifest.pack) {
      const pack = validatePackDispatchContext(record.preparation.context.packDispatch);
      if (pack.pack.id !== manifest.pack.packId || pack.pack.revision !== manifest.pack.packRevision || pack.assignment.id !== member.assignmentId ||
          pack.batch.batchId !== manifest.batchId || pack.batch.batchAttemptId !== manifest.attemptId ||
          canonicalSha256(pack.batch.assignmentIds) !== canonicalSha256(manifest.pack.assignmentIds) ||
          canonicalSha256(pack.batch.capacity) !== canonicalSha256(manifest.pack.capacity) ||
          canonicalSha256(pack.batch.applicationRecovery ?? null) !== canonicalSha256(manifest.applicationRecovery ?? null) ||
          !pack.assignment.sourceWorks.some(source => source.id === member.workId && source.revision === member.workRevision)) fail("worker native record does not consume its frozen Pack row");
    } else if (record.preparation.context.packDispatch !== undefined) fail("worker Pack context is missing from the fixed peer manifest");
  }
  const associated = associatedMembers(manifest, records, blockedReasons);
  for (const member of manifest.members) if (!seen.has(member.attemptId)) blockedReasons.push(`member-outcome-unknown:${member.attemptId}`);
  const readiness = codexPeerReadiness(manifest.host, policy.hosts.codex);
  if (!readiness.ready) blockedReasons.push("model-groups-not-ready");
  // Requested intent for the host-supported peer creation/selection, never an assertion that
  // a conversation actually ran this model or that the host exposes that selection today.
  const requestedPeers = readiness.ready ? {
    main: resolveEngineExecutionPolicyFromSnapshot(policy, { host: "codex", category: "main", rejections: 0 }).record,
    coordinator: resolveEngineExecutionPolicyFromSnapshot(policy, { host: "codex", category: "economy", rejections: 0 }).record,
  } : null;
  if (policy.hosts.codex?.digest !== manifest.policyDigest) blockedReasons.push("policy-drift");
  const occupancy = manifest.members.length - records.filter(record => associated.has(record.preparation.attempt!.id) && record.occupancy === "released").length;
  if (capacity.active === null) blockedReasons.push("capacity-unknown");
  else if (Number(capacity.active) > Number(capacity.limit) || occupancy > Number(capacity.limit)) blockedReasons.push("capacity-exceeded");
  const allTerminal = records.length === manifest.members.length && records.every(record => associated.has(record.preparation.attempt!.id) && record.executionFinality === "confirmed");
  let delivery: CodexPeerDelivery | null = null;
  let deliveryStatus: "not-attempted" | "unknown" | "confirmed" | "failed" = "not-attempted";
  if (input.delivery != null) {
    const d = hostObject(input.delivery, "delivery", ["record", "recipientPointer", "correlationPointer", "batchId", "batchAttemptId"]);
    const record = codexRecord(d.record);
    observedBy(record, cutoff);
    if (record.preparation.decision.request.action !== "coordination") fail("delivery must be an actual coordination attempt");
    const attempt = record.preparation.attempt!;
    if (d.batchId !== manifest.batchId || d.batchAttemptId !== manifest.attemptId || record.preparation.decision.request.workId !== manifest.workId || record.preparation.decision.request.workRevision !== manifest.workRevision || seen.has(attempt.id)) fail("delivery belongs to another batch/work attempt");
    if (atPointer(attempt.argumentsValue, String(d.recipientPointer)) !== manifest.main.conversationId) fail("delivery recipient differs from main conversation");
    const text = atPointer(attempt.argumentsValue, String(d.correlationPointer));
    if (typeof text !== "string" || !text.startsWith(reportPrefixFromManifest(manifest))) fail("delivery text does not bind the immutable batch manifest");
    delivery = { record, recipientPointer: String(d.recipientPointer), correlationPointer: String(d.correlationPointer), batchId: manifest.batchId, batchAttemptId: manifest.attemptId };
    deliveryStatus = record.executionFinality !== "confirmed" ? "unknown" : record.execution === "completed" ? "confirmed" : "failed";
    // A send completion is not the report boundary. requestedAt is the retained
    // preparation/request boundary, not authenticated transport time. Only evidence
    // strictly before it can support the report; equal times cannot establish order.
    // Replaying the retained event prefix also prevents later identity/terminal facts
    // from retroactively making an early report final (including input without prior).
    const sentAt = dotInstant(attempt.requestedAt, "delivery requestedAt");
    const beforeSend = records.filter(worker => dotInstant(worker.preparation.attempt!.requestedAt, "worker requestedAt") < sentAt)
      .map(worker => recordHostNativeEvents(worker.preparation, worker.events.filter(event => dotInstant(event.at, "event at") < sentAt)));
    const associatedBeforeSend = associatedMembers(manifest, beforeSend, []);
    if (!allTerminal || beforeSend.length !== manifest.members.length || !beforeSend.every(worker =>
      associatedBeforeSend.has(worker.preparation.attempt!.id) && worker.executionFinality === "confirmed")) blockedReasons.push("delivery-before-terminal-batch");
  }
  const payload = {
    schemaVersion: version,
    observationCutoff: input.observationCutoff,
    manifest, records, policy, capacity: { limit: Number(capacity.limit), active: capacity.active === null ? null : Number(capacity.active) },
    delivery, workRevisions, readiness, requestedPeers, reportPrefix: reportPrefixFromManifest(manifest), blockedReasons, allTerminal, deliveryStatus,
    reportEligible: allTerminal && blockedReasons.length === 0 && delivery === null,
    occupancy,
    authority: "receipt-only-not-execution-authorization" as const,
    ...(applicationHistory === undefined ? {} : { applicationHistory }),
  };
  return { ...payload, digest: canonicalSha256(payload) };
}
export interface CodexPeerBatch {
  readonly observationCutoff: string;
  readonly schemaVersion: "tcrn.codex-peer-batch.v1" | "tcrn.codex-peer-batch.v2" | "tcrn.codex-peer-batch.v3";
  readonly manifest: CodexPeerManifest;
  readonly records: readonly HostNativeRecord[];
  readonly policy: EngineModelPolicyFile;
  readonly capacity: { readonly limit: number; readonly active: number | null };
  readonly delivery: CodexPeerDelivery | null;
  readonly workRevisions: CodexPeerBatchInput["workRevisions"] | null;
  readonly readiness: ReturnType<typeof codexPeerReadiness>;
  readonly requestedPeers: {
    readonly main: ReturnType<typeof resolveEngineExecutionPolicyFromSnapshot>["record"];
    readonly coordinator: ReturnType<typeof resolveEngineExecutionPolicyFromSnapshot>["record"];
  } | null;
  readonly reportPrefix: string;
  readonly blockedReasons: readonly string[];
  readonly allTerminal: boolean;
  readonly deliveryStatus: "not-attempted" | "unknown" | "confirmed" | "failed";
  readonly reportEligible: boolean;
  readonly occupancy: number;
  readonly authority: "receipt-only-not-execution-authorization";
  readonly applicationHistory?: readonly CodexPeerApplicationAttempt[];
  readonly digest: string;
}
function validateApplicationHistory(rawHistory: unknown, manifest: CodexPeerManifest): readonly CodexPeerApplicationAttempt[] {
  if (!Array.isArray(rawHistory) || rawHistory.length === 0) fail("v3 peer receipts need a nonempty prior application history");
  if (!manifest.pack || !manifest.applicationRecovery) fail("application history needs a Pack-bound application recovery manifest");
  const history: CodexPeerApplicationAttempt[] = [];
  const applicationIds = new Set<string>();
  const workerAttemptIds = new Set<string>();
  for (const [index, historyValue] of rawHistory.entries()) {
    const row = hostObject(historyValue, "prior application attempt", [
      "schemaVersion", "receiptSchemaVersion", "receiptDigest", "observationCutoff", "manifest", "records", "policy", "capacity", "delivery",
      "workRevisions", "readiness", "requestedPeers", "reportPrefix", "blockedReasons", "allTerminal", "deliveryStatus", "reportEligible", "occupancy", "authority", "applicationHistory", "digest",
    ]);
    if (row.schemaVersion !== "tcrn.codex-peer-application-attempt.v1" ||
        (row.receiptSchemaVersion !== "tcrn.codex-peer-batch.v2" && row.receiptSchemaVersion !== "tcrn.codex-peer-batch.v3")) {
      fail("unknown prior application attempt version");
    }
    if (typeof row.receiptDigest !== "string" || !/^[a-f0-9]{64}$/u.test(row.receiptDigest)) fail("prior application receipt digest is invalid");
    const { digest, ...payload } = row;
    if (typeof digest !== "string" || digest !== canonicalSha256(payload)) fail("prior application history digest mismatch");
    const oldManifest = manifestOf(row.manifest);
    if (!oldManifest.pack || oldManifest.batchId !== manifest.batchId || oldManifest.workId !== manifest.workId || oldManifest.workRevision !== manifest.workRevision ||
        oldManifest.pack.packId !== manifest.pack.packId || oldManifest.pack.packRevision !== manifest.pack.packRevision) {
      fail("application history belongs to another Pack, batch or work revision");
    }
    if (applicationIds.has(oldManifest.attemptId) || oldManifest.attemptId === manifest.attemptId) fail("application history repeats an application attempt");
    applicationIds.add(oldManifest.attemptId);
    if (index === 0 && row.receiptSchemaVersion !== "tcrn.codex-peer-batch.v2") fail("application history must begin with its original v2 attempt");
    if (index > 0 && row.receiptSchemaVersion !== "tcrn.codex-peer-batch.v3") fail("later application attempts must retain the v3 history chain");
    const recovery = oldManifest.applicationRecovery;
    if (index === 0 && recovery !== undefined) fail("the first retained application attempt cannot point to another missing attempt");
    if (index > 0 && (!recovery || recovery.priorReceiptDigest !== history[index - 1]!.receiptDigest ||
        canonicalSha256(recovery.previousAttemptIds) !== canonicalSha256(history.map(item => item.manifest.attemptId)))) {
      fail("prior application attempt sequence or receipt digest changed");
    }
    if (!Array.isArray(row.records)) fail("prior application records must be an array");
    const records = row.records.map(codexRecord);
    for (const record of records) {
      const attemptId = record.preparation.attempt!.id;
      if (workerAttemptIds.has(attemptId)) fail("native worker attempt ID was reused across application attempts");
      workerAttemptIds.add(attemptId);
    }
    if (row.receiptSchemaVersion === "tcrn.codex-peer-batch.v2" && row.applicationHistory !== undefined) fail("original v2 application cannot declare nested history");
    if (row.receiptSchemaVersion === "tcrn.codex-peer-batch.v3" && !Array.isArray(row.applicationHistory)) fail("prior v3 application must retain its receipt history");
    const {
      schemaVersion: _historyVersion,
      receiptSchemaVersion: sourceVersion,
      receiptDigest: sourceDigest,
      digest: _historyDigest,
      ...receiptFields
    } = row;
    const normalized = normalizeCodexPeerBatch({
      ...receiptFields,
      records,
      schemaVersion: sourceVersion,
      digest: sourceDigest,
    });
    const normalizedSnapshot = applicationAttemptSnapshot(normalized);
    if (canonicalSha256(normalizedSnapshot) !== canonicalSha256(row)) fail("prior application result differs from retained native evidence");
    history.push({ ...payload, records, digest } as unknown as CodexPeerApplicationAttempt);
  }
  if (applicationIds.has(manifest.attemptId)) fail("current application attempt repeats a retained attempt");
  const recovery = manifest.applicationRecovery;
  const expectedAttemptIds = history.map(item => item.manifest.attemptId);
  if (recovery.priorReceiptDigest !== history.at(-1)!.receiptDigest ||
      canonicalSha256(recovery.previousAttemptIds) !== canonicalSha256(expectedAttemptIds)) {
    fail("current application attempt does not continue the retained receipt sequence");
  }
  assertNoApplicationAssignmentReplay(history, manifest);
  return history;
}

function assertNoApplicationAssignmentReplay(history: readonly CodexPeerApplicationAttempt[], manifest: {
  readonly pack?: { readonly packId: string; readonly packRevision: number };
  readonly members: readonly { readonly assignmentId?: string }[];
}): void {
  if (!manifest.pack) return;
  for (const member of manifest.members) {
    if (!member.assignmentId) fail("Pack member has no assignment identity");
    for (const prior of history) {
      if (prior.manifest.pack?.packId !== manifest.pack.packId || prior.manifest.pack.packRevision !== manifest.pack.packRevision) continue;
      if (!prior.manifest.pack.assignmentIds.includes(member.assignmentId)) continue;
      const oldMember = prior.manifest.members.find(row => row.assignmentId === member.assignmentId);
      if (!oldMember) fail("Pack assignment " + member.assignmentId + " was in the prior frozen roster but has no retained member attempt; do not redispatch");
      const record = prior.records.find(row => row.preparation.attempt?.id === oldMember.attemptId);
      if (!record || record.executionFinality !== "confirmed" || record.occupancy !== "released") {
        fail("Pack assignment " + member.assignmentId + " has unknown or in-flight occupancy in application " + prior.manifest.attemptId + "; do not redispatch");
      }
      if (record.execution === "completed") {
        fail("Pack assignment " + member.assignmentId + " already completed in application " + prior.manifest.attemptId + "; do not redispatch");
      }
    }
  }
}

/** Fail before worker preparation unless a new Pack attempt is bound to an exact, safe predecessor receipt. */
export function codexPackApplicationRecovery(priorValue: unknown, binding: PackDispatchBinding,
  state: WorkspaceState): NonNullable<CodexPeerManifest["applicationRecovery"]> {
  const prior = normalizeCodexPeerBatch(priorValue);
  const old = prior.manifest;
  // The manifest scopes the batch; the live Pack independently checks each worker's work and revision.
  const currentScope = state.work.some(work => work.id === old.workId && work.revision === old.workRevision && !work.tombstone);
  if (prior.schemaVersion === "tcrn.codex-peer-batch.v1" || !old.pack ||
      old.pack.packId !== binding.packId || old.pack.packRevision !== binding.packRevision ||
      old.batchId !== binding.batchId || !currentScope ||
      [...(prior.applicationHistory ?? []).map(attempt => attempt.manifest.attemptId), old.attemptId].includes(binding.batchAttemptId)) {
    fail("new Pack application attempt must continue the same Pack, batch and work with a distinct application identity");
  }
  const history = [...(prior.applicationHistory ?? []), applicationAttemptSnapshot(prior)];
  assertNoApplicationAssignmentReplay(history, {
    pack: { packId: binding.packId, packRevision: binding.packRevision },
    members: [{ assignmentId: binding.assignmentId }],
  });
  return {
    priorReceiptDigest: prior.digest,
    previousAttemptIds: [...(prior.applicationHistory ?? []).map(attempt => attempt.manifest.attemptId), old.attemptId],
  };
}

function applicationAttemptSnapshot(receipt: CodexPeerBatch): CodexPeerApplicationAttempt {
  const {
    schemaVersion: receiptSchemaVersion,
    digest: receiptDigest,
    ...receiptFields
  } = receipt;
  const payload = {
    schemaVersion: "tcrn.codex-peer-application-attempt.v1" as const,
    receiptSchemaVersion,
    receiptDigest,
    ...receiptFields,
  };
  return { ...payload, digest: canonicalSha256(payload) } as unknown as CodexPeerApplicationAttempt;
}
const PEER_RECEIPT_FIELDS = [
  "schemaVersion", "observationCutoff", "manifest", "records", "policy", "capacity", "delivery", "workRevisions", "readiness",
  "requestedPeers", "reportPrefix", "blockedReasons", "allTerminal", "deliveryStatus", "reportEligible", "occupancy", "authority",
  "applicationHistory", "digest",
] as const;

/** Recompute derived fields; a file cannot declare itself complete or authorized. */
function normalizeCodexPeerBatchInternal(value: unknown, enrolledRole?: EnrolledRoleRecoveryIdentity): CodexPeerBatch {
  const row = hostObject(value, "peer receipt", PEER_RECEIPT_FIELDS);
  const hasHistory = row.schemaVersion === "tcrn.codex-peer-batch.v3";
  if (row.schemaVersion !== "tcrn.codex-peer-batch.v1" && row.schemaVersion !== "tcrn.codex-peer-batch.v2" && !hasHistory) fail("unknown receipt version");
  if (hasHistory && !Object.hasOwn(row, "applicationHistory")) fail("v3 peer receipt has no application history");
  const allowed = ["schemaVersion", "observationCutoff", "manifest", "records", "policy", "capacity", "delivery", "workRevisions", "readiness", "requestedPeers", "reportPrefix", "blockedReasons", "allTerminal", "deliveryStatus", "reportEligible", "occupancy", "authority", "digest", ...(hasHistory ? ["applicationHistory"] : [])];
  if (Object.keys(row).length !== allowed.length || allowed.some(key => !Object.hasOwn(row, key))) fail("peer receipt has missing or unknown fields");
  const calculated = derive({ ...row, workRevisions: row.workRevisions ?? undefined } as unknown as CodexPeerBatchInput, row.schemaVersion as CodexPeerBatch["schemaVersion"], enrolledRole);
  if (canonicalSha256(calculated) !== canonicalSha256(row)) fail("receipt differs from retained native evidence");
  return calculated;
}
export function normalizeCodexPeerBatch(value: unknown): CodexPeerBatch {
  return normalizeCodexPeerBatchInternal(value);
}
/** Recovery-only parser for a v2 receipt already enclosed by a validated enrollment anchor. */
export function normalizeCodexPeerBatchForEnrolledRole(
  value: unknown,
  identity: EnrolledRoleRecoveryIdentity,
): CodexPeerBatch {
  const row = hostObject(value, "peer receipt", PEER_RECEIPT_FIELDS);
  if (row.schemaVersion !== "tcrn.codex-peer-batch.v2") return normalizeCodexPeerBatchInternal(value);
  hostText(identity.coordinatorId, "enrolled coordinator id");
  hostText(identity.mainId, "enrolled main id");
  return normalizeCodexPeerBatchInternal(value, identity);
}
/** Monotonic merge of same-batch receipts. Unknown delivery is retained, never retried by us. */
export function recordCodexPeerBatch(input: CodexPeerBatchInput): CodexPeerBatch {
  const prior = input.prior === undefined ? null : normalizeCodexPeerBatch(input.prior);
  if (input.delivery && !prior?.delivery) {
    const argumentsValue = input.delivery.record.preparation.attempt?.argumentsValue;
    if (hasCodexReportSessionSetting(argumentsValue)) fail("ordinary final delivery must omit model, thinking, effort, serviceTier and serviceTierForTurn; record an authorized settings adjustment separately");
  }
  if (prior?.schemaVersion === "tcrn.codex-peer-batch.v1") fail("legacy peer receipts remain historical and unguarded; start a new scoped native worker batch");
  const cutoff = dotInstant(input.observationCutoff, "observation cutoff");
  if (prior && cutoff < dotInstant(prior.observationCutoff, "prior observation cutoff")) fail("observation cutoff moved backwards; reconcile the clock before resuming");
  const manifest = manifestOf(input.manifest);
  let startsNewApplication = false;
  if (manifest.applicationRecovery !== undefined) {
    if (!prior) fail("new Pack application attempt requires its retained prior receipt");
    if (manifest.attemptId === prior.manifest.attemptId) {
      const expectedAttemptIds = (prior.applicationHistory ?? []).map(attempt => attempt.manifest.attemptId);
      const previousReceiptDigest = prior.applicationHistory?.at(-1)?.receiptDigest;
      if (!prior.manifest.applicationRecovery ||
          canonicalSha256(prior.manifest.applicationRecovery) !== canonicalSha256(manifest.applicationRecovery) ||
          !previousReceiptDigest || manifest.applicationRecovery.priorReceiptDigest !== previousReceiptDigest ||
          canonicalSha256(manifest.applicationRecovery.previousAttemptIds) !== canonicalSha256(expectedAttemptIds)) {
        fail("current Pack application must preserve its original retained receipt sequence");
      }
    } else {
      if (manifest.recovery !== undefined) fail("coordinator recovery and a new application attempt cannot be combined");
      const expectedAttemptIds = [...(prior.applicationHistory ?? []).map(attempt => attempt.manifest.attemptId), prior.manifest.attemptId];
      if (prior.manifest.batchId !== manifest.batchId ||
          prior.manifest.workId !== manifest.workId || prior.manifest.workRevision !== manifest.workRevision ||
          prior.manifest.main.conversationId !== manifest.main.conversationId ||
          !prior.manifest.pack || !manifest.pack || prior.manifest.pack.packId !== manifest.pack.packId ||
          prior.manifest.pack.packRevision !== manifest.pack.packRevision ||
          manifest.applicationRecovery.priorReceiptDigest !== prior.digest ||
          canonicalSha256(manifest.applicationRecovery.previousAttemptIds) !== canonicalSha256(expectedAttemptIds)) {
        fail("new Pack application attempt must preserve the stable Pack identity and exact preceding receipt sequence");
      }
      startsNewApplication = true;
    }
  }
  if (prior && canonicalSha256(prior.manifest) !== canonicalSha256(manifest)) {
    const old = prior.manifest;
    const sameFrozenBatch = old.batchId === manifest.batchId && old.attemptId === manifest.attemptId && old.workId === manifest.workId && old.workRevision === manifest.workRevision &&
      old.policyDigest === manifest.policyDigest && canonicalSha256(old.main) === canonicalSha256(manifest.main) &&
      canonicalSha256(old.members) === canonicalSha256(manifest.members) && canonicalSha256(old.pack ?? null) === canonicalSha256(manifest.pack ?? null) &&
      canonicalSha256(old.applicationRecovery ?? null) === canonicalSha256(manifest.applicationRecovery ?? null) &&
      old.coordinator.conversationId !== manifest.coordinator.conversationId;
    const expectedPriorCoordinators = [...(old.recovery?.previousCoordinatorIds ?? []), old.coordinator.conversationId];
    const sameCoordinatorHandoff = sameFrozenBatch && manifest.recovery?.priorReceiptDigest === prior.digest &&
      canonicalSha256(manifest.recovery.previousCoordinatorIds) === canonicalSha256(expectedPriorCoordinators);
    if (!startsNewApplication && !sameCoordinatorHandoff) {
      fail("immutable manifest changed; coordinator handoff must preserve the frozen batch and bind the exact prior receipt");
    }
  }
  let applicationHistory = prior?.applicationHistory ?? [];
  if (startsNewApplication) {
    applicationHistory = [...applicationHistory, applicationAttemptSnapshot(prior!)];
    assertNoApplicationAssignmentReplay(applicationHistory, manifest);
  }
  const records = [...(startsNewApplication ? [] : prior?.records ?? [])];
  for (const value of input.records) {
    const next = codexRecord(value);
    const index = records.findIndex(record => record.preparation.attempt?.id === next.preparation.attempt?.id);
    if (index === -1) records.push(next);
    else records[index] = recordHostNativeEvents(next.preparation, next.events, records[index]);
  }
  let delivery = startsNewApplication ? input.delivery ?? null : input.delivery ?? prior?.delivery ?? null;
  if (!startsNewApplication && prior?.delivery && input.delivery) {
    if (input.delivery.batchId !== prior.delivery.batchId || input.delivery.batchAttemptId !== prior.delivery.batchAttemptId || input.delivery.recipientPointer !== prior.delivery.recipientPointer || input.delivery.correlationPointer !== prior.delivery.correlationPointer) fail("delivery association changed");
    delivery = { ...input.delivery, record: recordHostNativeEvents(input.delivery.record.preparation, input.delivery.record.events, prior.delivery.record) };
  }
  const schemaVersion = applicationHistory.length > 0 ? "tcrn.codex-peer-batch.v3" : "tcrn.codex-peer-batch.v2";
  return derive({
    ...input,
    manifest,
    records,
    delivery,
    ...(applicationHistory.length > 0 ? { applicationHistory } : {}),
  }, schemaVersion);
}
