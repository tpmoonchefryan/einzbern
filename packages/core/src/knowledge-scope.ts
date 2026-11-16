// SPDX-License-Identifier: Apache-2.0
import type { KnowledgeUnitMetadata } from "./knowledge-core.js";

export type IntrinsicKnowledgeScope =
  | { readonly kind: "project"; readonly projectIds: readonly string[]; readonly source: "metadata" | "archive-binding" }
  | { readonly kind: "workspace-global"; readonly source: "metadata" | "archive-binding" }
  | { readonly kind: "user"; readonly source: "metadata" }
  | { readonly kind: "unresolved-legacy"; readonly source: "missing-archive-binding" };

export interface KnowledgeArchiveBinding {
  readonly projectIds: readonly string[];
  readonly workspaceGlobal: boolean;
}

// Provenance belongs to the read projection. Never add it to immutable Crest metadata.
const archiveBindings = new WeakMap<KnowledgeUnitMetadata, KnowledgeArchiveBinding | null>();

export function bindArchivedKnowledgeScope(metadata: KnowledgeUnitMetadata, binding: KnowledgeArchiveBinding | null): void {
  archiveBindings.set(metadata, binding);
}

export function inheritArchivedKnowledgeScope(source: KnowledgeUnitMetadata, target: KnowledgeUnitMetadata): void {
  if (archiveBindings.has(source)) archiveBindings.set(target, archiveBindings.get(source)!);
}

/** Serialize provenance beside a projection, preserving absent versus unresolved. */
export function archivedKnowledgeScope(metadata: KnowledgeUnitMetadata): { readonly bound: boolean; readonly binding: KnowledgeArchiveBinding | null } {
  return { bound: archiveBindings.has(metadata), binding: archiveBindings.get(metadata) ?? null };
}

/** A missing archive binding is different from a positively identified workspace source. */
export function resolveIntrinsicKnowledgeScope(
  metadata: Pick<KnowledgeUnitMetadata, "scope" | "projectId">,
  archiveBinding?: KnowledgeArchiveBinding | null,
): IntrinsicKnowledgeScope {
  if (metadata.scope === "user") return { kind: "user", source: "metadata" };
  if (metadata.projectId !== null) return { kind: "project", projectIds: [metadata.projectId], source: "metadata" };
  const binding = archiveBinding === undefined ? archiveBindings.get(metadata as KnowledgeUnitMetadata) : archiveBinding;
  if (binding !== undefined) {
    if (binding?.workspaceGlobal === true) return { kind: "workspace-global", source: "archive-binding" };
    if (binding !== null && binding.projectIds.length > 0) {
      return { kind: "project", projectIds: [...new Set(binding.projectIds)].sort(), source: "archive-binding" };
    }
    return { kind: "unresolved-legacy", source: "missing-archive-binding" };
  }
  if (metadata.scope === "project") return { kind: "unresolved-legacy", source: "missing-archive-binding" };
  return { kind: "workspace-global", source: "metadata" };
}

export function intrinsicScopesIntersect(left: IntrinsicKnowledgeScope, right: IntrinsicKnowledgeScope): boolean {
  if (left.kind === "unresolved-legacy" || right.kind === "unresolved-legacy") return false;
  if (left.kind === "user" || right.kind === "user") return left.kind === right.kind;
  if (left.kind === "workspace-global" || right.kind === "workspace-global") return true;
  return left.projectIds.some((id) => right.projectIds.includes(id));
}

export function intrinsicScopeMatchesProject(metadata: KnowledgeUnitMetadata, projectId: string | undefined): boolean {
  if (projectId === undefined) return true;
  return intrinsicScopesIntersect(resolveIntrinsicKnowledgeScope(metadata), { kind: "project", projectIds: [projectId], source: "metadata" });
}
