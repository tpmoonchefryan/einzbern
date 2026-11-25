// SPDX-License-Identifier: Apache-2.0
import type { PackAssignment, PackPlan, PackWorkReference } from "../../protocol/src/index.js";
import type { WorkspaceState } from "./workspace.js";
import { assertPackPlanReferences } from "./workspace.js";
import { workContent, validatePackPlan } from "./work-content.js";
import { workContentContext } from "./work-content-context.js";
import type { WorkContentContext } from "./work-content-context.js";
import { dotDigest } from "./dot-execution.js";

export interface PackDispatchBinding {
  readonly packId: string;
  readonly packRevision: number;
  readonly assignmentId: string;
  readonly batchId: string;
  readonly batchAttemptId: string;
  /** Frozen plan-order roster for this dispatch attempt. */
  readonly assignmentIds: readonly string[];
  /** `active` is the observed occupied worker slots at freeze time. */
  readonly capacity: { readonly limit: number; readonly active: number | null };
  /** Present only when preparation validates an exact prior Pack application receipt. */
  readonly applicationRecovery?: { readonly priorReceiptDigest: string; readonly previousAttemptIds: readonly string[] };
}

export interface PackDispatchContext {
  readonly schemaVersion: "tcrn.pack-dispatch-context.v1";
  readonly pack: PackWorkReference;
  readonly assignment: PackAssignment;
  readonly sourceContexts: readonly { readonly work: PackWorkReference; readonly context: WorkContentContext }[];
  readonly batch: {
    readonly packRevision: number;
    readonly batchId: string;
    readonly batchAttemptId: string;
    readonly assignmentIds: readonly string[];
    readonly capacity: { readonly limit: number; readonly active: number | null };
    readonly applicationRecovery?: { readonly priorReceiptDigest: string; readonly previousAttemptIds: readonly string[] };
    readonly plannedConcurrency: number;
    readonly remainingAssignments: readonly { readonly id: string; readonly order: number; readonly status: PackAssignment["status"]; readonly role: PackAssignment["role"]; readonly parallelGroup: string | null }[];
  };
  readonly digest: string;
}

export class PackDispatchError extends Error {
  readonly reasonCode = "PACK_DISPATCH_INVALID";
}

function fail(message: string): never { throw new PackDispatchError(message); }
function positive(value: unknown, name: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(`${name} must be a positive safe integer`);
}
function text(value: unknown, name: string): void {
  if (typeof value !== "string" || !value.trim()) fail(`${name} must be nonempty text`);
}

export function validatePackDispatchBinding(value: unknown): PackDispatchBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("Pack dispatch binding must be an object");
  const row = value as Record<string, unknown>;
  const expected = ["packId", "packRevision", "assignmentId", "batchId", "batchAttemptId", "assignmentIds", "capacity"];
  const allowed = [...expected, "applicationRecovery"];
  if (Object.keys(row).some(key => !allowed.includes(key)) || expected.some(key => !Object.hasOwn(row, key))) fail("Pack dispatch binding has missing or unknown fields");
  text(row.packId, "Pack id"); positive(row.packRevision, "Pack revision"); text(row.assignmentId, "assignment id");
  text(row.batchId, "batch id"); text(row.batchAttemptId, "batch attempt id");
  if (!Array.isArray(row.assignmentIds) || row.assignmentIds.length === 0 || row.assignmentIds.some(id => typeof id !== "string" || !id.trim()) || new Set(row.assignmentIds).size !== row.assignmentIds.length) fail("frozen assignment ids must be a nonempty unique list");
  const capacity = row.capacity;
  if (capacity === null || typeof capacity !== "object" || Array.isArray(capacity)) fail("capacity observation must be an object");
  const c = capacity as Record<string, unknown>;
  if (Object.keys(c).length !== 2 || !Object.hasOwn(c, "limit") || !Object.hasOwn(c, "active")) fail("capacity observation has missing or unknown fields");
  positive(c.limit, "capacity limit");
  if (c.active !== null && (!Number.isSafeInteger(c.active) || Number(c.active) < 0)) fail("capacity active must be an observed nonnegative count or null");
  if (row.applicationRecovery !== undefined) {
    const recovery = row.applicationRecovery as Record<string, unknown> | null;
    if (!recovery || typeof recovery !== "object" || Array.isArray(recovery) || Object.keys(recovery).length !== 2 ||
        !Object.hasOwn(recovery, "priorReceiptDigest") || !Object.hasOwn(recovery, "previousAttemptIds") ||
        typeof recovery.priorReceiptDigest !== "string" || !/^[a-f0-9]{64}$/u.test(recovery.priorReceiptDigest) ||
        !Array.isArray(recovery.previousAttemptIds) || recovery.previousAttemptIds.length === 0 ||
        recovery.previousAttemptIds.some(id => typeof id !== "string" || !id.trim()) ||
        new Set(recovery.previousAttemptIds).size !== recovery.previousAttemptIds.length ||
        recovery.previousAttemptIds.includes(row.batchAttemptId)) fail("Pack application recovery must retain unique earlier application identities and an exact receipt digest");
  }
  return value as PackDispatchBinding;
}

