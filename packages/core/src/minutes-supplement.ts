import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

import { assertStrictInstant, canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { MINUTES_SUPPLEMENT_VERSION, minutesSupplementContentDigest } from "./minutes.js";
import type { MinutesDecisionMetadata, MinutesSupplementSource } from "./minutes.js";
import { recordMinutesSupplement, validateWorkspace, WorkspaceError } from "./workspace.js";

export const MINUTES_SUPPLEMENT_BATCH_SCHEMA_VERSION = "tcrn.minutes-supplement-batch.v1" as const;
export const MINUTES_SUPPLEMENT_BATCH_LIMIT = RUNTIME_CAPACITY.arrayEntries;

export interface MinutesSupplementBatchOptions {
  readonly occurredAt: string;
  readonly projectId?: string;
  readonly actorId?: string;
}

interface MinutesSupplementBatchMember {
  readonly minutesId: string;
  readonly contentDigest: string;
  readonly decisionMetadata: readonly MinutesDecisionMetadata[];
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const keys = Object.keys(value).sort(compareCanonicalText);
  const expected = [...fields].sort(compareCanonicalText);
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new WorkspaceError("WORK_BATCH_MALFORMED", `${label} has exactly ${expected.join(", ")}`);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.isWellFormed() && !value.includes("\u0000");
}

function metadataShapeProblems(value: unknown, memberIndex: number): readonly { index: number; rule: string; detail: string }[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > RUNTIME_CAPACITY.arrayEntries) {
    return [{ index: memberIndex, rule: "decision-metadata-list", detail: "one metadata entry is required for each decision" }];
  }
  const problems: { index: number; rule: string; detail: string }[] = [];
  value.forEach((entry, decisionIndex) => {
    if (!isObject(entry)) {
      problems.push({ index: memberIndex, rule: "decision-metadata-object", detail: `decision ${decisionIndex + 1}` });
      return;
    }
    if (Object.keys(entry).sort(compareCanonicalText).join("\u0000") !== ["tags", "title"].join("\u0000")) {
      problems.push({ index: memberIndex, rule: "decision-metadata-fields", detail: `decision ${decisionIndex + 1} requires title and tags only` });
    }
    if (!nonEmptyText(entry.title)) problems.push({ index: memberIndex, rule: "decision-title", detail: `decision ${decisionIndex + 1}` });
    if (!Array.isArray(entry.tags) || entry.tags.length === 0 || entry.tags.length > RUNTIME_CAPACITY.arrayEntries ||
      entry.tags.some((tag) => !nonEmptyText(tag)) || (Array.isArray(entry.tags) && new Set(entry.tags).size !== entry.tags.length)) {
      problems.push({ index: memberIndex, rule: "decision-tags", detail: `decision ${decisionIndex + 1} needs non-empty unique tags` });
    }
  });
  return problems;
}

function validateBatch(document: unknown): readonly MinutesSupplementBatchMember[] {
  if (!isObject(document)) throw new WorkspaceError("WORK_BATCH_MALFORMED", "a minutes supplement batch is an object");
  exactFields(document, ["schemaVersion", "members"], "minutes supplement batch");
  if (document.schemaVersion !== MINUTES_SUPPLEMENT_BATCH_SCHEMA_VERSION || !Array.isArray(document.members)) {
    throw new WorkspaceError("WORK_BATCH_MALFORMED", `a minutes supplement batch is ${MINUTES_SUPPLEMENT_BATCH_SCHEMA_VERSION} with a members array`);
  }
  if (document.members.length === 0 || document.members.length > MINUTES_SUPPLEMENT_BATCH_LIMIT) {
    throw new WorkspaceError("WORK_BATCH_MALFORMED", `members=${document.members.length}`);
  }
  const problems: { index: number; rule: string; detail: string }[] = [];
  const members: MinutesSupplementBatchMember[] = [];
  const seen = new Set<string>();
  document.members.forEach((raw, index) => {
    if (!isObject(raw)) {
      problems.push({ index, rule: "member-object", detail: "a batch member is an object" });
      return;
    }
    if (Object.keys(raw).sort(compareCanonicalText).join("\u0000") !== ["contentDigest", "decisionMetadata", "minutesId"].join("\u0000")) {
      problems.push({ index, rule: "member-fields", detail: "minutesId, contentDigest and decisionMetadata are required" });
    }
    if (!nonEmptyText(raw.minutesId)) problems.push({ index, rule: "minutes-id", detail: "minutesId is required" });
    else if (seen.has(raw.minutesId)) problems.push({ index, rule: "minutes-id-unique", detail: `${raw.minutesId} appears more than once` });
    else seen.add(raw.minutesId);
    if (typeof raw.contentDigest !== "string" || !/^[a-f0-9]{64}$/u.test(raw.contentDigest)) {
      problems.push({ index, rule: "content-digest", detail: "contentDigest must be a SHA-256 digest" });
    }
    problems.push(...metadataShapeProblems(raw.decisionMetadata, index));
    if (nonEmptyText(raw.minutesId) && typeof raw.contentDigest === "string" && Array.isArray(raw.decisionMetadata)) {
      members.push({
        minutesId: raw.minutesId,
        contentDigest: raw.contentDigest,
        decisionMetadata: raw.decisionMetadata as readonly MinutesDecisionMetadata[],
      });
    }
  });
  if (problems.length > 0) throw new WorkspaceError("WORK_BATCH_REFUSED", JSON.stringify({ stage: "shape", problems }));
  return members;
}

