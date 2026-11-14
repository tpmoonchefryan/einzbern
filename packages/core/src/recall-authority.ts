// SPDX-License-Identifier: Apache-2.0
import { realpath } from "node:fs/promises";
import { hasLibraryManifest, openLibrary } from "./ether-library.js";
import { observeCheckpoint, observeMaterialization } from "./recall-observation.js";
import type { WorkspaceState } from "./workspace.js";

declare const authorityBrand: unique symbol;
/** Opaque evidence held only for the lifetime of a Recall request. */
export interface RecallAuthority { readonly [authorityBrand]: true }
const reads = new WeakMap<RecallAuthority, { root: string; state: WorkspaceState }>();

export async function readRecallAuthority(root: string, validate = false): Promise<{ state: WorkspaceState; authority: RecallAuthority }> {
  const boundRoot = await realpath(root);
  let state: WorkspaceState | null = null;
  if (process.platform === "linux" && await hasLibraryManifest(boundRoot)) {
    const library = await openLibrary(boundRoot);
    if (library.manifest.consolidation !== undefined) {
      observeMaterialization();
      const { tryReadVerifiedMaterializedState } = await import("./source-verification-native.js");
      state = await tryReadVerifiedMaterializedState(library);
      if (state !== null) observeCheckpoint(state.headEventHash);
    }
  }
  if (state === null) {
    const { materializeLibrary, validateWorkspace } = await import("./workspace.js");
    state = validate ? await validateWorkspace(root) : await materializeLibrary(root);
  }
  const authority = Object.freeze({}) as RecallAuthority;
  reads.set(authority, { root: boundRoot, state });
  return { state, authority };
}

/** Never accepts a caller-supplied state, another root, or a project-derived view. */
export async function recallAuthorityState(root: string, authority: RecallAuthority): Promise<WorkspaceState> {
  const read = reads.get(authority);
  if (read === undefined || read.root !== await realpath(root)) {
    throw Object.assign(new Error("Recall authority does not belong to this request root"), { reasonCode: "KNOWLEDGE_PATH_INVALID" });
  }
  return read.state;
}