/** Validate a retained Pack context without claiming that its old source snapshot is still current. */
export function validatePackDispatchContext(value: unknown): PackDispatchContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("Pack dispatch context must be an object");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 6 || !["schemaVersion", "pack", "assignment", "sourceContexts", "batch", "digest"].every(key => Object.hasOwn(row, key))) fail("Pack dispatch context has missing or unknown fields");
  if (row.schemaVersion !== "tcrn.pack-dispatch-context.v1") fail("unknown Pack dispatch context version");
  const { digest, ...payload } = row;
  if (typeof digest !== "string" || digest !== dotDigest(payload)) fail("Pack dispatch context digest mismatch");
  const pack = row.pack as Record<string, unknown> | null;
  if (!pack || typeof pack !== "object" || Array.isArray(pack) || Object.keys(pack).length !== 5 ||
    !["id", "externalKey", "kind", "revision", "parentId"].every(key => Object.hasOwn(pack, key)) || pack.kind !== "Pack" || pack.parentId !== null) fail("Pack dispatch context has an invalid Pack reference");
  text(pack.id, "Pack id"); text(pack.externalKey, "Pack external key"); positive(pack.revision, "Pack revision");
  const assignment = row.assignment as PackAssignment;
  if (!assignment || typeof assignment !== "object" || !["id", "order", "role", "status", "parallelGroup", "sourceWorks", "criteria", "files", "prerequisites", "resultSources", "verification"].every(key => Object.hasOwn(assignment as object, key))) fail("Pack dispatch context has no assignment row");
  const batch = row.batch as Record<string, unknown> | null;
  if (!batch || typeof batch !== "object" || Array.isArray(batch) || Object.keys(batch).length !== (Object.hasOwn(batch, "applicationRecovery") ? 8 : 7) ||
    Object.keys(batch).some(key => !["packRevision", "batchId", "batchAttemptId", "assignmentIds", "capacity", "applicationRecovery", "plannedConcurrency", "remainingAssignments"].includes(key)) ||
    !["packRevision", "batchId", "batchAttemptId", "assignmentIds", "capacity", "plannedConcurrency", "remainingAssignments"].every(key => Object.hasOwn(batch, key))) fail("Pack dispatch context has an invalid frozen batch");
  positive(batch.packRevision, "Pack revision"); text(batch.batchId, "batch id"); text(batch.batchAttemptId, "batch attempt id");
  if (batch.packRevision !== pack.revision || !Array.isArray(batch.assignmentIds) || !batch.assignmentIds.includes(assignment.id)) fail("Pack dispatch context does not bind its assignment to the frozen batch");
  if (Object.hasOwn(batch, "applicationRecovery")) validatePackDispatchBinding({
    packId: pack.id,
    packRevision: batch.packRevision,
    assignmentId: assignment.id,
    batchId: batch.batchId,
    batchAttemptId: batch.batchAttemptId,
    assignmentIds: batch.assignmentIds,
    capacity: batch.capacity,
    applicationRecovery: batch.applicationRecovery,
  });
  if (batch.assignmentIds.length === 0 || batch.assignmentIds.some(id => typeof id !== "string" || !id.trim()) || new Set(batch.assignmentIds).size !== batch.assignmentIds.length) fail("frozen Pack assignments must be unique stable IDs");
  positive(batch.plannedConcurrency, "Pack planned concurrency");
  if (!Array.isArray(batch.remainingAssignments)) fail("remaining Pack assignments must be typed rows");
  const remainingIds = new Set<string>();
  for (const item of batch.remainingAssignments) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) fail("remaining Pack assignment must be an object");
    const remaining = item as Record<string, unknown>;
    text(remaining.id, "remaining assignment id"); positive(remaining.order, "remaining assignment order");
    if (!("planned,ready,active,blocked,pending-owner-acceptance,done,cancelled".split(",").includes(String(remaining.status)) && "implementation,evidence,verification".split(",").includes(String(remaining.role)))) fail("remaining Pack assignment has an invalid status or role");
    if (remaining.parallelGroup !== null && (typeof remaining.parallelGroup !== "string" || !remaining.parallelGroup.trim())) fail("remaining Pack parallel group must be text or null");
    if (batch.assignmentIds.includes(String(remaining.id)) || remainingIds.has(String(remaining.id))) fail("remaining Pack assignments must be unique and outside the frozen roster");
    remainingIds.add(String(remaining.id));
  }
  const capacity = batch.capacity as Record<string, unknown> | null;
  if (!capacity || typeof capacity !== "object" || Array.isArray(capacity) || Object.keys(capacity).length !== 2 ||
    !Object.hasOwn(capacity, "limit") || !Object.hasOwn(capacity, "active")) fail("Pack dispatch context has an invalid capacity observation");
  positive(capacity.limit, "capacity limit");
  if (capacity.active !== null && (!Number.isSafeInteger(capacity.active) || Number(capacity.active) < 0)) fail("capacity active must be an observed nonnegative count or null");
  if (capacity.active === null || batch.assignmentIds.length > Math.max(0, Math.min(Number(batch.plannedConcurrency), Number(capacity.limit)) - Number(capacity.active))) fail("frozen Pack roster exceeds its recorded capacity snapshot");
  if (!Array.isArray(row.sourceContexts) || row.sourceContexts.length !== assignment.sourceWorks.length) fail("Pack dispatch context must retain every original source work context");
  for (const [index, source] of row.sourceContexts.entries()) {
    if (source === null || typeof source !== "object" || Array.isArray(source)) fail("Pack source context must be an object");
    const item = source as Record<string, unknown>;
    const ref = assignment.sourceWorks[index]!;
    const context = item.context as Record<string, unknown> | null;
    if (dotDigest(item.work) !== dotDigest(ref) || !context || context.workId !== ref.id || context.workRevision !== ref.revision || !Array.isArray(context.records)) fail("Pack source context differs from its pinned work reference");
  }
  return value as PackDispatchContext;
}

