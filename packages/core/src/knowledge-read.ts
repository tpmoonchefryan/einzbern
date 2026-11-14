// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  assertStrictInstant,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  deriveStableId,
  parseStrictInstant,
} from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { userCrestPath } from "./device-home.js";
import { hasLibraryManifest, openLibrary } from "./ether-library.js";
import { archivedKnowledgeScope, bindArchivedKnowledgeScope, intrinsicScopeMatchesProject, resolveIntrinsicKnowledgeScope } from "./knowledge-scope.js";
import { localTreeIdentity } from "./local-file-identity.js";
import { readUserCrestPath } from "./machine-settings.js";
import { readProtectedProjection } from "./protected-projection.js";
import { recallAuthorityState } from "./recall-authority.js";
import type { RecallAuthority } from "./recall-authority.js";
import { observeCacheReason } from "./recall-observation.js";
import type {
  KnowledgeListQuery,
  KnowledgeStatusFilter,
  KnowledgeUnitMetadata,
} from "./knowledge-core.js";
import type { WorkspaceState } from "./workspace.js";

const KNOWLEDGE_PROJECTION_VERSION = "intrinsic-scope-conflict-v2";
const USER_CREST_ID = deriveStableId("user-crest", "USER-CREST");
const USER_CREST_DISCLOSURE: Readonly<Record<string, JsonValue>> = Object.freeze({ scope: "user" });
const KNOWLEDGE_QUERY_DEFAULT_RESULTS = 8;

export interface CachedCrestMetaUnit {
  readonly metadata: KnowledgeUnitMetadata;
  readonly canonicalText: string;
  readonly archiveScope: ReturnType<typeof archivedKnowledgeScope>;
}

export interface CachedCrestMetaDuplicateVersion extends CachedCrestMetaUnit {
  readonly deviceId: string | null;
  readonly sequence: number | null;
  readonly eventHash: string | null;
}

export interface CachedCrestMeta {
  readonly layout: "library" | "old-layout";
  readonly marker: { readonly eventHighWaterDigest: string; readonly workspaceId?: string; readonly version?: number };
  readonly sourceDigest: string;
  readonly units: readonly CachedCrestMetaUnit[];
  readonly removedIds: readonly string[];
  readonly unresolvedConflicts: readonly (readonly string[])[];
  readonly duplicates: readonly { readonly id: string; readonly externalKey: string; readonly versions: readonly CachedCrestMetaDuplicateVersion[] }[];
  readonly awaitingChain: readonly { readonly id: string; readonly deviceId: string; readonly sequence: number; readonly eventHash: string }[];
  readonly unresolvedScopes: readonly { readonly id: string; readonly projectId: string; readonly deviceId: string | null; readonly sequence: number | null; readonly eventHash: string | null }[];
}

const textCache = new WeakMap<object, string>();
let lastEvaluationInstant: { readonly text: string; readonly value: bigint } | undefined;

function canonicalEntryText(value: JsonValue): string {
  if (value !== null && typeof value === "object") {
    const cached = textCache.get(value);
    if (cached !== undefined) return cached;
  }
  return canonicalJson(value).slice(0, -1);
}

function canonicalListSha256(entryTexts: readonly string[]): string {
  const hash = createHash("sha256").update("[", "utf8");
  for (let index = 0; index < entryTexts.length; index += 1) {
    if (index > 0) hash.update(",", "utf8");
    hash.update(entryTexts[index]!, "utf8");
  }
  return hash.update("]\n", "utf8").digest("hex");
}

function computeFreshness(metadata: KnowledgeUnitMetadata, at: string): "fresh" | "stale" | "unknown" {
  let now: bigint;
  if (lastEvaluationInstant?.text !== at) lastEvaluationInstant = { text: at, value: parseStrictInstant(at) };
  now = lastEvaluationInstant.value;
  if (metadata.stalenessPolicy.maximumAgeDays === null || metadata.lastVerified === null) {
    return metadata.freshnessState === "stale" ? "stale" : "fresh";
  }
  if (metadata.freshnessState === "unknown") return "fresh";
  const verified = parseStrictInstant(metadata.lastVerified);
  if (now < verified) throw Object.assign(new Error("freshness evaluation precedes last verification"), { reasonCode: "KNOWLEDGE_INPUT_INVALID" });
  const maximumAge = BigInt(metadata.stalenessPolicy.maximumAgeDays) * 86_400_000_000_000n;
  return metadata.freshnessState === "stale" || now - verified > maximumAge ? "stale" : "fresh";
}

function isDefaultSelectable(metadata: KnowledgeUnitMetadata, at: string): boolean {
  return metadata.extensions.supersededBy === undefined
    && metadata.promotionState !== "rejected" && metadata.lifecycle === "active"
    && metadata.retrievalDisposition === "default" && metadata.exportDisposition === "metadata-only"
    && computeFreshness(metadata, at) === "fresh";
}

