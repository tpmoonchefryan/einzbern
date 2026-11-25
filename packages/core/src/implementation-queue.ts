// SPDX-License-Identifier: Apache-2.0
import { canonicalSha256, parseStrictInstant } from "../../protocol/src/index.js";
import type { WorkRecord } from "../../protocol/src/index.js";
import type { WorkspaceState } from "./workspace.js";
import { hostObject, hostText } from "./host-capabilities.js";
import { minutesById, parseDecisionAddress } from "./minutes.js";
import { workContent } from "./work-content.js";
import { storedRelations } from "./work-relations.js";
import { conditionUntriggered, implementationReady, initiativeValidationProblem, isConditionLabel, verificationOnly, workflowStatus } from "./work-validation.js";

type Action = "closed" | "review" | "review-legacy" | "refresh-assessment" | "dispatch" | "in-flight" |
  "apply" | "blocked" | "condition-not-triggered" | "wait-for-children" | "await-init-validation" | "roll-up" | "validate";
type Finding = "implemented" | "ready" | "blocked" | "condition-not-triggered" | "in-flight";
interface Assessment {
  workId: string; revision: number; finding: Finding; evidence: string; reason: string; resumeWhen: string; basis: string;
}
interface Row {
  id: string; key: string; title: string | null; parentId: string | null; revision: number; status: string; next: Action;
  prerequisites: readonly string[]; assessment?: Assessment;
}
interface Visit { row: Row; implemented: boolean }
type Member = { verb: string; id: string; expectedRevision: number; status?: string; summary?: string; implementationCondition?: { basis: string; evidence: string; resumeWhen: string } | null };

interface ExecutionObservation { scopeDigest: string; observedAt: string; evidence: string; inFlight: string[]; unreceived: string[] }
interface Reconciliation {
  outcome: string; canStop: boolean; scopeDigest: string; currentExecution: boolean; execution: ExecutionObservation | null;
  initiatives: { id: string; key: string; authority: string[] }[]; rows: Row[];
  batch: { schemaVersion: string; members: Member[] };
}

function text(value: unknown, field: string): string {
  hostText(value, field);
  if (!(value as string).trim()) throw new Error(field + " must be nonblank");
  return value as string;
}
function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(field + " must be a list");
  return value;
}

// A live status is not an authorization. The scope is kept separate from package selection
// and review findings, so a short queue or an omitted finding cannot remove a work item.
function authorizedRoots(state: WorkspaceState, value: unknown): Map<WorkRecord, Set<string>> {
  const scope = hostObject(value, "implementation scope", ["decisions", "initiatives"]);
  const byId = new Map(state.work.filter(row => row.kind === "Initiative" && !row.tombstone).map(row => [row.id, row]));
  const grants = new Map<WorkRecord, Set<string>>();
  function include(id: string, authority: string): void {
    const root = byId.get(id);
    if (!root) throw new Error("missing authorized Initiative " + id);
    const existing = grants.get(root) ?? new Set<string>();
    existing.add(authority);
    grants.set(root, existing);
  }
  for (const entry of list(scope.decisions ?? [], "decisions")) {
    const reference = text(entry, "decision");
    if (!parseDecisionAddress(reference)) throw new Error("use a numbered implementation decision");
    const decision = minutesById(state, reference, "all");
    if (decision.decisions[0]?.status === "obsolete") throw new Error("obsolete implementation decision " + reference);
    const ids = decision.linkedWorkIds.filter(id => byId.has(id));
    if (!ids.length) throw new Error("implementation decision has no linked Initiative: " + reference);
    for (const id of ids) include(id, reference);
  }
  for (const entry of list(scope.initiatives ?? [], "initiatives")) {
    const bound = hostObject(entry, "explicit Owner grant", ["id", "authority"]);
    const authority = text(bound.authority, "Owner grant reference");
    const id = text(bound.id, "Initiative id");
    if (parseDecisionAddress(authority)) {
      const decision = minutesById(state, authority, "all");
      if (decision.decisions[0]?.status === "obsolete" || !decision.linkedWorkIds.includes(id)) throw new Error("decision does not cover Initiative " + id);
    }
    include(id, authority);
  }
  if (!grants.size) throw new Error("supply the current Owner grants covering all authorized Initiatives in this library");
  return grants;
}