function livePack(state: WorkspaceState, binding: PackDispatchBinding): { readonly record: WorkspaceState["work"][number]; readonly plan: PackPlan } {
  const record = state.work.find(row => row.id === binding.packId && !row.tombstone);
  if (!record || record.kind !== "Pack" || record.revision !== binding.packRevision) fail("Pack identity or revision is not current");
  const content = workContent(record);
  if (!content?.packPlan) fail("Pack has no typed plan");
  const plan = validatePackPlan(content.packPlan);
  assertPackPlanReferences(state.work, record.projectId, plan);
  return { record, plan };
}

function sourceFor(state: WorkspaceState, assignment: PackAssignment, workId: string, workRevision: number): PackWorkReference {
  const source = assignment.sourceWorks.find(row => row.id === workId);
  if (!source || source.revision !== workRevision) fail("dispatch work is outside this Pack assignment or its revision has drifted");
  const current = state.work.find(row => row.id === source.id && !row.tombstone);
  if (!current || current.revision !== source.revision || current.externalKey !== source.externalKey || current.kind !== source.kind || current.parentId !== source.parentId) fail("assignment source work is no longer current");
  return source;
}

function resultRecorded(state: WorkspaceState, assignment: PackAssignment): boolean {
  return assignment.resultSources.length > 0 && assignment.resultSources.every(source => {
    const record = state.work.find(row => row.id === source.source.id && !row.tombstone);
    if (!record) return false;
    const content = workContent(record);
    const result = source.locator === "completion.result" ? content?.completion?.result : record.extensions["advisory:result"]?.value;
    return typeof result === "string" && result.trim().length > 0;
  });
}

function assertAssignmentReady(state: WorkspaceState, plan: PackPlan, assignment: PackAssignment): void {
  if (assignment.status !== "planned" && assignment.status !== "ready") fail(`assignment ${assignment.id} is ${assignment.status} and cannot start a new attempt`);
  for (const prerequisite of assignment.prerequisites) {
    if (prerequisite.kind === "blocked-by") {
      const blocker = state.work.find(row => row.id === prerequisite.blocker.id && !row.tombstone);
      if (!blocker || blocker.status !== prerequisite.requiredStatus) fail(`assignment ${assignment.id} is waiting for blocker ${prerequisite.blocker.id} to be ${prerequisite.requiredStatus}`);
    } else {
      const prior = plan.assignments.find(row => row.id === prerequisite.assignmentId);
      if (!prior || prior.status !== "done" || !resultRecorded(state, prior)) fail(`assignment ${assignment.id} is waiting for results from ${prerequisite.assignmentId}`);
    }
  }
  if (assignment.verification !== null) {
    for (const id of assignment.verification.afterAssignmentIds) {
      const prior = plan.assignments.find(row => row.id === id);
      if (!prior || prior.status !== "done" || !resultRecorded(state, prior)) fail(`verification assignment ${assignment.id} is waiting for recorded results from ${id}`);
    }
  }
}

