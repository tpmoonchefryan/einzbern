// SPDX-License-Identifier: Apache-2.0
import { isWorkStatus } from "../../protocol/src/index.js";
import type { WorkRecord, WorkStatus } from "../../protocol/src/index.js";
import { workContent } from "./work-content.js";
import { workAcceptanceMeaningDigest } from "./work-acceptance.js";
import { storedRelations } from "./work-relations.js";

// These labels and the existing active/done/blocked states replay on older readers.
// Only the validation transition writes a marker. Existing done records stay done.
const pending = "einzbern:validation:pending";
const passed = "einzbern:validation:passed";
const blocked = "einzbern:validation:blocked";
const repair = "einzbern:validation:repair";
const markers = new Set([pending, passed, blocked, repair]);
export type WorkflowStatus = WorkStatus | "pending-validate" | "validated";

export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return isWorkStatus(value) || value === "pending-validate" || value === "validated";
}

export function workflowStatus<S extends string>(record: { readonly status: S; readonly labels?: readonly string[] }): S | "pending-validate" | "validated" {
  if (record.status === "active" && record.labels?.includes(pending)) return "pending-validate";
  if (record.status === "done" && record.labels?.includes(passed)) return "validated";
  return record.status;
}

export function isValidationLabel(label: string): boolean { return markers.has(label); }

export function implementationReady(record: WorkRecord): boolean {
  return ["pending-validate", "done", "validated", "cancelled"].includes(workflowStatus(record));
}

export function implementationChildren(work: readonly WorkRecord[], parent: WorkRecord): readonly WorkRecord[] {
  const allocations = workContent(parent)?.allocations ?? [];
  return work.filter(child => {
    if (child.parentId !== parent.id || child.tombstone) return false;
    if (!["Epic", "Story", "Subtask"].includes(child.kind)) return false;
    const assigned = allocations.filter(row => row.childId === child.id);
    return !assigned.length || assigned.some(row => row.responsibility === "implementation");
  });
}

// Applicability is recorded separately from the work status. An edit expires the
// observation by advancing the revision. A new applicable child also reopens the scope.
const conditionPrefix = "einzbern:implementation:untriggered:";
export function isConditionLabel(label: string): boolean { return label.startsWith(conditionPrefix); }
export function conditionLabel(revision: number): string { return conditionPrefix + revision; }

export function conditionUntriggered(work: readonly WorkRecord[], item: WorkRecord): boolean {
  if (!item.labels?.includes(conditionLabel(item.revision))) return false;
  return implementationChildren(work, item).every(child => child.status === "cancelled" || conditionUntriggered(work, child));
}

export function verificationOnly(parent: WorkRecord, child: WorkRecord): boolean {
  const assigned = workContent(parent)?.allocations.filter(row => row.childId === child.id) ?? [];
  return assigned.length > 0 && assigned.every(row => row.responsibility === "verification");
}

export function initiativeValidationProblem(work: readonly WorkRecord[], item: WorkRecord): string | null {
  const byId = new Map(work.filter(row => !row.tombstone).map(row => [row.id, row]));
  let root: WorkRecord | undefined = item;
  while (root && root.kind !== "Initiative") root = root.parentId ? byId.get(root.parentId) : undefined;
  if (!root || root.status === "cancelled") return "formal validation requires a live Initiative";
  const epics = work.filter(row => !row.tombstone && row.parentId === root.id && row.kind === "Epic");
  // Once formal validation opened, a failed Epic returns to repair without stopping other Epics.
  const alreadyOpen = workflowStatus(root) === "pending-validate";
  function readyForFormal(row: WorkRecord): boolean {
    if (conditionUntriggered(work, row)) return true;
    if (row.status === "done" || row.status === "cancelled") return true;
    if (row.labels?.includes(repair) || row.labels?.includes(blocked)) return row.kind !== "Epic" || alreadyOpen;
    if (!implementationReady(row)) return false;
    return implementationChildren(work, row).every(readyForFormal);
  }
  const unfinished = epics.filter(epic => !readyForFormal(epic));
  return unfinished.length ? "Epic implementation is still open: " + unfinished.map(row => row.externalKey ?? row.id).join(", ") : null;
}

export function validationDispatchProblem(work: readonly WorkRecord[], item: WorkRecord, action: string | undefined): string | null {
  const status = workflowStatus(item);
  if ((action === "implementation" || action === "validation" || action === undefined) && conditionUntriggered(work, item)) return "record the observed trigger before dispatching conditional work";
  if (action === "validation") {
    if (status !== "pending-validate") return "formal validation requires pending-validate work";
    return initiativeValidationProblem(work, item);
  }
  if (status === "pending-validate" && (action === "implementation" || action === undefined)) return "implementation is already pending validation";
  return null;
}