function sourcesOf(state: Awaited<ReturnType<typeof validateWorkspace>>): readonly MinutesSupplementSource[] {
  const conferences = new Map(state.conferences.map((conference) => [conference.id, conference]));
  return [
    ...state.minutes.filter((record) => !record.tombstone).map((record): MinutesSupplementSource => ({
      id: record.id,
      kind: "minutes",
      projectId: record.projectId,
      title: record.title,
      summary: record.summary,
      decisions: record.decisions,
      recordedAt: record.recordedAt,
    })),
    ...state.conferenceMinutes.filter((record) => !record.tombstone).map((record): MinutesSupplementSource => ({
      id: record.id,
      kind: "conference-minutes",
      projectId: record.projectId,
      title: conferences.get(record.conferenceId)?.title ?? record.conferenceId,
      summary: record.summary,
      decisions: record.decisions,
      recordedAt: record.updatedAt,
    })),
  ].sort((left, right) => compareCanonicalText(left.projectId, right.projectId) ||
    compareCanonicalText(left.recordedAt, right.recordedAt) || compareCanonicalText(left.id, right.id));
}

/** Read-only inventory of the exact source records, their metadata coverage, and model input. */
export async function minutesSupplementInventory(workspaceRoot: string, projectId?: string): Promise<Readonly<Record<string, JsonValue>>> {
  const state = await validateWorkspace(workspaceRoot);
  const supplements = new Map(state.minutesSupplements.map((record) => [record.minutesId, record]));
  const directMetadata = new Map(state.minutes.filter((record) => record.decisionMetadata !== undefined)
    .map((record) => [record.id, record.decisionMetadata as readonly MinutesDecisionMetadata[]]));
  const sources = sourcesOf(state).filter((source) => projectId === undefined || source.projectId === projectId);
  const records = sources.map((source) => {
    const supplement = supplements.get(source.id);
    const metadata = source.kind === "minutes" ? directMetadata.get(source.id) : undefined;
    const status = supplement !== undefined ? "supplemented-pending-owner-audit" : metadata !== undefined ? "metadata-present"
      : source.decisions.length === 0 ? "no-decisions" : "needs-supplement";
    return {
      minutesId: source.id,
      kind: source.kind,
      projectId: source.projectId,
      title: source.title,
      summary: source.summary,
      recordedAt: source.recordedAt,
      contentDigest: minutesSupplementContentDigest(source),
      status,
      decisionCount: source.decisions.length,
      ...(status === "needs-supplement" ? {
        decisions: source.decisions.map((text, index) => ({ number: index + 1, text })),
      } : {}),
      ...(supplement === undefined ? {} : {
        supplementId: supplement.id,
        supplementedAt: supplement.appendedAt,
        ownerAudit: "pending",
      }),
    };
  });
  const needsSupplement = records.filter((record) => record.status === "needs-supplement").length;
  const supplemented = records.filter((record) => record.status === "supplemented-pending-owner-audit").length;
  const metadataPresent = records.filter((record) => record.status === "metadata-present").length;
  const unprocessedNoDecisions = records.filter((record) => record.status === "no-decisions").length;
  return {
    schemaVersion: "tcrn.minutes-supplement-inventory.v1",
    reasonCode: "MINUTES_SUPPLEMENT_INVENTORY_READY",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    scope: { ...(projectId === undefined ? {} : { projectId }), records: records.length },
    coverage: {
      needsSupplement,
      supplemented,
      metadataPresent,
      unprocessedNoDecisions,
      ownerAuditPending: supplemented,
      eligibleToSwitch: 0,
    },
    records: records as unknown as JsonValue,
    inventoryDigest: canonicalSha256(records as unknown as JsonValue),
  };
}

