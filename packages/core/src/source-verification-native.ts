// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import type { LibraryRead, StreamManifest, StreamSegment } from "./akasha.js";
import type { EventRecord } from "../../protocol/src/index.js";
import { readConsolidationIndex } from "./consolidation-format.js";
import { writeFileAtomic } from "./atomic-file.js";
import type { Library, LibraryManifest } from "./ether-library.js";
import { openLibrary } from "./ether-library.js";
import { FRAMEWORK_VERSION } from "./framework-version.js";
import { recordBoundary } from "./source-verification-records.js";
import type { VerificationBoundary } from "./source-verification-records.js";
import { observeAuthorityWork, observeAuthorityWorkAsync, observeCacheRead, observeCacheWrite, observeCacheReason, observeEventRead, observeVerificationHelper, observeVerificationRecord, observeVerifiedSegment } from "./recall-observation.js";
import { fileContentDigest, localFileIdentity, localIdentityContext } from "./local-file-identity.js";
import type { LocalFileIdentity, LocalIdentityContext } from "./local-file-identity.js";
import { readProtectedProjection, writeProtectedProjection } from "./protected-projection.js";
import { buildPrecomputedDecisionHints, PRECOMPUTED_DECISION_HINTS } from "./recall-inputs.js";
import type { PrecomputedDecisionHints } from "./recall-inputs.js";
import type { WorkspaceState } from "./workspace.js";
import { beginSourceAttestation } from "./source-attestor-client.js";
import type { SourceAttestation } from "./source-attestor-client.js";
import { ATTESTOR_SCHEMA } from "./source-attestor-protocol.js";
import type { AttestorFile } from "./source-attestor-protocol.js";

const SCHEMA = "einzbern.source-verification.v4";
const PROJECTION = "einzbern.verified-segment-events.v1";
const FILE_COMMON = 0x8a0c0006;
const VOLUME = 0xc006d000;
const EXTENDED_FLAGS = 0x200;
const DATA_LENGTH = 0x200;
const active = new AsyncLocalStorage<VerificationSession>();

interface DarwinIdentity {
  readonly boot: string;
  readonly mount: string;
  readonly volume: string;
  readonly device: number;
  readonly fileId: string;
  readonly generation: number;
  readonly length: string;
  readonly flags: number;
  readonly extendedFlags: string;
  readonly provider: Readonly<Record<string, unknown>>;
}
type NativeIdentity = (DarwinIdentity | LocalFileIdentity) & { readonly sha256: string };
interface SegmentBinding {
  readonly libraryId: string;
  readonly sourceId: string;
  readonly archive: string;
  readonly streamId: string;
  readonly deviceId: string;
  readonly identityScheme: StreamManifest["identityScheme"];
  readonly segment: StreamSegment;
  readonly rootManifest: string;
  readonly sourceManifest: string;
}
interface PriorVerification {
  readonly schemaVersion: typeof SCHEMA;
  readonly engineVersion: string;
  readonly deviceIdentity: string;
  readonly projection: typeof PROJECTION;
  readonly binding: SegmentBinding;
  readonly native: NativeIdentity;
  readonly streamManifest: string;
  readonly head: string | null;
  readonly vector: number;
  readonly authority: string;
  readonly digest: string;
  readonly coverage: number;
  readonly projectionDigest: string;
  readonly projectionBytes: number;
}
interface Candidate {
  readonly key: string;
  readonly record: Omit<PriorVerification, "authority" | "projectionDigest" | "projectionBytes">;
  events?: readonly EventRecord[];
}
interface VerificationSession extends VerificationBoundary {
  readonly pending: Candidate[];
  readonly reused: { readonly bytes: number; readonly streamId: string; readonly scope: "live" | "archive" }[];
  readonly projections: Map<string, readonly EventRecord[]>;
  helperUnavailable: boolean;
  readonly files: Map<string, OpenSegment>;
  metadata: string;
  readonly metadataFiles: Map<string, LocalFileIdentity>;
  localContext?: LocalIdentityContext | null;
  attestation?: SourceAttestation;
}
interface OpenSegment {
  handle?: FileHandle;
  readonly path: string;
  readonly segment: StreamSegment;
  readonly binding: SegmentBinding;
  key?: string;
  native?: NativeIdentity | null;
  stat?: BigIntStats;
}

function fileKey(file: OpenSegment): string {
  return file.key ??= canonicalSha256({
    libraryId: file.binding.libraryId,
    sourceId: file.binding.sourceId,
    archive: file.binding.archive,
    streamId: file.binding.streamId,
    segment: file.segment.name,
  });
}

function sameLocalIdentity(left: LocalFileIdentity | null, right: LocalFileIdentity | null): boolean {
  return left !== null && right !== null && left.boot === right.boot && left.mount === right.mount
    && left.device === right.device && left.fileId === right.fileId && left.birth === right.birth
    && left.change === right.change && left.length === right.length && left.mode === right.mode;
}

