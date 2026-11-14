// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { canonicalSha256 } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { cachePath } from "./device-home.js";
import type { Library } from "./ether-library.js";
import { FRAMEWORK_VERSION } from "./framework-version.js";
import { recordBoundary } from "./source-verification-records.js";
import { observeCacheRead, observeCacheWrite, observeVerificationRecord, observeStage } from "./recall-observation.js";

const SCHEMA = "einzbern.protected-projection.v1";
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function regularBytes(path: string): Buffer {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.nlink !== 1) throw new Error("projection is not a regular private file");
    return readFileSync(file);
  } finally { closeSync(file); }
}

/** A checksum in a disposable cache cannot attest itself. The independent
 * device record binds the exact bytes, source boundary and logical version. */
export async function readProtectedProjection<T>(library: Library, name: string, binding: string | (() => Promise<string | null>)): Promise<T | null> {
  return observeStage(`projection:${name}`, async () => {
    try {
      const boundary = await recordBoundary(library, "derived-projections");
      if (boundary === null) return null;
      const proof = await regularBytes(join(boundary.records, `${name}.json`));
      observeVerificationRecord(proof.length);
      const record = JSON.parse(proof.toString("utf8"));
      if (record.schemaVersion !== SCHEMA || record.engine !== FRAMEWORK_VERSION
        || record.device !== boundary.deviceIdentity || record.root !== boundary.library.root || typeof record.sha256 !== "string") return null;
      const expected = typeof binding === "function" ? await binding() : binding;
      if (expected === null || record.binding !== expected) return null;
      const bytes = await regularBytes(join(cachePath(library.manifest.libraryId), `${name}.bin`));
      observeCacheRead(bytes.length);
      if (bytes.length !== record.bytes || hash(bytes) !== record.sha256) return null;
      return deserialize(bytes) as T;
    } catch { return null; }
  });
}

export async function writeProtectedProjection(library: Library, name: string, binding: string, value: unknown): Promise<void> {
  try {
    const boundary = await recordBoundary(library, "derived-projections");
    if (boundary === null) return;
    const bytes = serialize(value);
    const directory = cachePath(library.manifest.libraryId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(boundary.records, { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(directory, `${name}.bin`), bytes);
    const record = { schemaVersion: SCHEMA, engine: FRAMEWORK_VERSION, device: boundary.deviceIdentity,
      root: boundary.library.root, binding, bytes: bytes.length, sha256: hash(bytes) };
    const text = `${JSON.stringify(record)}\n`;
    await writeFileAtomic(join(boundary.records, `${name}.json`), text);
    observeCacheWrite(bytes.length + Buffer.byteLength(text));
  } catch { /* A cache fault cannot change the validated source result. */ }
}

export function projectionBinding(value: unknown): string { return canonicalSha256(value); }