function readAssessments(value: unknown): { items: Map<string, Assessment>; execution: ExecutionObservation | null } {
  const document = hostObject(value, "queue observations", ["items", "execution"]);
  const items = new Map<string, Assessment>();
  for (const entry of list(document.items ?? [], "items")) {
    const item = hostObject(entry, "assessment", ["workId", "revision", "finding", "evidence", "reason", "resumeWhen", "basis"]);
    const workId = text(item.workId, "workId");
    if (items.has(workId) || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1) throw new Error("duplicate work or invalid revision: " + workId);
    const finding = text(item.finding, "finding") as Finding;
    if (!["implemented", "ready", "blocked", "condition-not-triggered", "in-flight"].includes(finding)) throw new Error("unknown finding: " + finding);
    const evidence = text(item.evidence, "actual evidence reference");
    const hold = finding === "blocked" || finding === "condition-not-triggered";
    const reason = text(item.reason, "scope and observed result");
    const resumeWhen = hold ? text(item.resumeWhen, "specific release or trigger") : "";
    const basis = finding === "condition-not-triggered" ? text(item.basis, "conditional criterion or decision") : "";
    items.set(workId, { workId, revision: Number(item.revision), finding, evidence, reason, resumeWhen, basis });
  }
  const execution = document.execution === undefined ? null : hostObject(document.execution, "current execution receipts", ["observedAt", "scopeDigest", "evidence", "inFlight", "unreceived"]);
  if (execution) parseStrictInstant(execution.observedAt);
  return { items, execution: execution && { scopeDigest: text(execution.scopeDigest, "review scope digest"), observedAt: text(execution.observedAt, "roster observation time"), evidence: text(execution.evidence, "current native receipt reference"),
    inFlight: list(execution.inFlight, "inFlight").map(ref => text(ref, "attempt")),
    unreceived: list(execution.unreceived, "unreceived").map(ref => text(ref, "delivery")) } };
}

function pendingUpdates(work: WorkRecord, assessment: Assessment): Member[] {
  const status = workflowStatus(work);
  // Never clear an ordinary block, Owner acceptance, or a validation failure on the strength of a legacy note.
  const steps: Record<string, string[]> = { planned: ["ready", "active", "pending-validate"], ready: ["active", "pending-validate"], active: ["pending-validate"] };
  return (steps[status] ?? []).map((target, index) => ({ verb: "work-transition", id: work.id, expectedRevision: work.revision + index, status: target,
    ...(target === "pending-validate" ? { summary: [assessment.reason, assessment.evidence].join("\n") } : {}) }));
}