function sameNativeIdentity(left: NativeIdentity, right: NativeIdentity | null | undefined): boolean {
  if (right == null) return false;
  if (left.sha256 !== right.sha256 || left.boot !== right.boot || left.mount !== right.mount
    || left.device !== right.device || left.fileId !== right.fileId || left.length !== right.length) return false;
  if ("change" in left && "change" in right) {
    return left.birth === right.birth && left.change === right.change && left.mode === right.mode;
  }
  return canonicalSha256(left) === canonicalSha256(right);
}

export interface VerifiedSegment {
  readonly bytes?: Buffer;
  readonly events?: readonly EventRecord[];
}

type MaterializedWork = WorkspaceState["work"][number];
interface CachedMaterializedWork {
  readonly fields: Omit<MaterializedWork, "extensions" | "summary">;
  readonly detailKeys: readonly string[];
  readonly details: Buffer;
}
interface CachedMaterializedState {
  readonly fields: Readonly<Record<string, Buffer>>;
  readonly work: readonly CachedMaterializedWork[];
  readonly decisionHints: PrecomputedDecisionHints;
}

function digest(bytes: Uint8Array): string {
  return observeAuthorityWork("cacheHash", () => createHash("sha256").update(bytes).digest("hex"));
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function attributes(common: number, volume = 0, file = 0, extended = 0): string {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt16LE(5);
  bytes.writeUInt32LE(common, 4);
  bytes.writeUInt32LE(volume, 8);
  bytes.writeUInt32LE(file, 16);
  bytes.writeUInt32LE(extended, 20);
  return bytes.toString("base64");
}
function attributeBytes(value: unknown, common: number, volume: number, file: number, extended: number): Buffer | null {
  if (!object(value) || value.result !== 0 || typeof value.bytes !== "string") return null;
  const bytes = Buffer.from(value.bytes, "base64");
  if (bytes.length < 24 || bytes.length > 8192 || bytes.readUInt32LE() !== bytes.length) return null;
  if (bytes.readUInt32LE(4) !== common || bytes.readUInt32LE(8) !== volume || bytes.readUInt32LE(12) !== 0 || bytes.readUInt32LE(16) !== file || bytes.readUInt32LE(20) !== extended) return null;
  return bytes.subarray(0, bytes.readUInt32LE());
}
function attributeString(bytes: Buffer, at: number): string | null {
  const start = at + bytes.readInt32LE(at), length = bytes.readUInt32LE(at + 4);
  if (start < at + 8 || length < 1 || start + length > bytes.length || bytes[start + length - 1] !== 0) return null;
  return bytes.subarray(start, start + length - 1).toString("utf8");
}

/** Apple attr.h's packed 4-byte layout, with exact returned and supported sets.
 * Native generation and resident-data flags apply even when Foundation omits
 * iCloud-only keys. Their absence is not a claim that no provider manages a file. */
function nativeIdentity(value: unknown, boot: string, path: string): DarwinIdentity | null {
  if (!object(value) || value.resourceError !== null || !object(value.resources)) return null;
  const provider = value.resources;
  const ubiquitous = provider.NSURLIsUbiquitousItemKey === true || provider.NSURLIsUbiquitousItemKey === 1;
  const current = (provider.NSURLIsUbiquitousItemKey === true || provider.NSURLIsUbiquitousItemKey === 1)
    && (provider.NSURLUbiquitousItemIsDownloadingKey === false || provider.NSURLUbiquitousItemIsDownloadingKey === 0)
    && provider.NSURLUbiquitousItemDownloadingStatusKey === "NSURLUbiquitousItemDownloadingStatusCurrent";
  if ((ubiquitous && !current) || provider.NSURLUbiquitousItemIsDownloadingKey === true || provider.NSURLUbiquitousItemIsDownloadingKey === 1
    || (provider.NSURLUbiquitousItemDownloadingStatusKey !== undefined && provider.NSURLUbiquitousItemDownloadingStatusKey !== "NSURLUbiquitousItemDownloadingStatusCurrent")
    || provider.NSURLUbiquitousItemDownloadingErrorKey !== null || typeof provider.NSURLFileResourceIdentifierKey !== "string") return null;
  const file = attributeBytes(value.file, FILE_COMMON, 0, DATA_LENGTH, EXTENDED_FLAGS);
  const volume = attributeBytes(value.volume, 0x80000000, VOLUME & 0x7fffffff, 0, 0);
  if (file === null || file.length < 76 || volume === null || volume.length < 132) return null;
  // validattr follows capabilities and UUID in this request. Unknown support is
  // not silently replaced with a successful fgetattrlist return.
  if ((volume.readUInt32LE(92) & (FILE_COMMON & 0x7fffffff)) !== (FILE_COMMON & 0x7fffffff) || (volume.readUInt32LE(104) & DATA_LENGTH) !== DATA_LENGTH || (volume.readUInt32LE(108) & EXTENDED_FLAGS) !== EXTENDED_FLAGS) return null;
  if ((volume.readUInt32LE(32) & 0x1000) === 0) return null;
  const sourcePath = attributeString(file, 52);
  const mountPoint = attributeString(volume, 24), mountedDevice = attributeString(volume, 36);
  const generation = file.readUInt32LE(40), flags = file.readUInt32LE(36);
  const volumeId = volume.subarray(76, 92).toString("hex");
  if (sourcePath !== path || mountPoint === null || mountedDevice === null || generation === 0 || (flags & 0x40000000) !== 0 || /^0+$/u.test(volumeId)) return null;
  return {
    boot,
    mount: canonicalSha256({ fsid: file.subarray(28, 36).toString("hex"), mountPoint, mountedDevice }),
    volume: volumeId,
    device: file.readUInt32LE(24),
    fileId: file.readBigUInt64LE(44).toString(),
    generation,
    length: file.readBigInt64LE(60).toString(),
    flags,
    extendedFlags: file.readBigUInt64LE(68).toString(),
    provider,
  };
}

async function queryDarwin(files: readonly OpenSegment[]): Promise<readonly (DarwinIdentity | null)[] | null> {
  const session = active.getStore();
  if (session?.helperUnavailable === true) return null;
  let script: string;
  try {
    // The normal build copies this resource. The release bundler carries this
    // exact URL in the CLI, so users need only Node and macOS's system JXA host.
    script = await readFile(new URL("./darwin-source-identity.mjs", import.meta.url), "utf8");
  } catch {
    observeCacheReason("source-verification-helper-missing");
    if (session !== undefined) session.helperUnavailable = true;
    return null;
  }
  const request = JSON.stringify({ fileAttributes: attributes(FILE_COMMON, 0, DATA_LENGTH, EXTENDED_FLAGS), volumeAttributes: attributes(0x80000000, VOLUME), files: files.map(file => ({ path: file.path })) });
  const started = performance.now();
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-", request], { input: script, encoding: "utf8", stdio: "pipe", timeout: 5_000, maxBuffer: 65_536 + files.length * 24_576 });
  observeVerificationHelper(Buffer.byteLength(script), Buffer.byteLength(request), Buffer.byteLength(result.stdout ?? "") + Buffer.byteLength(result.stderr ?? ""), performance.now() - started);
  if (result.status !== 0 || result.error !== undefined) {
    observeCacheReason("source-verification-helper-unavailable");
    if (session !== undefined) session.helperUnavailable = true;
    return null;
  }
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!object(value) || value.schemaVersion !== "einzbern.darwin-source-identity.v1" || value.bootResult !== 0 || typeof value.boot !== "string" || !Array.isArray(value.files) || value.files.length !== files.length) return null;
    const boot = Buffer.from(value.boot, "base64").toString("utf8").split("\0")[0] ?? "";
    if (!/^[A-Fa-f0-9-]{36}$/u.test(boot)) return null;
    return value.files.map((entry, index) => nativeIdentity(entry, boot, files[index]!.path));
  } catch {
    return null;
  }
}

