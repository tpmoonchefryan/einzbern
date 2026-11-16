// SPDX-License-Identifier: Apache-2.0
import { canonicalSha256 } from "../../protocol/src/index.js";
import type { Library } from "./ether-library.js";
import { FRAMEWORK_VERSION } from "./framework-version.js";
import { beginCrestAttestation } from "./source-attestor-client.js";
import type { CrestAttestation } from "./source-attestor-client.js";
import { CREST_PROOF_SCHEMA } from "./source-attestor-protocol.js";
import { recordBoundary } from "./source-verification-records.js";
import type { WorkspaceState } from "./workspace.js";

/** Caller supplies the already validated raw replay, never a cached query or a
 * client-declared file list. User Crest keeps its independent full reader. */
export async function crestProjectionProof(library: Library, workspace: WorkspaceState, roots: readonly string[], projectionVersion: string, warmOnly = false): Promise<CrestAttestation | null> {
  if (process.env.EINZBERN_SOURCE_ATTESTOR_ROOT !== library.root) return null;
  const boundary = await recordBoundary(library);
  if (boundary === null) return null;
  return beginCrestAttestation({ schema: CREST_PROOF_SCHEMA, domain: "crest", root: library.root, roots,
    binding: canonicalSha256({ schema: CREST_PROOF_SCHEMA, engine: FRAMEWORK_VERSION, projectionVersion,
      device: boundary.deviceIdentity, manifest: library.manifest, workspace: workspace.metadata,
      version: workspace.version, head: workspace.headEventHash, vector: workspace.library?.versionVector ?? {},
      streams: workspace.library?.streams ?? [], archives: workspace.library?.consolidation ?? null }) }, boundary.home, warmOnly);
}
