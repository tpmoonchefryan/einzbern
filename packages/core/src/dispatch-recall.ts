// SPDX-License-Identifier: Apache-2.0
import { effectiveProjectState } from "./project-state-read.js";
import { readRecallCards, recallCandidateEntries, recallCandidateRef, recallInputsFromState, recallMetadataOnly } from "./recall-inputs.js";
import { RECALL_DEFAULT_SCOPE_EXCERPT_BYTES, RECALL_DEFAULT_TAU, recall, recallDocuments } from "./recall.js";
import { storyFields } from "./story-fields.js";
import { workContent } from "./work-content.js";
import type { WorkspaceState } from "./workspace.js";

export interface DispatchRecallOffer {
  readonly workspaceId: string;
  readonly references: readonly string[];
  readonly lines: readonly string[];
}

/** Compute from the work record already admitted for this dispatch. */
export async function dispatchRecallOffer(state: WorkspaceState, workspace: string, workId: string, at: string): Promise<DispatchRecallOffer | undefined> {
  const work = state.work.find(entry => entry.id === workId && !entry.tombstone);
  if (work === undefined) return undefined;
  const query = [work.title ?? work.externalKey, workContent(work)?.goal ?? storyFields(work).goal].filter(Boolean).join("\n");
  if (query.trim() === "") return undefined;
  const scoped = await effectiveProjectState(state, work.projectId);
  const value = (key: string, fallback: number): number => {
    const setting = Number(scoped.settings.find(entry => entry.key === key)?.value);
    return Number.isSafeInteger(setting) && setting >= 0 ? setting : fallback;
  };
  const scopeExcerptBytes = value("retrieval.scopeExcerptBytes", RECALL_DEFAULT_SCOPE_EXCERPT_BYTES);
  const perPromptBytes = value("injection.perPromptBytes", 1600);
  const metadataOnly = recallMetadataOnly(state.settings);
  const { cards, digest } = await readRecallCards(workspace, { projectId: work.projectId, at });
  // The omitted work differs for each dispatch. Keep this one-off projection in memory.
  const result = recall({
    cacheKey: `dispatch:${state.metadata.workspaceId}:${work.projectId}`,
    checkpoint: `${state.headEventHash}:${digest}:scope-bytes=${scopeExcerptBytes}:without=${workId}${metadataOnly ? ":fields=metadata" : ""}`,
    documents: () => recallDocuments(recallInputsFromState(scoped, cards, { projectId: work.projectId, scopeExcerptBytes, metadataOnly })).filter(record => record.id !== workId),
    query,
    tau: value("retrieval.tau", RECALL_DEFAULT_TAU),
  });
  const candidates = recallCandidateEntries(result.records, perPromptBytes);
  if (candidates.length === 0) return undefined;
  return {
    workspaceId: state.metadata.workspaceId,
    references: candidates.map(({ hit }) => recallCandidateRef(hit)),
    lines: candidates.map(({ line }) => line),
  };
}