/** Native attributes only select/bind objects. Actual bytes prove every reuse,
 * including writes through an existing mapping whose attributes never change. */
function contentProof(file: OpenSegment, identity: DarwinIdentity | LocalFileIdentity | null): NativeIdentity | null {
  if (identity === null) return null;
  let owned: number | undefined;
  try {
    const fd = file.handle?.fd ?? (owned = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW));
    const held = fstatSync(fd, { bigint: true });
    if (!held.isFile() || held.nlink !== 1n || held.ino.toString() !== identity.fileId || Number(held.dev) !== identity.device) return null;
    const content = observeAuthorityWork("segmentHash", () => fileContentDigest(fd));
    observeEventRead(content.bytes, file.binding.streamId, file.binding.archive === "" ? "live" : "archive", "content-proof");
    const named = lstatSync(file.path, { bigint: true });
    if (content.bytes !== file.segment.bytes || content.sha256 !== file.segment.sha256 || !named.isFile() || named.nlink !== 1n || named.ino !== held.ino || named.dev !== held.dev) return null;
    return { ...identity, sha256: content.sha256 };
  } catch { return null; }
  finally { if (owned !== undefined) closeSync(owned); }
}

async function contentProofAsync(file: OpenSegment, identity: DarwinIdentity | LocalFileIdentity | null): Promise<NativeIdentity | null> {
  if (identity === null) return null;
  let owned: FileHandle | undefined;
  try {
    const fh = file.handle ?? (owned = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW));
    const held = await fh.stat({ bigint: true });
    if (!held.isFile() || held.nlink !== 1n || held.ino.toString() !== identity.fileId || Number(held.dev) !== identity.device) return null;
    const expectedBytes = file.segment.bytes;
    if (Number(held.size) !== expectedBytes) return null;
    const content = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const { bytesRead } = await fh.read(content, offset, expectedBytes - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    observeEventRead(offset, file.binding.streamId, file.binding.archive === "" ? "live" : "archive", "content-proof");
    if (offset !== expectedBytes) return null;
    // The buffer is owned by this read. Hash it directly rather than copying
    // every segment again into a WebCrypto job on the same I/O worker pool.
    const sha256 = createHash("sha256").update(content).digest("hex");
    const named = await lstat(file.path, { bigint: true });
    if (sha256 !== file.segment.sha256 || !named.isFile() || named.nlink !== 1n || named.ino !== held.ino || named.dev !== held.dev) return null;
    return { ...identity, sha256 };
  } catch { return null; }
  finally { if (owned !== undefined) await owned.close(); }
}