function explicitlySelectable(metadata: KnowledgeUnitMetadata, at: string): boolean {
  return metadata.extensions.supersededBy === undefined
    && metadata.promotionState !== "rejected" && metadata.lifecycle === "active"
    && metadata.retrievalDisposition !== "excluded" && metadata.exportDisposition === "metadata-only"
    && computeFreshness(metadata, at) !== "stale";
}

export function crestMetaBoundary(roots: readonly string[], headEventHash: string | null): () => Promise<string | null> {
  return async (): Promise<string | null> => {
    const trees = await Promise.all(roots.map((root) => localTreeIdentity(root)));
    if (trees.some((tree) => tree === null)) return null;
    return createHash("sha256")
      .update(`10\0${KNOWLEDGE_PROJECTION_VERSION}\0${headEventHash}\0${roots.join("\0")}\0${trees.join("\0")}`)
      .digest("hex");
  };
}

async function userCrestInitializedFast(root: string): Promise<boolean> {
  let entry;
  try {
    entry = await lstat(root);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    return true;
  }
  if (!entry.isDirectory()) return true;
  const files = await readdir(root);
  return files.some((name) => name === "user-crest.json" || name === "events");
}

function buildEmptyUserAnswer(query: KnowledgeListQuery): Readonly<Record<string, JsonValue>> {
  const selection = query.selection ?? "default";
  const status = query.status ?? "valid";
  const offset = query.offset ?? 0;
  const effectiveScope = {
    kind: "user" as const,
    projectId: query.projectId ?? null,
    binding: "user-crest" as const,
  };
  const sourceVersion = { workspaceId: USER_CREST_ID, version: 0, headEventHash: null, crestDigest: canonicalListSha256(["null", "[]", "[]", "[]"]) };
  const snapshot = canonicalSha256({
    sourceVersion, effectiveScope, projectionVersion: KNOWLEDGE_PROJECTION_VERSION, at: query.at,
    selection, status, search: null, explicitCorpus: query.includeExplicitOnly === true,
    filters: [query.roleScope ?? null, query.category ?? null, query.kind ?? null, query.tag ?? null, query.freshness ?? null, query.promotionState ?? null],
  });
  const diagnostics = {
    affectedIdCount: 0, conflictPairCount: 0, duplicateIdCount: 0, awaitingChainCount: 0, unresolvedScopeCount: 0, unresolvedLegacyCount: 0,
    reasonCounts: { conflict: 0, duplicate: 0, "awaiting-chain": 0, "unresolved-scope": 0, "unresolved-legacy": 0 },
    idExamples: [], conflictExamples: [], truncated: false,
  };
  return {
    schemaVersion: "tcrn.knowledge-list.v1",
    reasonCode: "KNOWLEDGE_LIST_READY",
    ...USER_CREST_DISCLOSURE,
    effectiveScope, sourceVersion, projectionVersion: KNOWLEDGE_PROJECTION_VERSION, snapshot,
    activeCount: 0, eligibleCount: 0, withheldCount: 0, ineligibleCount: 0, diagnostics,
    selection, status, at: query.at, total: 0, offset, truncated: false, records: [],
    resultDigest: canonicalListSha256([]),
  };
}