/** Resolve the same persisted Pack row for general host preparation and Codex worker preparation. */
export function resolvePackDispatchContext(state: WorkspaceState, bindingValue: unknown, workId: string, workRevision: number): PackDispatchContext {
  const binding = validatePackDispatchBinding(bindingValue);
  const { record, plan } = livePack(state, binding);
  if (binding.capacity.active === null) fail("capacity is unknown; do not dispatch Pack work");
  const available = Math.max(0, Math.min(plan.maxConcurrency, binding.capacity.limit) - binding.capacity.active);
  if (binding.assignmentIds.length > available) fail("frozen Pack roster exceeds current available capacity");
  const ordered = plan.assignments.filter(row => binding.assignmentIds.includes(row.id));
  if (ordered.length !== binding.assignmentIds.length || ordered.map(row => row.id).some((id, index) => id !== binding.assignmentIds[index])) fail("frozen Pack roster must preserve stored plan order");
  const group = ordered[0]?.parallelGroup;
  if (ordered.length > 1 && (group === null || ordered.some(row => row.parallelGroup !== group))) fail("a concurrent frozen roster must share a declared parallel group");
  for (const row of ordered) assertAssignmentReady(state, plan, row);
  const assignment = plan.assignments.find(row => row.id === binding.assignmentId);
  if (!assignment || !binding.assignmentIds.includes(assignment.id)) fail("assignment is not a member of this frozen Pack dispatch");
  sourceFor(state, assignment, workId, workRevision);
  const batch = {
    packRevision: binding.packRevision,
    batchId: binding.batchId,
    batchAttemptId: binding.batchAttemptId,
    assignmentIds: [...binding.assignmentIds],
    capacity: { ...binding.capacity },
    ...(binding.applicationRecovery === undefined ? {} : { applicationRecovery: structuredClone(binding.applicationRecovery) }),
    plannedConcurrency: plan.maxConcurrency,
    remainingAssignments: plan.assignments.filter(row => !binding.assignmentIds.includes(row.id)).map(({ id, order, status, role, parallelGroup }) => ({ id, order, status, role, parallelGroup })),
  };
  const payload = {
    schemaVersion: "tcrn.pack-dispatch-context.v1" as const,
    pack: { id: record.id, externalKey: record.externalKey, kind: "Pack" as const, revision: record.revision, parentId: record.parentId },
    assignment,
    sourceContexts: assignment.sourceWorks.map(work => ({ work, context: workContentContext(state, work.id) })),
    batch,
  };
  return { ...payload, digest: dotDigest(payload) };
}

/** Put the same Pack row and original work criteria into the actual native text argument. */
export function bindPackDispatchToNativeArguments(argumentsValue: unknown, contextValue: unknown): unknown {
  const context = validatePackDispatchContext(contextValue);
  if (argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) fail("Pack dispatch needs a native argument object with a supported text field");
  const args = structuredClone(argumentsValue) as Record<string, unknown>;
  const field = ["prompt", "instructions", "task", "description", "text", "content", "message"].find(key => typeof args[key] === "string");
  if (!field) fail("Pack dispatch needs a native prompt, instructions, task, description, text, content or message field");
  const packPrompt = [
    "[Einzbern Pack assignment: follow this row and do not expand its scope]",
    `Pack: ${context.pack.externalKey} (${context.pack.id}) revision ${context.pack.revision}`,
    `Batch: ${context.batch.batchId}; application attempt: ${context.batch.batchAttemptId}`,
    `Stable assignment: ${context.assignment.id}; order ${context.assignment.order}; role ${context.assignment.role}`,
    `Pinned source work and ancestor constraints/criteria: ${JSON.stringify(context.sourceContexts)}`,
    `Acceptance and requirement references: ${JSON.stringify(context.assignment.criteria)}`,
    `Allowed files and access: ${JSON.stringify(context.assignment.files)}`,
    `Prerequisites: ${JSON.stringify(context.assignment.prerequisites)}`,
    "Read each pinned source Work item and use its original acceptance and requirement criteria. Report the Pack ID, assignment ID, attempt, result references, failures, and any incomplete work back to this coordinator.",
    "[/Einzbern Pack assignment]",
  ].join("\n");
  args[field] = `${args[field]}\n\n${packPrompt}`;
  return args;
}

/** Post-INIT enforcement is derived from the live root Initiative; no caller flag can enable it early. */
export function packDispatchRequired(state: WorkspaceState, action: string, phase: string): boolean {
  if (action !== "implementation" || phase !== "dispatch") return false;
  const initiative = state.work.find(row => !row.tombstone && row.kind === "Initiative" && row.externalKey === "TCRN-CROSS-INIT-108");
  return initiative?.status === "done";
}
