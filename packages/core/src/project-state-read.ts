// SPDX-License-Identifier: Apache-2.0
import { scopedWorkspaceState } from "./project-scope.js";
import type { WorkspaceState } from "./workspace.js";

/** Async read boundary for explicitly opted-in cross-chain defaults. Canonical writers
 * continue to use the full native state; this view is never an append replacement. */
export async function effectiveProjectState(
  state: WorkspaceState,
  projectId?: string,
  home?: string,
): Promise<ReturnType<typeof scopedWorkspaceState>> {
  const scoped = scopedWorkspaceState(state, projectId);
  if (projectId === undefined || !scoped.configRecords.some(record => record.collection === "chain" && record.key === "common-default")) {
    return scoped;
  }
  const { resolveEffectiveProjectState } = await import("./project-chain.js");
  return resolveEffectiveProjectState(state, scoped, projectId, home);
}