function buildCachedProjectAnswer(
  saved: CachedCrestMeta,
  workspace: WorkspaceState,
  query: KnowledgeListQuery,
): Readonly<Record<string, JsonValue>> {
  const selection = query.selection ?? "default";
  const status: KnowledgeStatusFilter = query.status ?? "valid";
  const offset = query.offset ?? 0;
  const limit = query.limit ?? KNOWLEDGE_QUERY_DEFAULT_RESULTS;
  const removedIds = new Set(saved.removedIds);
  const units: KnowledgeUnitMetadata[] = [];
  for (const stored of saved.units) {
    if (stored.archiveScope.bound) bindArchivedKnowledgeScope(stored.metadata, stored.archiveScope.binding);
    textCache.set(stored.metadata, stored.canonicalText);
    units.push(stored.metadata);
  }
  for (const dup of saved.duplicates) {
    for (const v of dup.versions) {
      if (v.archiveScope.bound) bindArchivedKnowledgeScope(v.metadata, v.archiveScope.binding);
      textCache.set(v.metadata, v.canonicalText);
      units.push(v.metadata);
    }
  }
  const activeRecords = units.filter((m) => !removedIds.has(m.id));
  const scoped = activeRecords.filter((m) => m.lifecycle === "active" && m.extensions.supersededBy === undefined && (query.projectId === undefined || intrinsicScopeMatchesProject(m, query.projectId)));
  const scopedIds = new Set(scoped.map((m) => m.id));
  const pairs = saved.unresolvedConflicts.filter(([a, b]) => (a !== undefined && scopedIds.has(a)) || (b !== undefined && scopedIds.has(b)));
  const duplicates = saved.duplicates.filter((d) => scopedIds.has(d.id));
  const awaiting = saved.awaitingChain.filter((e) => scopedIds.has(e.id));
  const scopes = saved.unresolvedScopes.filter((e) => scopedIds.has(e.id));
  const unknown = scoped.filter((m) => resolveIntrinsicKnowledgeScope(m).kind === "unresolved-legacy");
  const reasons = new Map<string, Set<string>>();
  const mark = (id: string, reason: string): void => {
    if (scopedIds.has(id)) reasons.set(id, new Set([...(reasons.get(id) ?? []), reason]));
  };
  for (const id of pairs.flat()) mark(id, "conflict");
  for (const d of duplicates) mark(d.id, "duplicate");
  for (const a of awaiting) mark(a.id, "awaiting-chain");
  for (const s of scopes) mark(s.id, "unresolved-scope");
  for (const u of unknown) mark(u.id, "unresolved-legacy");
  const withheldAll = new Set<string>([
    ...saved.unresolvedConflicts.flat(),
    ...saved.duplicates.map((d) => d.id),
    ...saved.awaitingChain.map((e) => e.id),
    ...saved.unresolvedScopes.map((e) => e.id),
    ...activeRecords.filter((m) => resolveIntrinsicKnowledgeScope(m).kind === "unresolved-legacy").map((m) => m.id),
  ]);
  const explicitCorpus = query.includeExplicitOnly === true;
  const selectable = scoped.filter((m) => explicitCorpus ? explicitlySelectable(m, query.at) : isDefaultSelectable(m, query.at));
  const withheld = selectable.filter((m) => reasons.has(m.id));
  const affected = [...reasons].sort(([a], [b]) => compareCanonicalText(a, b)).map(([id, why]) => ({
    id, reasons: [...why].sort(compareCanonicalText),
    versions: scoped.filter((m) => m.id === id).length,
    intrinsicScope: resolveIntrinsicKnowledgeScope(scoped.find((m) => m.id === id)!),
  }));
  const reasonCounts = Object.fromEntries(["conflict", "duplicate", "awaiting-chain", "unresolved-scope", "unresolved-legacy"].map((reason) =>
    [reason, withheld.filter((m) => reasons.get(m.id)?.has(reason)).length]));
  const effectiveScope = {
    kind: query.projectId === undefined ? "library" : "project",
    projectId: query.projectId ?? null,
    binding: query.projectId === undefined ? "library" : "explicit-project-id",
  };
  const sourceVersion = {
    workspaceId: workspace.metadata.workspaceId,
    version: workspace.version,
    headEventHash: workspace.headEventHash,
    crestDigest: saved.sourceDigest,
  };
  const snapshot = canonicalSha256({
    sourceVersion, effectiveScope, projectionVersion: KNOWLEDGE_PROJECTION_VERSION, at: query.at,
    selection, status, search: null, explicitCorpus,
    filters: [query.roleScope ?? null, query.category ?? null, query.kind ?? null, query.tag ?? null, query.freshness ?? null, query.promotionState ?? null],
  });
  const diagnostics: Record<string, JsonValue> = {
    affectedIdCount: affected.length, conflictPairCount: pairs.length, duplicateIdCount: duplicates.length,
    awaitingChainCount: awaiting.length, unresolvedScopeCount: scopes.length, unresolvedLegacyCount: new Set(unknown.map((m) => m.id)).size,
    reasonCounts, idExamples: affected.slice(0, 2).map((e) => e.id), conflictExamples: pairs.slice(0, 2) as unknown as JsonValue,
    truncated: affected.length > 2 || pairs.length > 2 || duplicates.length > 1 || awaiting.length > 1 || scopes.length > 1,
  };
  const legacy: Record<string, JsonValue> = {};
  const sample = (key: string, entries: readonly JsonValue[]): void => {
    if (entries.length === 0) return;
    const first = entries.slice(0, key === "unresolvedConflicts" ? 2 : 1);
    if (Buffer.byteLength(JSON.stringify(first), "utf8") < 768) legacy[key] = first;
    else diagnostics.truncated = true;
  };
  sample("unresolvedConflicts", pairs as unknown as JsonValue[]);
  sample("unresolvedDuplicates", duplicates.map((d) => ({
    id: d.id, externalKey: d.externalKey,
    versions: d.versions.map((v) => ({
      deviceId: v.deviceId, sequence: v.sequence, eventHash: v.eventHash,
      updatedAt: v.metadata.updatedAt, subject: v.metadata.subject, bodySha256: v.metadata.bodySha256,
    })),
  })) as unknown as JsonValue[]);
  sample("awaitingChain", awaiting.map((e) => ({ id: e.id, deviceId: e.deviceId, sequence: e.sequence, eventHash: e.eventHash })) as unknown as JsonValue[]);
  sample("unresolvedScopes", scopes as unknown as JsonValue[]);
  const trailing: Record<string, JsonValue> = saved.layout === "library" || saved.marker.eventHighWaterDigest === workspace.headEventHash
    ? {}
    : { knowledgeStoreTrailing: true, knowledgeMarkerDigest: saved.marker.eventHighWaterDigest, libraryHeadDigest: workspace.headEventHash };
  const matched = activeRecords
    .filter((m) => {
      const freshness = computeFreshness(m, query.at);
      if (selection === "default" && !(explicitCorpus ? explicitlySelectable(m, query.at) : isDefaultSelectable(m, query.at))) return false;
      if (selection === "default" && withheldAll.has(m.id)) return false;
      return (query.projectId === undefined || intrinsicScopeMatchesProject(m, query.projectId))
        && (!query.roleScope || m.roleScopes.includes(query.roleScope))
        && (!query.category || m.category === query.category) && (!query.kind || m.kind === query.kind)
        && (!query.tag || m.tags.includes(query.tag)) && (!query.freshness || freshness === query.freshness)
        && (!query.promotionState || m.promotionState === query.promotionState);
    })
    .sort((a, b) => compareCanonicalText(a.id, b.id));
  const records = matched.slice(offset, offset + limit);
  const evidence: Record<string, JsonValue> = {
    effectiveScope, sourceVersion, projectionVersion: KNOWLEDGE_PROJECTION_VERSION, snapshot,
    activeCount: scoped.length, eligibleCount: selectable.length - withheld.length, withheldCount: withheld.length,
    ineligibleCount: scoped.length - selectable.length, diagnostics, ...legacy,
  };
  const summary = { ...evidence };
  for (const key of Object.keys(legacy)) {
    if (Buffer.byteLength(JSON.stringify(summary), "utf8") < 3500) break;
    delete summary[key];
    delete evidence[key];
    diagnostics.truncated = true;
  }
  return {
    schemaVersion: "tcrn.knowledge-list.v1",
    reasonCode: "KNOWLEDGE_LIST_READY",
    ...trailing,
    ...evidence,
    selection,
    status,
    at: query.at,
    total: matched.length,
    offset,
    truncated: offset + records.length < matched.length,
    records: records as unknown as readonly JsonValue[],
    resultDigest: canonicalListSha256(records.map((r) => canonicalEntryText(r as unknown as JsonValue))),
  };
}