async function queryNative(files: readonly OpenSegment[], verifyContent = true, localContext?: LocalIdentityContext | null): Promise<readonly (NativeIdentity | null)[] | null> {
  if (process.platform === "linux") {
    const context = localContext !== undefined ? localContext : (files[0] === undefined ? null : await localIdentityContext(files[0].path));
    if (context === null) return null;
    const identities = files.map(file => {
      const info = file.handle === undefined ? lstatSync(file.path, { bigint: true }) : fstatSync(file.handle.fd, { bigint: true });
      file.stat ??= info;
      return localFileIdentity(info, context);
    });
    if (!verifyContent) return identities.map((identity, index) => identity === null ? null : { ...identity, sha256: files[index]!.segment.sha256 });
    const results: (NativeIdentity | null)[] = new Array(files.length);
    let cursor = 0;
    await observeAuthorityWorkAsync("segmentHash", async () => {
      const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
        while (cursor < files.length) {
          const index = cursor++;
          results[index] = await contentProofAsync(files[index]!, identities[index]!);
        }
      });
      await Promise.all(workers);
    });
    return results;
  }
  if (process.platform !== "darwin") return null;
  const identities: (NativeIdentity | null)[] = [];
  // Bound each helper request, not the library's segment count.
  for (let offset = 0; offset < files.length; offset += 64) {
    const batch = await queryDarwin(files.slice(offset, offset + 64));
    if (batch === null) return null;
    identities.push(...batch.map((identity, index) => contentProof(files[offset + index]!, identity)));
  }
  return identities;
}

async function authorityKey(session: VerificationSession): Promise<string> {
  const { listStreamDevices, readStreamManifest } = await import("./akasha.js");
  const metadata: unknown[] = [];
  async function collect(root: string, source: LibraryManifest): Promise<void> {
    const streams = [];
    for (const device of await listStreamDevices(root)) streams.push(await readStreamManifest(root, device, { archivedManifest: source }));
    const index = await readConsolidationIndex(root, source);
    metadata.push({ root, source, streams, index });
    for (const entry of index?.sources ?? []) await collect(join(root, entry.archive), entry.manifest);
  }
  await collect(session.library.root, session.library.manifest);
  return canonicalSha256(metadata);
}

