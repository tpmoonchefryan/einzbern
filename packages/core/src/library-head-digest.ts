// SPDX-License-Identifier: Apache-2.0

import { canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";

export const LIBRARY_HEAD_SCHEMA_VERSION = "einzbern.library-head.v1" as const;

export interface LibraryHeadStream {
  readonly deviceId: string;
  readonly headEventHash: string | null;
}

/** A library's head: one digest over every stream's head, so it moves whenever any stream does. */
export function libraryHeadDigest(streams: readonly LibraryHeadStream[]): string | null {
  const heads = streams
    .filter((stream) => stream.headEventHash !== null)
    .map((stream) => [stream.deviceId, stream.headEventHash as string])
    .sort((left, right) => compareCanonicalText(left[0] as string, right[0] as string));
  return heads.length === 0 ? null : canonicalSha256({ schemaVersion: LIBRARY_HEAD_SCHEMA_VERSION, heads });
}