export async function listKnowledgeMetadataFast(
  workspaceRoot: string,
  query: KnowledgeListQuery,
  authority?: RecallAuthority,
): Promise<Readonly<Record<string, JsonValue>>> {
  assertStrictInstant(query.at);
  if (query.scope === "user") {
    const customRoot = await readUserCrestPath();
    const root = customRoot ?? userCrestPath();
    if (!(await userCrestInitializedFast(root)) && query.beforeDescriptorReadForTest === undefined && query.afterDescriptorOpenForTest === undefined) {
      return buildEmptyUserAnswer(query);
    }
    const { listKnowledgeMetadata } = await import("./knowledge-core.js");
    return listKnowledgeMetadata(workspaceRoot, query, authority);
  }
  if (
    authority === undefined
    || query.beforeDescriptorReadForTest !== undefined
    || query.afterDescriptorOpenForTest !== undefined
    || query.snapshot !== undefined
    || (query.diagnostics ?? "summary") !== "summary"
    || (query.status ?? "valid") !== "valid"
    || query.search !== undefined
    || !(await hasLibraryManifest(workspaceRoot))
  ) {
    const { listKnowledgeMetadata } = await import("./knowledge-core.js");
    return listKnowledgeMetadata(workspaceRoot, query, authority);
  }
  const workspace = await recallAuthorityState(workspaceRoot, authority);
  const library = await openLibrary(workspaceRoot);
  const storePath = join(workspaceRoot, "crest");
  const roots = [storePath, ...(workspace.library?.consolidation?.sources ?? [])
    .filter((source) => source.manifest.libraryId !== workspace.metadata.workspaceId && source.inventory.some((file) => file.path === "crest/store.json"))
    .map((source) => join(workspaceRoot, source.archive, "crest"))];
  const boundary = crestMetaBoundary(roots, workspace.headEventHash);
  const saved = await readProtectedProjection<CachedCrestMeta>(library, "crest-meta", boundary);
  if (saved !== null) {
    observeCacheReason("crest-projection-hit");
    return buildCachedProjectAnswer(saved, workspace, query);
  }
  const { listKnowledgeMetadata } = await import("./knowledge-core.js");
  return listKnowledgeMetadata(workspaceRoot, query, authority);
}