export function validationTransition(work: readonly WorkRecord[], item: WorkRecord, target: WorkflowStatus, summary?: string | null, criteria?: readonly string[]): {
  status: WorkStatus; marker?: string; problem?: string;
} {
  if (!["Initiative", "Epic", "Story", "Subtask"].includes(item.kind)) {
    if (target === "validated" || target === "pending-validate") return { status: item.status, problem: "INIT validation applies only to delivery work" };
    return { status: target };
  }
  const from = workflowStatus(item);
  const isBlocked = item.status === "blocked" && item.labels?.includes(blocked);
  if (target === from && item.labels?.some(isValidationLabel)) return { status: item.status, problem: "work already has status " + target };
  if (target !== "cancelled" && conditionUntriggered(work, item)) return { status: item.status, problem: "reconcile the implementation condition before changing work status" };
  if (target === "done" && from !== "validated") {
    let root: WorkRecord | undefined = item;
    while (root && root.parentId) {
      const parentId: string = root.parentId;
      root = work.find(row => row.id === parentId && !row.tombstone);
    }
    if (item.labels?.some(isValidationLabel) || (root?.kind === "Initiative" && workContent(root)?.details.acceptanceScope === "initiative")) {
      return { status: "done", problem: "INIT acceptance records a pending-validate to validated transition" };
    }
  }
  const openBlockers = () => {
    const ids = new Set(storedRelations(item).blockedBy ?? []);
    return work.filter(row => ids.has(row.id) && row.kind === "Story" && !row.tombstone &&
      ((row.status === "active" && row.labels?.includes(repair)) || (row.status === "blocked" && row.labels?.includes(blocked))));
  };
  if (criteria !== undefined && !(from === "pending-validate" && target === "blocked")) return { status: item.status, problem: "blocked-criteria belongs to a pending validation becoming blocked" };
  if (target === "pending-validate") {
    if (from !== "active" && !isBlocked) return { status: "active", problem: "only implemented or validation-blocked work can enter pending-validate" };
    if (isBlocked && (storedRelations(item).blockedBy ?? []).some(id => !work.some(row => row.id === id && !row.tombstone && row.status === "done"))) {
      return { status: "active", problem: "the recorded hard predecessor still blocks validation" };
    }
    if (item.kind === "Initiative" || item.kind === "Epic") {
      const unfinished = implementationChildren(work, item).filter(row => !implementationReady(row) && !conditionUntriggered(work, row));
      if (unfinished.length) return { status: "active", problem: "implementation still open: " + unfinished.map(row => row.externalKey ?? row.id).join(", ") };
    }
    return { status: "active", marker: pending };
  }
  if (target === "validated") {
    const problem = from === "pending-validate" ? initiativeValidationProblem(work, item) : "validation requires pending-validate";
    if (problem) return { status: "done", problem };
    if (!summary?.trim()) return { status: "done", problem: "record the independent validation report in the transition summary" };
    return { status: "done", marker: passed };
  }
  if (from === "pending-validate" && target === "blocked") {
    const boundary = initiativeValidationProblem(work, item);
    if (boundary) return { status: "blocked", problem: boundary };
    if (!summary?.trim() || !openBlockers().length) return { status: "blocked", problem: "identify a failed hard predecessor in blockedBy and explain why every check is unavailable" };
    const content = workContent(item);
    const required = content?.acceptance.map(row => row.id) ?? [];
    if (required.length && (criteria?.length !== required.length || !required.every(id => criteria.includes(id)))) {
      return { status: "blocked", problem: "blocked-criteria must cover every acceptance criterion; run any available checks first" };
    }
    if (content?.completion && content.evidence.some(e => e.codeVersion === content.completion?.codeVersion && e.outcome !== "unverified" &&
      content.acceptance.some(a => a.id === e.acceptanceId && a.version === e.acceptanceVersion) && e.meaningDigest === workAcceptanceMeaningDigest(work, item, e.acceptanceId))) {
      return { status: "blocked", problem: "current evidence already covers an executable criterion; keep partial validation pending" };
    }
    return { status: "blocked", marker: blocked };
  }
  if (from === "pending-validate" && target === "active") return { status: "active", marker: repair };
  if (from === "pending-validate" && target !== "cancelled") return { status: item.status, problem: "pending validation can be validated, blocked, returned to active, or cancelled" };
  if (isBlocked && target !== "cancelled") return { status: item.status, problem: "return validation-blocked work to pending-validate once its hard predecessor is repaired" };
  return { status: target };
}