export function reconcileImplementationQueue(state: WorkspaceState, scope: unknown, observations: unknown = {}): Reconciliation {
  const grants = authorizedRoots(state, scope);
  const { items, execution } = readAssessments(observations);
  const children = new Map<string, WorkRecord[]>();
  for (const work of state.work) {
    if (!work.parentId || work.tombstone || !["Epic", "Story", "Subtask"].includes(work.kind)) continue;
    const siblings = children.get(work.parentId) ?? [];
    siblings.push(work);
    children.set(work.parentId, siblings);
  }
  const rows: Row[] = [];
  const members: Member[] = [];
  const visited = new Set<string>();
  let terminalRoots = 0;
  for (const root of grants.keys()) {
    const terminal = ["done", "cancelled", "validated"].includes(workflowStatus(root));
    if (terminal) terminalRoots++;
    const validating = workflowStatus(root) === "pending-validate";
    const formalOpen = validating && !initiativeValidationProblem(state.work, root);
    function visit(work: WorkRecord, verification: boolean, skippedVerification = false): Visit {
      visited.add(work.id);
      const status = workflowStatus(work);
      const assessment = items.get(work.id);
      const row: Row = { id: work.id, key: work.externalKey, title: work.title ?? null, parentId: work.parentId, revision: work.revision,
        status, next: "review", prerequisites: storedRelations(work).blockedBy ?? [], ...(assessment ? { assessment } : {}) };
      const dormant = conditionUntriggered(state.work, work);
      const descendants = (children.get(work.id) ?? []).map(child => ({ verification: verificationOnly(work, child), child }));
      const delivery = descendants.map(({ child, verification: only }) => ({ only, result: visit(child, verification || only, skippedVerification || (dormant && only)) })).filter(d => !d.only);
      const awaitsChildren = delivery.some(d => !d.result.implemented);
      const content = workContent(work);
      const retainedRequirement = content?.requirements.some(requirement => requirement.disposition === "required" &&
        !content.allocations.some(a => a.workId === work.id && a.requirementId === requirement.id && a.version === requirement.version && a.responsibility === "implementation"));
      const terminalItem = ["done", "validated", "cancelled"].includes(status);
      const activeCondition = work.labels?.some(isConditionLabel);
      if (terminal || terminalItem) row.next = "closed";
      else if (skippedVerification) row.next = "condition-not-triggered";
      else if (verification && !formalOpen) row.next = "await-init-validation";
      else if (assessment && assessment.revision !== work.revision) row.next = "refresh-assessment";
      else if (assessment?.finding === "in-flight") row.next = "in-flight";
      else if (assessment?.finding === "condition-not-triggered") {
        if (dormant) row.next = "condition-not-triggered";
        else if (!["Story", "Subtask"].includes(work.kind) || !["planned", "ready", "active"].includes(status)) row.next = "review";
        else if (delivery.some(d => d.result.row.status !== "cancelled" && d.result.row.next !== "condition-not-triggered")) row.next = "review";
        else {
          members.push({ verb: "work-annotate", id: work.id, expectedRevision: work.revision,
            implementationCondition: { basis: assessment.basis, evidence: [assessment.reason, assessment.evidence].join(" "), resumeWhen: assessment.resumeWhen } });
          row.next = "apply";
        }
      } else if (activeCondition) {
        if (assessment) {
          members.push({ verb: "work-annotate", id: work.id, expectedRevision: work.revision, implementationCondition: null });
          row.next = "apply";
        } else row.next = "review";
      } else if (assessment?.finding === "blocked") row.next = "blocked";
      else if (assessment?.finding === "ready" && status === "pending-validate" && !verification) {
        members.push({ verb: "work-transition", id: work.id, expectedRevision: work.revision, status: "active", summary: [assessment.reason, assessment.evidence].join("\n") });
        row.next = "apply";
      } else if (assessment?.finding === "ready") row.next = verification ? "validate" : "dispatch";
      else if (verification || status === "pending-validate") row.next = formalOpen ? "validate" : "await-init-validation";
      else if (assessment?.finding === "implemented" && !awaitsChildren) {
        const updates = pendingUpdates(work, assessment);
        if (updates.length) { members.push(...updates); row.next = "apply"; }
      } else if (/pending[ -]validate|待验收|待验/iu.test(work.summary ?? "") && !assessment) row.next = "review-legacy";
      else if (awaitsChildren) row.next = retainedRequirement && !assessment ? "review" : "wait-for-children";
      else if (delivery.length || work.kind === "Initiative" || work.kind === "Epic") row.next = "roll-up";
      rows.push(row);
      return { row, implemented: terminalItem || row.next === "condition-not-triggered" ||
        (implementationReady(work) && row.next !== "dispatch" && row.next !== "blocked" && row.next !== "in-flight") };
    }
    visit(root, false);
  }
  for (const id of items.keys()) if (!visited.has(id)) throw new Error("assessment outside the authorized Initiatives: " + id);
  const scopeDigest = canonicalSha256({ grants: [...grants].map(([root, refs]) => [root.id, [...refs].sort()]).sort(),
    work: rows.map(row => [row.id, row.revision]).sort() });
  const observed = execution ? parseStrictInstant(execution.observedAt) : null;
  const currentExecution = Boolean(execution && execution.scopeDigest === scopeDigest && observed !== null &&
    observed <= parseStrictInstant(new Date().toISOString()) && state.work.every(row => !visited.has(row.id) || parseStrictInstant(row.updatedAt) <= observed));
  const actions = new Set(rows.map(row => row.next));
  const outstanding = execution && (execution.inFlight.length > 0 || execution.unreceived.length > 0);
  const unfinished = ["review", "review-legacy", "refresh-assessment", "dispatch", "in-flight", "apply", "roll-up", "validate"] as const;
  let outcome = "continue";
  if (!outstanding && currentExecution && !unfinished.some(action => actions.has(action))) {
    if (terminalRoots === grants.size) outcome = "completed";
    else if (actions.has("blocked")) outcome = "all-applicable-blocked";
  }
  return { outcome, canStop: outcome !== "continue", scopeDigest, currentExecution, execution, initiatives: [...grants].map(([root, authority]) => ({ id: root.id, key: root.externalKey, authority: [...authority] })),
    rows, batch: { schemaVersion: "tcrn.work-batch.v1", members } };
}