/** Apply complete model-authored supplements one record per event; repeated members are safe to retry. */
export async function applyMinutesSupplementBatch(
  workspaceRoot: string,
  document: unknown,
  options: MinutesSupplementBatchOptions,
): Promise<Readonly<Record<string, JsonValue>>> {
  const members = validateBatch(document);
  try { assertStrictInstant(options.occurredAt); } catch { throw new WorkspaceError("WORK_BATCH_MALFORMED", "occurredAt is not a strict instant"); }
  let state = await validateWorkspace(workspaceRoot);
  const applied: JsonValue[] = [];
  const scope = [...new Set(members.map((member) => member.minutesId))];
  if (options.projectId !== undefined) {
    const sourceById = new Map(sourcesOf(state).map((source) => [source.id, source]));
    const outsideScope = members.flatMap((member, index) => {
      const source = sourceById.get(member.minutesId);
      return source === undefined || source.projectId !== options.projectId
        ? [{ index, minutesId: member.minutesId, projectId: source?.projectId ?? null }]
        : [];
    });
    if (outsideScope.length > 0) {
      throw new WorkspaceError("WORK_BATCH_REFUSED", JSON.stringify({
        stage: "scope",
        projectId: options.projectId,
        failed: outsideScope[0],
        outsideScope,
        applied,
      }));
    }
  }
  for (const [index, member] of members.entries()) {
    try {
      const result = await recordMinutesSupplement(workspaceRoot, {
        ...member,
        occurredAt: options.occurredAt,
        ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
      });
      state = result.state;
      const supplement = state.minutesSupplements.find((record) => record.minutesId === member.minutesId);
      if (supplement === undefined) throw new WorkspaceError("WORK_BATCH_REFUSED", `minutes ${member.minutesId} was not supplemented`);
      applied.push({
        index,
        minutesId: member.minutesId,
        supplementId: supplement.id,
        status: result.status,
        ownerAudit: "pending",
        version: state.version,
      });
    } catch (error) {
      const reasonCode = (error as { reasonCode?: unknown }).reasonCode;
      throw new WorkspaceError("WORK_BATCH_REFUSED", JSON.stringify({
        stage: "apply",
        scope,
        applied,
        failed: {
          index,
          minutesId: member.minutesId,
          reasonCode: typeof reasonCode === "string" ? reasonCode : "MINUTES_SUPPLEMENT_FAILED",
          detail: error instanceof Error ? error.message : String(error),
        },
        notEvaluated: members.slice(index + 1).map((entry, offset) => ({ index: index + offset + 1, minutesId: entry.minutesId })),
        ownerAuditPending: applied.length,
      }));
    }
  }
  const appended = applied.reduce<number>((count, entry) => count + (isObject(entry) && entry.status === "appended" ? 1 : 0), 0);
  return {
    schemaVersion: "tcrn.minutes-supplement-batch-result.v1",
    reasonCode: "MINUTES_SUPPLEMENT_BATCH_APPLIED",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    scope: { ...(options.projectId === undefined ? {} : { projectId: options.projectId }), minutesIds: scope, members: members.length },
    appended,
    alreadyApplied: applied.length - appended,
    ownerAuditPending: applied.length,
    eligibleToSwitch: 0,
    applied,
  };
}

export const MINUTES_SUPPLEMENT_SCHEMA_VERSION = MINUTES_SUPPLEMENT_VERSION;