async function priorRecord(session: VerificationSession, file: OpenSegment, native: NativeIdentity): Promise<PriorVerification | null> {
  let handle;
  try {
    handle = await open(join(session.records, `${fileKey(file)}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 65_536) return null;
    const bytes = await handle.readFile();
    observeVerificationRecord(bytes.length);
    const envelope: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(envelope) || typeof envelope.checksum !== "string" || !object(envelope.record) || canonicalSha256(envelope.record) !== envelope.checksum) return null;
    const record = envelope.record;
    if (record.schemaVersion !== SCHEMA || record.deviceIdentity !== session.deviceIdentity || record.engineVersion !== FRAMEWORK_VERSION || record.projection !== PROJECTION || canonicalSha256(record.binding) !== canonicalSha256(file.binding) || canonicalSha256(record.native) !== canonicalSha256(native) || record.digest !== file.segment.sha256 || record.coverage !== file.segment.bytes || typeof record.projectionDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.projectionDigest) || !Number.isSafeInteger(record.projectionBytes) || Number(record.projectionBytes) < 1 || typeof record.authority !== "string" || !/^[a-f0-9]{64}$/u.test(record.authority)) return null;
    return record as unknown as PriorVerification;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Open the operation's native descriptors together. This small metadata pass
 * lets one before/after helper cover every stream, rather than starting a JXA
 * process twice per stream. The normal reader still validates current metadata. */
async function prepareFiles(session: VerificationSession): Promise<boolean> {
  const { listStreamDevices, readStreamManifest } = await import("./akasha.js");
  const metadata: unknown[] = [];
  session.localContext = await localIdentityContext(session.library.root);
  const watch = (path: string, directory = false): void => {
    if (session.localContext == null) return;
    const identity = localFileIdentity(lstatSync(path, { bigint: true }), session.localContext, directory);
    if (identity === null) throw new Error("unprovable metadata identity");
    session.metadataFiles.set(path, identity);
  };
  const rootManifest = canonicalSha256(session.library.manifest);
  type Collected = { readonly metadataEntries: unknown[]; readonly fileEntries: OpenSegment[] };
  async function collect(root: string, source: LibraryManifest): Promise<Collected> {
    const sourceManifest = canonicalSha256(source);
    const sourceRoot = await realpath(root);
    if (!inside(session.library.root, sourceRoot)) throw new Error("source outside library");
    const archive = relative(session.library.root, sourceRoot).split("\\").join("/");
    watch(join(sourceRoot, "akasha"), true);
    const devices = await listStreamDevices(sourceRoot);
    const [manifests, index] = await Promise.all([
      Promise.all(devices.map(async deviceId => {
        watch(join(sourceRoot, "akasha", deviceId), true);
        const manifestPath = join(sourceRoot, "akasha", deviceId, "manifest.json");
        if (session.localContext != null) {
          try { watch(manifestPath); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        return readStreamManifest(sourceRoot, deviceId, { archivedManifest: source });
      })),
      (async () => {
        if (source.consolidation !== undefined) watch(join(sourceRoot, source.consolidation.index));
        return readConsolidationIndex(sourceRoot, source);
      })(),
    ]);
    const fileEntries: OpenSegment[] = [];
    for (const manifest of manifests) {
      if (manifest === null) continue;
      for (const segment of manifest.segments) {
        const path = join(sourceRoot, "akasha", manifest.deviceId, segment.name);
        const handle = process.platform === "linux" ? undefined : await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const binding: SegmentBinding = { libraryId: session.library.manifest.libraryId, sourceId: source.libraryId, archive, streamId: manifest.streamId, deviceId: manifest.deviceId, identityScheme: manifest.identityScheme, segment, rootManifest, sourceManifest };
        fileEntries.push({ ...(handle === undefined ? {} : { handle }), path, segment, binding });
      }
    }
    const metadataEntries: unknown[] = [{ root: sourceRoot, source, streams: manifests, index }];
    if (index?.sources.length) {
      const children = await Promise.all(index.sources.map(entry => collect(join(sourceRoot, entry.archive), entry.manifest)));
      for (const child of children) {
        metadataEntries.push(...child.metadataEntries);
        fileEntries.push(...child.fileEntries);
      }
    }
    return { metadataEntries, fileEntries };
  }
  try {
    watch(join(session.library.root, "manifest.json"));
    if (canonicalSha256((await openLibrary(session.library.root)).manifest) !== canonicalSha256(session.library.manifest)) return false;
    const collected = await collect(session.library.root, session.library.manifest);
    metadata.push(...collected.metadataEntries);
    for (const file of collected.fileEntries) {
      if (session.files.has(file.path)) throw new Error("aliased source descriptor");
      session.files.set(file.path, file);
    }
    const files = [...session.files.values()];
    if (files.length === 0) return false;
    const before = await active.run(session, () => queryNative(files, false, session.localContext));
    if (before === null || before.every(value => value === null)) return false;
    for (const [index, file] of files.entries()) {
      const stat = process.platform === "linux" ? file.stat! : await file.handle!.stat({ bigint: true });
      const native = before[index];
      file.stat = stat;
      file.native = stat.isFile() && stat.nlink === 1n && native !== undefined && native !== null
        && native.fileId === stat.ino.toString() && native.device === Number(stat.dev) && native.length === stat.size.toString() ? native : null;
    }
    session.metadata = canonicalSha256(metadata);
    if (!metadataUnchanged(session)) return false;
    return true;
  } catch {
    observeCacheReason("source-verification-native-preparation-failed");
    return false;
  }
}

/** Full current metadata was parsed and hashed above. Its kernel change identity
 * must still match after the operation; file/stream additions change a watched
 * directory. This avoids re-reading unchanged manifests inside one request. */
function metadataUnchanged(session: VerificationSession): boolean {
  if (session.localContext == null) return true;
  for (const [path, before] of session.metadataFiles) {
    const info = lstatSync(path, { bigint: true });
    if (!sameLocalIdentity(before, localFileIdentity(info, session.localContext, info.isDirectory()))) return false;
  }
  return true;
}

async function filesUnchanged(session: VerificationSession): Promise<boolean> {
  try {
    if (session.attestation !== undefined) {
      const proof = session.attestation;
      delete session.attestation;
      try {
        const boundary = await recordBoundary(session.library);
        if (boundary === null || boundary.deviceIdentity !== session.deviceIdentity || boundary.home !== session.home
          || !metadataUnchanged(session) || session.metadata !== await authorityKey(session)) return false;
        return await proof.finish();
      } finally { proof.close(); }
    }
    const files = [...session.files.values()];
    const after = await active.run(session, () => queryNative(files, true, session.localContext));
    if (after === null) return false;
    for (const [index, file] of files.entries()) {
      if (file.native === null || file.native === undefined) continue;
      if (file.handle === undefined) {
        if (!sameNativeIdentity(file.native, after[index])) return false;
        continue;
      }
      const held = process.platform === "linux" ? fstatSync(file.handle.fd, { bigint: true }) : await file.handle.stat({ bigint: true });
      const named = process.platform === "linux" ? lstatSync(file.path, { bigint: true }) : await lstat(file.path, { bigint: true });
      const stat = file.stat!;
      if (!named.isFile() || named.nlink !== 1n || held.nlink !== 1n || named.dev !== held.dev || named.ino !== held.ino || stat.dev !== held.dev || stat.ino !== held.ino || stat.size !== held.size || stat.mtimeNs !== held.mtimeNs || stat.ctimeNs !== held.ctimeNs || !sameNativeIdentity(file.native, after[index])) return false;
    }
    return session.localContext == null ? session.metadata === await authorityKey(session) : metadataUnchanged(session);
  } catch { return false; }
}

/** The existing metadata/event reader remains authoritative. The helper proves
 * only continuity of a complete current declared byte set. Its first leased
 * SHA is never an event validation receipt or a materialized state issuer. */
async function prepareAttestation(session: VerificationSession): Promise<void> {
  if (process.env.EINZBERN_SOURCE_ATTESTOR_ROOT !== session.library.root) return;
  try {
    const files: AttestorFile[] = [...session.files.values()].map(file => ({ path: file.path, bytes: file.segment.bytes, sha256: file.segment.sha256,
      metadata: false, streamId: file.binding.streamId, scope: file.binding.archive === "" ? "live" : "archive" }));
    const directories: string[] = [];
    for (const path of session.metadataFiles.keys()) {
      const info = await lstat(path);
      if (info.isDirectory()) { directories.push(path); continue; }
      const bytes = await readFile(path);
      files.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), metadata: true });
    }
    const proof = await beginSourceAttestation({ schema: ATTESTOR_SCHEMA, root: session.library.root, directories, files,
      binding: canonicalSha256({ schema: SCHEMA, engine: FRAMEWORK_VERSION, device: session.deviceIdentity, metadata: session.metadata,
        segments: [...session.files.values()].map(file => ({ binding: file.binding, native: file.native })) }) }, session.home);
    if (proof === null) return;
    // Re-enumerate/parse after the leases and directory guards exist. This
    // catches preparation gaps, added streams and a partially declared set.
    if (!metadataUnchanged(session) || session.metadata !== await authorityKey(session)) { proof.close(); return; }
    session.attestation = proof;
  } catch { observeCacheReason("source-attestor-preparation-full-sha256"); }
}

/** A local record authenticates the compressed, previously validated event
 * projection. Shared cache bytes alone cannot skip source or event validation. */
export async function verifiedStreamSegments(libraryRoot: string, manifest: StreamManifest, sourceManifest?: LibraryManifest): Promise<ReadonlyMap<string, VerifiedSegment> | null> {
  const session = active.getStore();
  if (session === undefined || manifest.segments.length === 0) return null;
  const sourceRoot = await realpath(libraryRoot);
  const source = sourceManifest ?? session.library.manifest;
  const result = new Map<string, VerifiedSegment>();
  for (const segment of manifest.segments) {
    const file = session.files.get(join(sourceRoot, "akasha", manifest.deviceId, segment.name));
    if (file === undefined || file.native === null || file.native === undefined || file.binding.streamId !== manifest.streamId || file.binding.deviceId !== manifest.deviceId || file.binding.identityScheme !== manifest.identityScheme || canonicalSha256(file.binding.segment) !== canonicalSha256(segment) || file.binding.sourceManifest !== canonicalSha256(source)) continue;
    const prior = await priorRecord(session, file, file.native);
    if (prior !== null) {
      let cached;
      try {
        cached = await open(join(session.cache, `${fileKey(file)}.bin`), constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await cached.stat();
        if (info.isFile() && info.nlink === 1 && info.size === prior.projectionBytes) {
          const bytes = await cached.readFile();
          observeCacheRead(bytes.length);
          if (bytes.length === prior.projectionBytes && digest(bytes) === prior.projectionDigest) {
            // Live and archived copies can carry identical events. Share their
            // decoded graph only after each file's own record and cache bytes
            // authenticate; the digest never substitutes for those checks.
            // Equal coverage also preserves this file's decode size bound.
            const projectionKey = `${prior.projectionDigest}:${segment.bytes}`;
            let events: unknown = session.projections.get(projectionKey);
            if (events === undefined) {
              const { gunzipSync } = await import("node:zlib");
              events = JSON.parse(gunzipSync(bytes, { maxOutputLength: segment.bytes * 2 }).toString("utf8"));
            }
            if (Array.isArray(events) && events.length === segment.lastSequence - segment.firstSequence + 1) {
              session.projections.set(projectionKey, events as EventRecord[]);
              result.set(segment.name, { events: events as EventRecord[] });
              session.reused.push({ bytes: bytes.length, streamId: manifest.streamId, scope: sourceManifest === undefined ? "live" : "archive" });
              continue;
            }
          }
        }
      } catch { /* A missing or damaged projection uses the original reader. */ }
      finally { await cached?.close(); }
    }
    file.handle ??= await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = await file.handle.readFile();
    observeEventRead(bytes.length, manifest.streamId, sourceManifest === undefined ? "live" : "archive");
    result.set(segment.name, { bytes });
    if (bytes.length === segment.bytes && digest(bytes) === segment.sha256) {
      session.pending.push({ key: fileKey(file), record: { schemaVersion: SCHEMA, engineVersion: FRAMEWORK_VERSION, deviceIdentity: session.deviceIdentity, projection: PROJECTION, binding: file.binding, native: file.native, streamManifest: canonicalSha256(manifest), head: manifest.headEventHash, vector: manifest.sequence, digest: segment.sha256, coverage: segment.bytes } });
    }
  }
  return result;
}

/** Called only after Akasha has validated the complete stream including head. */
export async function recordVerifiedStreamEvents(libraryRoot: string, manifest: StreamManifest, events: readonly EventRecord[]): Promise<void> {
  const session = active.getStore();
  if (session === undefined) return;
  const archive = relative(session.library.root, await realpath(libraryRoot)).split("\\").join("/");
  for (const candidate of session.pending) {
    if (candidate.record.binding.archive !== archive || candidate.record.binding.streamId !== manifest.streamId || candidate.events !== undefined) continue;
    const segment = candidate.record.binding.segment;
    candidate.events = events.slice(segment.firstSequence - 1, segment.lastSequence);
  }
}

export function hasActiveSourceVerification(): boolean {
  return active.getStore() !== undefined;
}

export function hasPendingSourceVerification(): boolean {
  return (active.getStore()?.pending.length ?? 0) > 0;
}

function authorityMetadata(read: LibraryRead): unknown {
  return {
    vector: read.versionVector,
    streams: read.streams.map(stream => stream.manifest),
    consolidation: read.consolidation === undefined ? null : { index: read.consolidation.index, sources: read.consolidation.sources.map(({ source, read: sourceRead }) => ({ source, read: authorityMetadata(sourceRead) })) },
  };
}

function hydrateMaterializedState(cached: CachedMaterializedState, history: Buffer): WorkspaceState {
  // Own the authenticated history bytes at the same source boundary as the
  // reducer state. Later cache deletion or publication cannot change this state.
  // Decode lazily: Recall does not need the complete historical payload graph.
  const state: Record<string, unknown> = {};
  Object.defineProperty(state, PRECOMPUTED_DECISION_HINTS, { value: cached.decisionHints, enumerable: false, configurable: true });
  for (const [key, bytes] of Object.entries(cached.fields)) {
    let decoded: { readonly value: unknown } | undefined;
    let packed: Buffer | undefined = bytes;
    Object.defineProperty(state, key, { enumerable: true, configurable: true, get() {
      if (decoded === undefined) { decoded = { value: JSON.parse(gunzipSync(packed!).toString("utf8")) }; packed = undefined; }
      return decoded.value;
    } });
  }
  let decodedEvents: { readonly value: unknown } | undefined;
  Object.defineProperty(state, "events", { enumerable: true, configurable: true, get() {
    if (decodedEvents === undefined) {
      decodedEvents = { value: JSON.parse(gunzipSync(history).toString("utf8")) };
    }
    return decodedEvents.value;
  } });
  // Most warm Recall queries need work identities for obsolete-decision
  // hints, but only the selected records' extensions. Keep every field
  // available without decoding all unrelated work bodies for that lookup.
  state["work"] = cached.work.map(stored => {
    const record = { ...stored.fields };
    let details: Record<string, unknown> | undefined;
    for (const key of stored.detailKeys) Object.defineProperty(record, key, { enumerable: true, configurable: true, get() {
      details ??= JSON.parse(gunzipSync(stored.details).toString("utf8")) as Record<string, unknown>;
      return details[key];
    } });
    return record;
  });
  return state as unknown as WorkspaceState;
}

export async function tryReadVerifiedMaterializedState(library: Library): Promise<WorkspaceState | null> {
  if (process.platform !== "linux" || library.manifest.consolidation === undefined) return null;
  const boundary = await recordBoundary(library);
  if (boundary === null) return null;
  const session: VerificationSession = { ...boundary, pending: [], reused: [], projections: new Map(), helperUnavailable: false, files: new Map(), metadataFiles: new Map(), metadata: "" };
  try {
    if (!await prepareFiles(session)) return null;
    await prepareAttestation(session);
    if (![...session.files.values()].every(file => file.native != null)) return null;
    const binding = canonicalSha256({ projection: "materialized-library-v9", metadata: session.metadata,
      files: [...session.files.values()].map(file => ({ binding: file.binding, native: file.native })) });
    const cached = await readProtectedProjection<CachedMaterializedState>(library, "materialized", binding);
    const history = cached === null ? null : await readProtectedProjection<Buffer>(library, "materialized-events", binding);
    if (cached === null || history === null || !await filesUnchanged(session)) return null;
    for (const file of session.files.values()) observeVerifiedSegment(0, file.binding.streamId, file.binding.archive === "" ? "live" : "archive");
    observeCacheReason("materialized-state-hit");
    return hydrateMaterializedState(cached, history);
  } finally {
    session.attestation?.close();
    await Promise.all([...session.files.values()].map(file => file.handle?.close().catch(() => undefined)));
  }
}

/** Only the materializer enters this scope. Public source-event readers always
 * read source bytes. Issuance follows a successful full authority replay. */
export async function withSourceVerification(library: Library, operation: () => Promise<{ readonly value: WorkspaceState; readonly read: LibraryRead; readonly accepted: boolean }>): Promise<WorkspaceState> {
  const boundary = await recordBoundary(library);
  if (boundary === null) return (await operation()).value;
  const session: VerificationSession = { ...boundary, pending: [], reused: [], projections: new Map(), helperUnavailable: false, files: new Map(), metadataFiles: new Map(), metadata: "" };
  try {
    if (!await prepareFiles(session)) return (await operation()).value;
    await prepareAttestation(session);
    const provable = process.platform === "linux" && library.manifest.consolidation !== undefined
      && [...session.files.values()].every(file => file.native != null);
    const binding = provable ? canonicalSha256({ projection: "materialized-library-v9", metadata: session.metadata,
      files: [...session.files.values()].map(file => ({ binding: file.binding, native: file.native })) }) : null;
    if (binding !== null) {
      const cached = await readProtectedProjection<CachedMaterializedState>(library, "materialized", binding);
      const history = cached === null ? null : await readProtectedProjection<Buffer>(library, "materialized-events", binding);
      if (cached !== null && history !== null && await filesUnchanged(session)) {
        for (const file of session.files.values()) observeVerifiedSegment(0, file.binding.streamId, file.binding.archive === "" ? "live" : "archive");
        observeCacheReason("materialized-state-hit");
        return hydrateMaterializedState(cached, history);
      }
    }
    const answer = await active.run(session, operation);
    if (!await filesUnchanged(session)) {
      observeCacheReason("source-verification-source-changed");
      return (await operation()).value;
    }
    for (const reused of session.reused) observeVerifiedSegment(reused.bytes, reused.streamId, reused.scope);
    if (answer.accepted && binding !== null) {
      const { events, work, ...state } = answer.value;
      await writeProtectedProjection(library, "materialized-events", binding, gzipSync(JSON.stringify(events)));
      await writeProtectedProjection(library, "materialized", binding, {
        fields: Object.fromEntries(Object.entries(state).map(([key, value]) => [key, gzipSync(JSON.stringify(value))])),
        work: work.map(record => {
          const { extensions, summary, ...fields } = record;
          const details = { extensions, ...(summary === undefined ? {} : { summary }) };
          return { fields, detailKeys: Object.keys(details), details: gzipSync(JSON.stringify(details)) };
        }),
        decisionHints: buildPrecomputedDecisionHints(answer.value),
      } satisfies CachedMaterializedState);
    }
    if (answer.accepted && session.pending.length > 0) {
      try {
        // No source, index or cache value selects this device-local destination.
        const boundary = await recordBoundary(library);
        if (boundary === null || boundary.records !== session.records || boundary.cache !== session.cache || boundary.deviceIdentity !== session.deviceIdentity) return answer.value;
        await mkdir(session.records, { recursive: true });
        await mkdir(session.cache, { recursive: true });
        const authority = canonicalSha256({ manifest: library.manifest, read: authorityMetadata(answer.read) });
        const { gzipSync } = await import("node:zlib");
        for (const candidate of session.pending) {
          if (candidate.events === undefined) continue;
          const bytes = gzipSync(JSON.stringify(candidate.events));
          const cacheFile = join(session.cache, `${candidate.key}.bin`);
          await writeFileAtomic(cacheFile, bytes);
          observeCacheWrite(bytes.length);
          const record: PriorVerification = { ...candidate.record, authority, projectionBytes: bytes.length, projectionDigest: digest(bytes) };
          const text = canonicalJson({ record, checksum: canonicalSha256(record) });
          await writeFileAtomic(join(session.records, `${candidate.key}.json`), text);
          observeCacheWrite(Buffer.byteLength(text));
        }
      } catch {
        observeCacheReason("source-verification-record-write-failed");
      }
    }
    return answer.value;
  } finally {
    session.attestation?.close();
    await Promise.all([...session.files.values()].map(file => file.handle?.close().catch(() => undefined)));
  }
}
