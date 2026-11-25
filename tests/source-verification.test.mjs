// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  initializeLibrary, createProject, declareChainIdentity, setWorkspaceSetting,
  createWork, consolidateLibraries, materializeLibrary, materializeWorkspaceFromGenesis,
  openLibrary, readConsolidationIndex, readAllStreams, cachePath, configureStorageLocation,
  registerLibrary, appendEvents, createWorkDelta,
  digestBytes,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import { withRecallObservation } from "../dist/build/packages/core/src/recall-observation.js";
import { readRecallAuthority } from "../dist/build/packages/core/src/recall-authority.js";
import { discardCacheSnapshot } from "../dist/build/packages/core/src/library-cache.js";
import { classifyDarwinFileAvailability } from "../dist/build/packages/core/src/source-verification-native.js";

const at = "2026-11-11T12:00:00Z";
const native = process.platform === "darwin";
const spawnSync = childProcess.spawnSync;
const hits = observation => observation.verifiedSegmentsBySource.reduce((sum, source) => sum + source.segments, 0);

function packedFileAttributes(flags) {
  const bytes = Buffer.alloc(76);
  bytes.writeUInt32LE(bytes.length, 0);
  bytes.writeUInt32LE(0x8a0c0006, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(0, 12);
  bytes.writeUInt32LE(0x200, 16);
  bytes.writeUInt32LE(0x200, 20);
  bytes.writeUInt32LE(flags, 36);
  return { result: 0, bytes: bytes.toString("base64") };
}

test("SF_DATALESS metadata classifies availability and rejects unknown attributes", () => {
  assert.equal(classifyDarwinFileAvailability(packedFileAttributes(0)), "available");
  assert.equal(classifyDarwinFileAvailability(packedFileAttributes(0x40000000)), "dataless");
  assert.equal(classifyDarwinFileAvailability({ result: 1, bytes: null }), "unknown");
  assert.equal(classifyDarwinFileAvailability(packedFileAttributes(0).bytes), "unknown");
});

test("Darwin guard has a non-materializing preflight before source descriptor opens", async () => {
  const helper = await fs.readFile(new URL("../packages/core/src/darwin-source-identity.mjs", import.meta.url), "utf8");
  const source = await fs.readFile(new URL("../packages/core/src/source-verification-native.ts", import.meta.url), "utf8");
  const preflight = helper.indexOf("if (request.preflight === true)");
  const pathAttributes = helper.indexOf("attributes(file.path, request.fileAttributes, true)", preflight);
  const helperOpen = helper.indexOf("$.open(file.path");
  const prepare = source.indexOf("async function prepareFiles");
  const nativePreflight = source.indexOf("queryDarwinAvailability(batch)", prepare);
  const nodeOpen = source.indexOf("await open(file.path", prepare);
  assert.ok(preflight >= 0 && pathAttributes > preflight && helperOpen > pathAttributes);
  assert.ok(helper.includes("$.setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_PROCESS, IOPOL_MATERIALIZE_DATALESS_FILES_OFF)"));
  assert.ok(nativePreflight >= 0 && nodeOpen > nativePreflight);
});

async function fixture(t, large = true) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "einzbern-source-verification-")));
  const previous = process.env.EINZBERN_HOME;
  const home = join(root, "device");
  process.env.EINZBERN_HOME = home;
  t.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const sources = [];
  for (const name of ["coordination", "alpha"]) {
    const path = join(root, name);
    const initial = await initializeLibrary({ root: path, createdAt: at });
    const state = await createProject(path, { externalKey: `VERIFY-${name}`, name, occurredAt: at });
    const projectId = state.projects[0].id;
    const role = name === "coordination" ? "coordination" : "project";
    await declareChainIdentity(path, { role, coordinationLibraryId: sources[0]?.id ?? initial.metadata.workspaceId, ...(role === "project" ? { primaryProjectId: projectId } : {}) }, { occurredAt: at });
    await setWorkspaceSetting(path, { key: "storage.segmentBytes", value: "4096", occurredAt: at });
    // Native integrity cases need a workload on which the cost policy selects
    // native verification. Batch the synthetic records without changing trust.
    await appendEvents(path, Array.from({ length: large ? 10 : 3 }, (_, n) => createWorkDelta({
      projectId, externalKey: `VERIFY-${name}-${n}`, kind: "Initiative", parentId: null,
      title: `Calibration ${name} ${n}`, scope: "calibration ".repeat(80),
      ...(large ? { body: "calibration ".repeat(22000) } : {}), occurredAt: at,
    })), { occurredAt: at });
    sources.push({ path, id: initial.metadata.workspaceId, projectId, role });
  }
  for (const source of sources) {
    const projectPath = join(root, "projects", source.role);
    await fs.mkdir(projectPath, { recursive: true });
    await registerLibrary({ projectPath, projectId: source.projectId, libraryPath: source.path, registeredAt: at, gitRemote: null });
  }
  const library = join(root, "shared");
  await consolidateLibraries({ primary: sources[0].path, sources: sources.map(source => ({ path: source.path, bindings: [{ projectPath: join(root, "projects", source.role), projectId: source.projectId, role: source.role }] })) }, library, { at, actor: "agent:codex", decidedIn: "minutes:000000000000000000000001#D1", yes: true });
  const manifest = (await openLibrary(library)).manifest;
  const index = await readConsolidationIndex(library, manifest);
  const source = index.sources.find(source => source.manifest.libraryId === sources[1].id);
  const segment = source.inventory.find(file => /akasha\/.*\.ndjson$/u.test(file.path));
  const target = join(library, source.archive, segment.path);
  return { root, home, library, manifest, sources, target, records: join(home, "source-verification", manifest.libraryId.replace(":", "-")), cache: join(cachePath(manifest.libraryId), "verified-segments") };
}

// A controlled provider response exercises the eligibility branches on local
// fixtures. fgetattrlist, held-object identity, boot, mount and generations
// still come from the system helper. These tests do not claim real hydration.
function provider(t, change = () => {}, preflightChange = () => {}) {
  let queries = 0;
  t.mock.method(childProcess, "spawnSync", (command, arguments_, options) => {
    const result = spawnSync(command, arguments_, options);
    if (command !== "/usr/bin/osascript" || result.status !== 0) return result;
    const value = JSON.parse(result.stdout);
    const request = JSON.parse(arguments_.at(-1));
    for (const file of value.files) file.resources = {
      NSURLIsUbiquitousItemKey: true,
      NSURLUbiquitousItemIsDownloadingKey: false,
      NSURLUbiquitousItemDownloadingStatusKey: "NSURLUbiquitousItemDownloadingStatusCurrent",
      NSURLUbiquitousItemDownloadingErrorKey: null,
      NSURLFileResourceIdentifierKey: "controlled-provider-identity",
    };
    if (request.preflight === true) preflightChange(value, request);
    else change(value, ++queries, request);
    return { ...result, stdout: JSON.stringify(value) };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
async function read(f) {
  return withRecallObservation(() => materializeLibrary(f.library));
}
async function warm(f) {
  await read(f);
  const result = await read(f);
  assert.ok(hits(result.observation) > 0);
  assert.ok(result.observation.logicalEventBytes > 0, "reuse verifies actual content, including existing writable mappings");
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  return result;
}
async function fileInventory(root, prefix = "") {
  const files = [];
  let entries;
  try { entries = await fs.readdir(join(root, prefix), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return files; throw error; }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await fileInventory(root, path));
    } else if (entry.isFile()) {
      const bytes = await fs.readFile(join(root, path));
      files.push({ path, bytes: bytes.length, sha256: digestBytes(bytes) });
    }
  }
  return files;
}
async function sourceSnapshot(f) {
  const library = await openLibrary(f.library);
  const read = await readAllStreams(f.library);
  const streams = [];
  function collect(current, archive = "") {
    for (const stream of current.streams) {
      if (stream.manifest !== null) streams.push({ archive, deviceId: stream.deviceId, streamId: stream.manifest.streamId,
        sequence: stream.manifest.sequence, headEventHash: stream.manifest.headEventHash });
    }
    for (const { source, read: nested } of current.consolidation?.sources ?? []) collect(nested, source.archive);
  }
  collect(read);
  streams.sort((left, right) => `${left.archive}/${left.deviceId}` < `${right.archive}/${right.deviceId}` ? -1 : 1);
  const files = await fileInventory(f.library);
  return {
    libraryId: library.manifest.libraryId,
    consolidationSha256: library.manifest.consolidation?.sha256 ?? null,
    versionVector: read.versionVector,
    streams,
    headIdentity: canonicalSha256({ libraryId: library.manifest.libraryId,
      consolidationSha256: library.manifest.consolidation?.sha256 ?? null, streams }),
    inputFiles: files,
    inputDigest: canonicalSha256(files),
  };
}
async function authorityRead(f) {
  const measured = await withRecallObservation(async () => (await readRecallAuthority(f.library)).state);
  return { state: measured.value, resultDigest: canonicalSha256(JSON.parse(JSON.stringify(measured.value))), observation: measured.observation };
}
async function genesisRead(f) {
  const measured = await withRecallObservation(() => materializeWorkspaceFromGenesis(f.library));
  return { state: measured.value, resultDigest: canonicalSha256(JSON.parse(JSON.stringify(measured.value))), observation: measured.observation };
}
function materializationMetrics(result) {
  const observation = result.observation;
  return {
    resultDigest: result.resultDigest,
    replayedEvents: observation.replayedEvents,
    segmentReads: observation.segmentReads,
    logicalEventBytes: observation.logicalEventBytes,
    verificationContentBytes: observation.verificationContentBytes,
    elapsedMs: observation.elapsedMs,
    cacheReasons: observation.cacheReasons,
  };
}
async function editRecord(f, change) {
  const name = (await fs.readdir(f.records)).find(name => name.endsWith(".json"));
  const path = join(f.records, name);
  const envelope = JSON.parse(await fs.readFile(path, "utf8"));
  change(envelope.record);
  envelope.checksum = canonicalSha256(envelope.record);
  await fs.writeFile(path, canonicalJson(envelope));
}
async function corrupt(f) {
  const bytes = await fs.readFile(f.target);
  const changed = bytes.toString("utf8").replace('"name":"alpha"', '"name":"Alpha"');
  assert.notEqual(changed, bytes.toString("utf8"));
  assert.equal(Buffer.byteLength(changed), bytes.length);
  return Buffer.from(changed);
}

test("unknown per-file provider status preserves full source reads", { skip: !native }, async t => {
  const f = await fixture(t);
  provider(t, value => { for (const file of value.files) file.resources = {}; });
  const result = await read(f);
  assert.equal(hits(result.observation), 0);
  assert.ok(result.observation.logicalEventBytes > 0);
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
});

test("a controlled dataless preflight refuses fallback even when an earlier segment has unknown status", async t => {
  const f = await fixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalOpen = fs.open;
  let preflightSeen = false;
  let sourceOpenedBeforePreflight = false;
  let sourceOpenedAfterPreflight = false;
  t.mock.method(fs, "open", (path, ...arguments_) => {
    if (String(path) === f.target) {
      if (preflightSeen) sourceOpenedAfterPreflight = true;
      else sourceOpenedBeforePreflight = true;
    }
    return originalOpen(path, ...arguments_);
  });
  t.mock.method(childProcess, "spawnSync", (command, arguments_, options) => {
    if (command !== "/usr/bin/osascript") return spawnSync(command, arguments_, options);
    const request = JSON.parse(arguments_.at(-1));
    assert.equal(request.preflight, true, "a data-less result must stop before the post-open identity query");
    assert.ok(request.files.some(file => file.path === f.target));
    const targetIndex = request.files.findIndex(file => file.path === f.target);
    assert.ok(targetIndex > 0, "the fixture has an earlier source segment whose provider status is unknown");
    const files = request.files.map((file, index) => ({
      file: index === 0
        ? { result: 1, bytes: null }
        : packedFileAttributes(file.path === f.target ? 0x40000000 : 0),
    }));
    preflightSeen = true;
    return {
      status: 0,
      stdout: JSON.stringify({ schemaVersion: "einzbern.darwin-source-identity.v1", preflight: true, ioPolicyResult: 0, files }),
      stderr: "",
    };
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  try {
    await assert.rejects(read(f), error => error.reasonCode === "SOURCE_DATALESS_FALLBACK_BLOCKED"
      && /SF_DATALESS/u.test(error.message) && /Make the source available and retry/u.test(error.message));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
  }
  assert.equal(preflightSeen, true);
  assert.equal(sourceOpenedBeforePreflight, false);
  assert.equal(sourceOpenedAfterPreflight, false, "a dataless classification must not reach the generic source reader");
});

async function unmergedFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "einzbern-source-availability-")));
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(root, "device");
  t.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const library = join(root, "plain");
  await initializeLibrary({ root: library, createdAt: at });
  const state = await createProject(library, { externalKey: "VERIFY-plain", name: "plain", occurredAt: at });
  await setWorkspaceSetting(library, { key: "storage.segmentBytes", value: "4096", occurredAt: at });
  await appendEvents(library, Array.from({ length: 3 }, (_, n) => createWorkDelta({
    projectId: state.projects[0].id, externalKey: `VERIFY-plain-${n}`, kind: "Initiative", parentId: null,
    title: `Plain ${n}`, scope: "plain ".repeat(160), occurredAt: at,
  })), { occurredAt: at });
  return { root, library };
}

async function segmentPaths(library) {
  const paths = [];
  const collect = async (root, manifest) => {
    for (const stream of (await readAllStreams(root, { archivedManifest: manifest })).streams) {
      for (const segment of stream.manifest?.segments ?? []) paths.push(join(root, "akasha", stream.deviceId, segment.name));
    }
    for (const entry of (await readConsolidationIndex(root, manifest))?.sources ?? []) await collect(join(root, entry.archive), entry.manifest);
  };
  await collect(library, (await openLibrary(library)).manifest);
  return paths.sort();
}

async function withControlledDarwinPreflight(t, respond, operation) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const requests = [];
  t.mock.method(childProcess, "spawnSync", (command, arguments_, options) => {
    if (command !== "/usr/bin/osascript") return spawnSync(command, arguments_, options);
    const request = JSON.parse(arguments_.at(-1));
    requests.push(request);
    return respond(request);
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  try {
    return { requests, result: await operation() };
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
  }
}

const datalessPreflight = request => ({
  status: 0,
  stdout: JSON.stringify({ schemaVersion: "einzbern.darwin-source-identity.v1", preflight: true, ioPolicyResult: 0,
    files: request.files.map(() => ({ file: packedFileAttributes(0x40000000) })) }),
  stderr: "",
});

for (const [name, setup] of [
  ["an unmerged library", async t => (await unmergedFixture(t)).library],
  ["a merged library under the full-read cost limit", async t => (await fixture(t, false)).library],
]) {
  test(`a controlled dataless preflight stops the general reader for ${name}`, async t => {
    const library = await setup(t);
    const segments = await segmentPaths(library);
    assert.ok(segments.length > 0);
    const originalOpen = fs.open;
    const opened = [];
    t.mock.method(fs, "open", (path, ...arguments_) => {
      if (segments.includes(String(path))) opened.push(String(path));
      return originalOpen(path, ...arguments_);
    });
    const { requests } = await withControlledDarwinPreflight(t, datalessPreflight, () =>
      assert.rejects(withRecallObservation(() => materializeLibrary(library)), error => error.reasonCode === "SOURCE_DATALESS_FALLBACK_BLOCKED"
        && /SF_DATALESS/u.test(error.message) && /Make the source available and retry/u.test(error.message)));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].preflight, true, "the classification precedes any identity query or source open");
    assert.deepEqual(requests[0].files.map(file => file.path).sort(), segments);
    assert.deepEqual(opened, [], "a dataless classification must not reach the general source reader");
  });
}

test("an unavailable Darwin preflight keeps the general reader for an unmerged library", async t => {
  const { library } = await unmergedFixture(t);
  const expected = await materializeWorkspaceFromGenesis(library);
  const { requests, result } = await withControlledDarwinPreflight(t, () => ({ status: 1, stdout: "", stderr: "unavailable" }),
    () => withRecallObservation(() => materializeLibrary(library)));
  assert.equal(requests.length, 1);
  assert.deepEqual(result.value, expected);
  assert.ok(result.observation.logicalEventBytes > 0);
});

test("real Darwin reads classify every segment of unmerged and small merged libraries before reading", { skip: !native && "requires macOS" }, async t => {
  for (const library of [(await unmergedFixture(t)).library, (await fixture(t, false)).library]) {
    const segments = await segmentPaths(library);
    const preflights = [];
    t.mock.method(childProcess, "spawnSync", (command, arguments_, options) => {
      const result = spawnSync(command, arguments_, options);
      if (command === "/usr/bin/osascript") {
        const request = JSON.parse(arguments_.at(-1));
        if (request.preflight === true) preflights.push({ request, response: JSON.parse(result.stdout) });
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      const result = await withRecallObservation(() => materializeLibrary(library));
      assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(library));
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(preflights.length, 1);
    assert.deepEqual(preflights[0].request.files.map(file => file.path).sort(), segments);
    assert.equal(preflights[0].response.ioPolicyResult, 0);
    assert.deepEqual(preflights[0].response.files.map(entry => classifyDarwinFileAvailability(entry.file)), segments.map(() => "available"));
  }
});

test("the early identity pass defers bytes and the later full proof preserves full-read results", async t => {
  const f = await fixture(t, false);
  await materializeWorkspaceFromGenesis(f.library);

  const references = [];
  for (let index = 0; index < 3; index += 1) {
    references.push(await withRecallObservation(() => materializeWorkspaceFromGenesis(f.library)));
  }
  const noHit = await read(f);
  const hitsOnWarmReads = [];
  for (let index = 0; index < 3; index += 1) hitsOnWarmReads.push(await read(f));

  const reference = references[references.length - 1];
  const referenceBytes = reference.observation.logicalEventBytes;
  assert.ok(referenceBytes > 0);
  assert.equal(hits(noHit.observation), 0);
  assert.deepEqual(noHit.value, reference.value);
  assert.equal(noHit.observation.verificationContentBytes, referenceBytes,
    "the no-hit path reads source content once more for the required later full proof, with no early proof pass");
  for (const warm of hitsOnWarmReads) {
    assert.ok(hits(warm.observation) > 0);
    assert.deepEqual(warm.value, reference.value);
    assert.equal(warm.observation.verificationContentBytes, referenceBytes,
      "a positive projection hit still gets the required later full source proof");
    assert.equal(warm.observation.logicalEventBytes, referenceBytes);
    assert.equal(warm.observation.segmentReads, reference.observation.segmentReads);
  }

  const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
  t.diagnostic(JSON.stringify({
    measurement: "hot local fixture; fixture creation and the unmeasured page-cache prime are excluded",
    reference: {
      samplesMs: references.map(result => result.observation.elapsedMs),
      medianMs: median(references.map(result => result.observation.elapsedMs)),
      segmentReads: reference.observation.segmentReads,
      logicalEventBytes: referenceBytes,
    },
    noHit: {
      elapsedMs: noHit.observation.elapsedMs,
      segmentReads: noHit.observation.segmentReads,
      logicalEventBytes: noHit.observation.logicalEventBytes,
      verificationContentBytes: noHit.observation.verificationContentBytes,
      projectionHitSegments: hits(noHit.observation),
    },
    positiveHit: {
      samplesMs: hitsOnWarmReads.map(result => result.observation.elapsedMs),
      medianMs: median(hitsOnWarmReads.map(result => result.observation.elapsedMs)),
      segmentReads: hitsOnWarmReads[0].observation.segmentReads,
      logicalEventBytes: hitsOnWarmReads[0].observation.logicalEventBytes,
      verificationContentBytes: hitsOnWarmReads[0].observation.verificationContentBytes,
      projectionHitSegments: hits(hitsOnWarmReads[0].observation),
    },
  }));
});

test("authenticated materialized state reuses a fixed head and falls back after derived-state corruption", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t, false);
  const cache = cachePath(f.manifest.libraryId);
  const projectionRecords = join(f.home, "derived-projections", f.manifest.libraryId.replace(":", "-"));
  // Remove only this isolated fixture's materialized and replay projections to establish a measured no-hit path.
  await fs.rm(join(cache, "materialized.bin"), { force: true });
  await fs.rm(join(cache, "materialized-events.bin"), { force: true });
  await fs.rm(join(projectionRecords, "materialized.json"), { force: true });
  await fs.rm(join(projectionRecords, "materialized-events.json"), { force: true });
  await discardCacheSnapshot(f.manifest.libraryId, f.home);
  await fs.rm(join(f.home, "replay-projections", f.manifest.libraryId.replace(":", "-")), { recursive: true, force: true });

  const fixedHead = await sourceSnapshot(f);
  const reference = await genesisRead(f);
  const noHit = await authorityRead(f);
  const noHitHead = await sourceSnapshot(f);
  assert.equal(noHitHead.headIdentity, fixedHead.headIdentity);
  assert.equal(noHitHead.inputDigest, fixedHead.inputDigest);
  assert.deepEqual(noHit.state, reference.state);
  assert.equal(noHit.resultDigest, reference.resultDigest);
  assert.ok(noHit.observation.replayedEvents > 0, "the no-hit path performs the authority replay");

  const hit = await authorityRead(f);
  const hitHead = await sourceSnapshot(f);
  assert.equal(hitHead.headIdentity, fixedHead.headIdentity);
  assert.equal(hitHead.inputDigest, fixedHead.inputDigest);
  assert.deepEqual(hit.state, reference.state);
  assert.equal(hit.resultDigest, reference.resultDigest);
  assert.equal(hit.observation.replayedEvents, 0);
  assert.ok(hit.observation.cacheReasons.includes("materialized-state-hit"));
  assert.equal(hit.observation.verificationContentBytes, noHit.observation.verificationContentBytes,
    "a materialized-state hit still proves every current source byte");

  const changedSourceBefore = await sourceSnapshot(f);
  await createWork(f.library, { projectId: f.sources[0].projectId, externalKey: "VERIFY-MATERIALIZED-CHANGED",
    kind: "Initiative", parentId: null, title: "Changed materialized source", scope: "source changed after the fixed-head pair", occurredAt: at });
  const changedSource = await sourceSnapshot(f);
  assert.notEqual(changedSource.headIdentity, changedSourceBefore.headIdentity);
  assert.notEqual(changedSource.inputDigest, changedSourceBefore.inputDigest);
  const changedReference = await genesisRead(f);
  const changed = await authorityRead(f);
  assert.deepEqual(changed.state, changedReference.state);
  assert.equal(changed.resultDigest, changedReference.resultDigest);
  assert.ok(changed.observation.replayedEvents > 0, "a changed source head cannot reuse the earlier materialized state");

  const corruptionResults = [];
  for (const filename of ["materialized.bin", "materialized-events.bin"]) {
    const stateBeforeDamage = await sourceSnapshot(f);
    const target = join(cache, filename);
    const targetBytes = await fs.readFile(target);
    const proofPath = join(projectionRecords, filename.replace(/\.bin$/u, ".json"));
    const proofBefore = await fs.readFile(proofPath);
    const cacheBefore = await fileInventory(cache);
    const changedBytes = Buffer.from(targetBytes);
    changedBytes[0] ^= 1;
    await fs.writeFile(target, changedBytes);
    const cacheAfterDamage = await fileInventory(cache);
    const changedCachePaths = cacheAfterDamage.filter(file => cacheBefore.find(before => before.path === file.path)?.sha256 !== file.sha256).map(file => file.path);
    assert.deepEqual(changedCachePaths, [filename], "only the selected derived state payload was damaged");
    assert.equal(digestBytes(await fs.readFile(proofPath)), digestBytes(proofBefore), "the independent local proof remains unchanged");
    const stateAfterDamage = await sourceSnapshot(f);
    assert.equal(stateAfterDamage.headIdentity, stateBeforeDamage.headIdentity);
    assert.equal(stateAfterDamage.inputDigest, stateBeforeDamage.inputDigest);

    const recovered = await authorityRead(f);
    assert.deepEqual(recovered.state, changedReference.state);
    assert.equal(recovered.resultDigest, changedReference.resultDigest);
    assert.ok(recovered.observation.cacheReasons.includes("materialized-state-fallback"));
    const stateAfterRecovery = await sourceSnapshot(f);
    assert.equal(stateAfterRecovery.headIdentity, stateBeforeDamage.headIdentity);
    assert.equal(stateAfterRecovery.inputDigest, stateBeforeDamage.inputDigest);
    const restored = await authorityRead(f);
    assert.deepEqual(restored.state, changedReference.state);
    assert.equal(restored.resultDigest, changedReference.resultDigest);
    assert.equal(restored.observation.replayedEvents, 0);
    assert.ok(restored.observation.cacheReasons.includes("materialized-state-hit"));
    corruptionResults.push({ damagedObject: filename, originalSha256: digestBytes(targetBytes), damagedSha256: digestBytes(changedBytes),
      proofSha256Unchanged: digestBytes(proofBefore), sourceHeadIdentity: stateBeforeDamage.headIdentity,
      sourceInputDigest: stateBeforeDamage.inputDigest, recovered: materializationMetrics(recovered), restored: materializationMetrics(restored) });
  }

  t.diagnostic(JSON.stringify({ schemaVersion: "tcrn.story701.materialized-state-local-evidence.v1", platform: process.platform,
    darwinNativeBehavior: "unverified: this run is Linux", fixtureRoot: f.root,
    fixedHead: { identity: fixedHead.headIdentity, inputDigest: fixedHead.inputDigest, inputFiles: fixedHead.inputFiles },
    fullRecomputeReference: materializationMetrics(reference),
    fixedHeadNoHit: materializationMetrics(noHit), fixedHeadHit: materializationMetrics(hit),
    changedSource: { fromHeadIdentity: changedSourceBefore.headIdentity, headIdentity: changedSource.headIdentity,
      inputDigest: changedSource.inputDigest, inputFiles: changedSource.inputFiles,
      fullRecomputeReference: materializationMetrics(changedReference), actual: materializationMetrics(changed) },
    corruptionResults }));
});

test("resident local fixture bytes remain fully proved after a warmed projection", async t => {
  const f = await fixture(t);
  const result = await warm(f);
  assert.ok(result.observation.logicalEventBytes > 0);
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  await fs.writeFile(f.target, await corrupt(f));
  await assert.rejects(read(f), error => error.reasonCode === "AKASHA_EVENT_CORRUPT");
  await assert.rejects(materializeWorkspaceFromGenesis(f.library), error => error.reasonCode === "AKASHA_EVENT_CORRUPT");
});

test("a local source change during content proof cannot reuse an older projection", async t => {
  const f = await fixture(t);
  await warm(f);
  const changed = await corrupt(f);
  const originalOpen = fs.open;
  let changedDuringProbe = false;
  t.mock.method(fs, "open", async (path, ...arguments_) => {
    const handle = await originalOpen(path, ...arguments_);
    if (String(path) === f.target && !changedDuringProbe) {
      changedDuringProbe = true;
      writeFileSync(f.target, changed);
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(read(f), error => error.reasonCode === "AKASHA_EVENT_CORRUPT");
  assert.equal(changedDuringProbe, true);
});

test("resident native local files reuse without provider-only download keys", { skip: !native }, async t => {
  const f = await fixture(t);
  const result = await warm(f);
  assert.ok(result.observation.cacheReadBytes > 0);
  assert.ok(result.observation.verificationRecordBytes > 0);
});

test("verified projections avoid repeated event validation and batch native helpers", { skip: !native }, async t => {
  const f = await fixture(t);
  provider(t);
  const first = await read(f);
  const result = await read(f);
  assert.ok(hits(result.observation) > 0);
  assert.ok(result.observation.logicalEventBytes > 0, "native attributes cannot attest unchanged bytes");
  assert.ok(result.observation.verificationHelperScriptBytes > 0);
  const helper = await fs.readFile(new URL("../packages/core/src/darwin-source-identity.mjs", import.meta.url));
  assert.equal(result.observation.verificationHelperScriptBytes, helper.length * 3);
  assert.ok(result.observation.cacheReadBytes < first.observation.logicalEventBytes + first.observation.cacheReadBytes);
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
});

test("verified byte reuse preserves complete state, append, rollover and public events", { skip: !native }, async t => {
  const f = await fixture(t);
  provider(t);
  const first = await warm(f);
  assert.ok(first.observation.cacheReadBytes > 0);
  assert.ok(first.observation.verificationRecordBytes > 0);
  assert.ok(first.observation.verificationHelperScriptBytes > 0);
  await setWorkspaceSetting(f.library, { key: "storage.snapshotEveryEvents", value: "7", occurredAt: at });
  let result = await read(f);
  assert.ok(result.observation.logicalEventBytes > 0, "the changed active segment is fully read");
  assert.ok(hits(result.observation) > 0, "unchanged segments still reuse verified bytes");
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  await createWork(f.library, { projectId: f.sources[0].projectId, externalKey: "VERIFY-LARGE", kind: "Initiative", parentId: null, title: "New calibration", scope: "calibration ".repeat(700), occurredAt: at });
  result = await read(f);
  assert.ok(result.observation.logicalEventBytes > 0, "the new segment is fully read");
  assert.ok(hits(result.observation) > 0);
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  const events = await withRecallObservation(() => readAllStreams(f.library));
  assert.ok(events.observation.logicalEventBytes > 0, "public source-event API still reads actual sources");
  assert.equal(hits(events.observation), 0);
  assert.ok(events.value.consolidation.sources[1].read.events.length > 0);
});

test("prior verification stays in the device home when runtime is relocated into the source", { skip: !native }, async t => {
  const f = await fixture(t);
  await configureStorageLocation(f.home, f.library, join(f.library, ".einzbern", "runtime"), at, "minutes:000000000000000000000001#D1", true);
  provider(t);
  await warm(f);
  assert.ok((await fs.readdir(f.records)).length > 0);
  assert.equal(cachePath(f.manifest.libraryId).startsWith(f.library), false);
  assert.equal(f.records.startsWith(f.library), false);
});

test("a device home inside the source cannot issue or consume records", { skip: !native }, async t => {
  const f = await fixture(t);
  const nested = join(f.library, "nested-device");
  await fs.cp(f.home, nested, { recursive: true });
  process.env.EINZBERN_HOME = nested;
  provider(t);
  const result = await read(f);
  assert.equal(hits(result.observation), 0);
  assert.ok(result.observation.logicalEventBytes > 0);
  assert.ok(result.observation.replayedEvents > 0);
  assert.equal(result.observation.cacheReasons.includes("consolidation-checkpoint-validated"), false);
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
});

for (const field of ["boot", "mount", "volume", "generation", "deviceIdentity", "engineVersion", "projection", "library", "source", "coverage"]) {
  test(`a prior record with wrong ${field} falls back`, { skip: !native }, async t => {
    const f = await fixture(t);
    provider(t);
    await warm(f);
    await editRecord(f, record => {
      if (["boot", "mount", "volume"].includes(field)) record.native[field] = "different-identity";
      else if (field === "generation") record.native.generation += 1;
      else if (field === "library") record.binding.libraryId = "library:" + "f".repeat(24);
      else if (field === "source") record.binding.sourceId = "library:" + "f".repeat(24);
      else if (field === "coverage") record.coverage += 1;
      else record[field] = "different-version";
    });
    const result = await read(f);
    assert.ok(result.observation.logicalEventBytes > 0);
    assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  });
}

for (const kind of ["record-missing", "record-damaged", "cache-missing", "cache-damaged"]) {
  test(`${kind} cannot authorize reuse`, { skip: !native }, async t => {
    const f = await fixture(t);
    provider(t);
    await warm(f);
    const directory = kind.startsWith("record") ? f.records : f.cache;
    const path = join(directory, (await fs.readdir(directory))[0]);
    if (kind.endsWith("missing")) await fs.unlink(path);
    else await fs.writeFile(path, "broken record/cache\n");
    const result = await read(f);
    assert.ok(result.observation.logicalEventBytes > 0);
    assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  });
}

test("a coherent shared projection cannot replace the independent local digest", { skip: !native }, async t => {
  const f = await fixture(t);
  provider(t);
  await warm(f);
  const path = join(f.cache, (await fs.readdir(f.cache)).find(name => name.endsWith(".bin")));
  const events = JSON.parse(gunzipSync(await fs.readFile(path)).toString("utf8"));
  events[0].payload = { ...events[0].payload, forgedProjection: "shared writer" };
  await fs.writeFile(path, gzipSync(JSON.stringify(events)));
  const result = await read(f);
  assert.ok(result.observation.logicalEventBytes > 0);
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
});

test("an archived duplicate projection still authenticates its own cache bytes", { skip: !native }, async t => {
  const f = await fixture(t);
  provider(t);
  await warm(f);
  const records = await Promise.all((await fs.readdir(f.records)).filter(name => name.endsWith(".json")).map(async name => ({
    key: name.slice(0, -5),
    record: JSON.parse(await fs.readFile(join(f.records, name), "utf8")).record,
  })));
  const duplicate = records.find(({ record }) => record.binding.archive !== "" && records.some(other =>
    other.record.binding.archive === "" && other.record.projectionDigest === record.projectionDigest));
  assert.ok(duplicate, "live and archived sources must exercise an identical authenticated projection");
  const path = join(f.cache, `${duplicate.key}.bin`);
  const bytes = await fs.readFile(path);
  bytes[0] ^= 1;
  await fs.writeFile(path, bytes);
  const result = await read(f);
  assert.ok(result.observation.logicalEventBytes >= duplicate.record.coverage);
  assert.ok(result.observation.eventReadsBySource.some(source => source.scope === "archive" && source.streamId === duplicate.record.binding.streamId));
  assert.ok(hits(result.observation) > 0, "other authenticated segments still reuse");
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
});

for (const duringProbe of [false, true]) {
  test(`current identity scheme remains authoritative ${duringProbe ? "across metadata preparation" : "after a warm projection"}`, { skip: !native }, async t => {
    const f = await fixture(t);
    let mutate = false;
    const devices = await fs.readdir(join(f.library, "akasha"));
    const path = join(f.library, "akasha", devices[0], "manifest.json");
    const manifest = JSON.parse(await fs.readFile(path, "utf8"));
    const changed = canonicalJson({ ...manifest, identityScheme: "legacy" });
    provider(t, () => {
      if (mutate) { mutate = false; writeFileSync(path, changed); }
    });
    await warm(f);
    if (duringProbe) mutate = true;
    else await fs.writeFile(path, changed);
    for (const read of [() => materializeLibrary(f.library), () => materializeWorkspaceFromGenesis(f.library)]) {
      await assert.rejects(read, error => error.reasonCode === "AKASHA_EVENT_CORRUPT" && error.details?.break === "identity");
    }
  });
}

for (const kind of ["zero-generation", "unsupported-attributes", "network-volume", "incomplete-download", "provider-unknown", "attribute-short", "extent-mismatch", "extent-truncated", "helper-failure", "helper-timeout"]) {
  test(`${kind} preserves the full reader`, { skip: !native }, async t => {
    const f = await fixture(t);
    provider(t, value => {
      for (const file of value.files) {
        if (kind === "attribute-short") file.file.bytes = Buffer.alloc(4).toString("base64");
        if (kind === "extent-mismatch") { const bytes = Buffer.from(file.file.bytes, "base64"); bytes.writeUInt32LE(bytes.length + 1, 0); file.file.bytes = bytes.toString("base64"); }
        if (kind === "extent-truncated") file.volume.bytes = Buffer.from(file.volume.bytes, "base64").subarray(0, 100).toString("base64");
        if (kind === "zero-generation") { const bytes = Buffer.from(file.file.bytes, "base64"); bytes.writeUInt32LE(0, 40); file.file.bytes = bytes.toString("base64"); }
        if (kind === "unsupported-attributes") { const bytes = Buffer.from(file.volume.bytes, "base64"); bytes.writeUInt32LE(0, 92); file.volume.bytes = bytes.toString("base64"); }
        if (kind === "network-volume") { const bytes = Buffer.from(file.volume.bytes, "base64"); bytes.writeUInt32LE(0, 32); file.volume.bytes = bytes.toString("base64"); }
        if (kind === "incomplete-download") file.resources.NSURLUbiquitousItemIsDownloadingKey = true;
        if (kind === "provider-unknown") file.resources = {};
      }
    });
    if (kind.startsWith("helper-")) {
      t.mock.method(childProcess, "spawnSync", () => ({ status: kind === "helper-failure" ? 1 : null, stdout: "", stderr: "", error: kind === "helper-timeout" ? Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) : undefined }));
      syncBuiltinESMExports();
    }
    const result = await read(f);
    assert.equal(hits(result.observation), 0);
    assert.ok(result.observation.logicalEventBytes > 0);
    assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  });
}

test("an unavailable helper resource preserves the full reader", { skip: !native }, async t => {
  const f = await fixture(t);
  const original = fs.readFile;
  t.mock.method(fs, "readFile", (path, ...arguments_) => {
    if (String(path).endsWith("/darwin-source-identity.mjs")) return Promise.reject(Object.assign(new Error("missing helper"), { code: "ENOENT" }));
    return original(path, ...arguments_);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await read(f);
  assert.equal(hits(result.observation), 0);
  assert.ok(result.observation.logicalEventBytes > 0);
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
});

for (const kind of ["in-place", "same-name-replacement", "rename", "hardlink", "concurrent-after-query"]) {
  test(`${kind} after verification cannot conceal corruption`, { skip: !native }, async t => {
    const f = await fixture(t);
    let mutate = false;
    const changed = await corrupt(f);
    provider(t, (value, queries, request) => {
      if (mutate && kind === "concurrent-after-query" && request.files.some(file => file.path === f.target)) {
        writeFileSync(f.target, changed);
        mutate = false;
      }
    });
    await warm(f);
    if (kind === "in-place") { const before = await fs.stat(f.target); await fs.writeFile(f.target, changed); await fs.utimes(f.target, before.atime, before.mtime); }
    if (kind === "same-name-replacement") { const path = join(f.root, "replacement"); await fs.writeFile(path, changed); await fs.rename(path, f.target); }
    if (kind === "rename") { await fs.rename(f.target, join(f.root, "original")); await fs.writeFile(f.target, changed); }
    if (kind === "hardlink") await fs.link(f.target, join(f.root, "second-name"));
    if (kind === "concurrent-after-query") mutate = true;
    await assert.rejects(materializeLibrary(f.library));
    await assert.rejects(materializeWorkspaceFromGenesis(f.library));
  });
}


test("small consolidated sources keep full verification with only a placeholder precheck", { skip: !native }, async t => {
  const f = await fixture(t, false);
  const requests = [];
  t.mock.method(childProcess, "spawnSync", (command, arguments_, options) => {
    if (command === "/usr/bin/osascript") requests.push(JSON.parse(arguments_.at(-1)));
    return spawnSync(command, arguments_, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (let n = 0; n < 2; n += 1) {
    const result = await read(f);
    assert.equal(requests.length, n + 1);
    assert.ok(requests.every(request => request.preflight === true), "small sources classify availability without a native identity query");
    assert.equal(hits(result.observation), 0);
    assert.ok(result.observation.logicalEventBytes > 0);
    assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  }
  await fs.writeFile(f.target, await corrupt(f));
  await assert.rejects(materializeLibrary(f.library));
  await assert.rejects(materializeWorkspaceFromGenesis(f.library));
});

test("a current cost hint lets the full reader validate one index without retaining a parse scope", { skip: !native }, async t => {
  const f = await fixture(t, false);
  const path = join(f.library, f.manifest.consolidation.index);
  await fs.rm(join(cachePath(f.manifest.libraryId), "consolidation-cost.json"), { force: true });
  const originalRead = fs.readFile;
  const originalParse = JSON.parse;
  let reads = 0;
  let parses = 0;
  t.mock.method(fs, "readFile", async (file, ...args) => {
    if (file === path) reads += 1;
    return originalRead(file, ...args);
  });
  t.mock.method(JSON, "parse", (...args) => {
    const value = originalParse(...args);
    if (value?.schemaVersion === "einzbern.consolidation.v1") parses += 1;
    return value;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (let request = 1; request <= 2; request += 1) {
    const result = await read(f);
    assert.equal(reads, 2 * request, "a hint miss reuses its cost read for the placeholder precheck; a hint hit reads once for the precheck; each normal reader still validates its current index");
    assert.equal(parses, 2 * request - 1, "reuse ends with each materialization request; a hint hit precheck parses outside the reader");
    assert.ok(result.observation.logicalEventBytes > 0);
    assert.equal(hits(result.observation), 0);
  }
  const { withConsolidationIndexParseReuse } = await import("../dist/build/packages/core/src/source-verification.js");
  await withConsolidationIndexParseReuse(async () => {
    const index = await readConsolidationIndex(f.library, f.manifest);
    assert.ok(Object.isFrozen(index));
    assert.ok(Object.isFrozen(index.sources[0].inventory[0]));
    assert.throws(() => { index.sources[0].inventory[0].bytes += 1; }, TypeError);
    assert.equal(await readConsolidationIndex(f.library, f.manifest), index);
  });
});

test("an index corrupted after the cost precheck is rejected by the original reader", { skip: !native }, async t => {
  const f = await fixture(t, false);
  const path = join(f.library, f.manifest.consolidation.index);
  await fs.rm(join(cachePath(f.manifest.libraryId), "consolidation-cost.json"), { force: true });
  const originalRead = fs.readFile;
  let reads = 0;
  t.mock.method(fs, "readFile", async (file, ...args) => {
    const bytes = await originalRead(file, ...args);
    if (file === path && ++reads === 1) await fs.writeFile(path, bytes.toString("utf8").replace("agent:codex", "agent:other"));
    return bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(materializeLibrary(f.library), { reasonCode: "CONSOLIDATION_DIGEST_MISMATCH" });
  assert.equal(reads, 2);
  await assert.rejects(materializeWorkspaceFromGenesis(f.library), { reasonCode: "CONSOLIDATION_DIGEST_MISMATCH" });
});

test("a changed valid index replaces the cost parse and still verifies source authority", { skip: !native }, async t => {
  const f = await fixture(t, false);
  const path = join(f.library, f.manifest.consolidation.index);
  await fs.rm(join(cachePath(f.manifest.libraryId), "consolidation-cost.json"), { force: true });
  const originalRead = fs.readFile;
  const originalParse = JSON.parse;
  let reads = 0;
  let parses = 0;
  t.mock.method(JSON, "parse", (...args) => {
    const value = originalParse(...args);
    if (value?.schemaVersion === "einzbern.consolidation.v1") parses += 1;
    return value;
  });
  t.mock.method(fs, "readFile", async (file, ...args) => {
    const bytes = await originalRead(file, ...args);
    if (file === path && ++reads === 1) {
      const index = originalParse(bytes.toString("utf8"));
      index.sources[1].headEventHash = "0".repeat(64);
      const changed = canonicalJson(index);
      await fs.writeFile(path, changed);
      await fs.writeFile(join(f.library, "manifest.json"), canonicalJson({ ...f.manifest, consolidation: { ...f.manifest.consolidation, sha256: digestBytes(changed) } }));
    }
    return bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(materializeLibrary(f.library), { reasonCode: "CONSOLIDATION_SOURCE_CHANGED" });
  assert.equal(reads, 2);
  assert.equal(parses, 2, "changed current bytes cannot reuse the cost parse");
  await assert.rejects(materializeWorkspaceFromGenesis(f.library), { reasonCode: "CONSOLIDATION_SOURCE_CHANGED" });
});

test("native protocol returns the complete packed attributes without buffer padding", { skip: !native }, async t => {
  const f = await fixture(t);
  let queried = 0;
  provider(t, value => {
    for (const file of value.files) for (const attributes of [file.file, file.volume]) {
      const bytes = Buffer.from(attributes.bytes, "base64");
      assert.equal(attributes.result, 0);
      assert.equal(bytes.readUInt32LE(), bytes.length);
      assert.ok(bytes.length >= 24 && bytes.length < 8192);
      queried += 1;
    }
  }, (value, request) => {
    assert.equal(request.preflight, true);
    for (const file of value.files) {
      const bytes = Buffer.from(file.file.bytes, "base64");
      assert.equal(file.file.result, 0);
      assert.equal(bytes.readUInt32LE(), bytes.length);
      assert.ok(bytes.length >= 24 && bytes.length < 8192);
      queried += 1;
    }
  });
  await warm(f);
  assert.ok(queried > 0);
});


test("a failed cost precheck preserves the full reader's earlier source error", { skip: !native }, async t => {
  const f = await fixture(t, false);
  const [device] = await fs.readdir(join(f.library, "akasha"));
  const [segment] = (await fs.readdir(join(f.library, "akasha", device))).filter(name => name.endsWith(".ndjson"));
  const path = join(f.library, "akasha", device, segment);
  const original = await fs.readFile(path, "utf8");
  const changed = original.replace('"name":"coordination"', '"name":"Coordination"');
  assert.notEqual(changed, original);
  await fs.writeFile(path, changed);
  const index = join(f.library, "artifacts/consolidation/index.json");
  await fs.writeFile(index, (await fs.readFile(index, "utf8")).replace("agent:codex", "agent:other"));
  for (const read of [materializeLibrary, materializeWorkspaceFromGenesis]) {
    await assert.rejects(read(f.library), error => error.reasonCode === "AKASHA_EVENT_CORRUPT" && error.details?.break === "payloadHash");
  }
});


test("untrusted cost hints cannot skip current index or historical source validation", { skip: !native }, async t => {
  const f = await fixture(t, false);
  await read(f);
  const hint = join(cachePath(f.manifest.libraryId), "consolidation-cost.json");
  const prior = JSON.parse(await fs.readFile(hint, "utf8"));
  assert.equal(prior.indexSha256, f.manifest.consolidation.sha256);
  assert.equal(prior.libraryId, f.manifest.libraryId);
  // Forged advice can choose either existing reader; neither receives authority.
  for (const archiveBytes of [0, 4 * 1024 * 1024]) {
    await fs.writeFile(hint, JSON.stringify({ ...prior, archiveBytes }));
    assert.deepEqual((await read(f)).value, await materializeWorkspaceFromGenesis(f.library));
  }
  await fs.writeFile(f.target, await corrupt(f));
  for (const archiveBytes of [0, 4 * 1024 * 1024]) {
    await fs.writeFile(hint, JSON.stringify({ ...prior, archiveBytes }));
    await assert.rejects(materializeLibrary(f.library), { reasonCode: "AKASHA_EVENT_CORRUPT" });
  }
  // Matching advice still cannot make a changed current index valid.
  const index = join(f.library, f.manifest.consolidation.index);
  await fs.writeFile(index, (await fs.readFile(index, "utf8")).replace("agent:codex", "agent:other"));
  await fs.writeFile(hint, JSON.stringify({ ...prior, archiveBytes: 0 }));
  await assert.rejects(materializeLibrary(f.library), { reasonCode: "CONSOLIDATION_DIGEST_MISMATCH" });
});

test("stale, foreign, malformed and oversized cost hints fall back and refresh from the checked index", { skip: !native }, async t => {
  const f = await fixture(t, false);
  await read(f);
  const hint = join(cachePath(f.manifest.libraryId), "consolidation-cost.json");
  const prior = JSON.parse(await fs.readFile(hint, "utf8"));
  for (const text of [
    JSON.stringify({ ...prior, indexSha256: "0".repeat(64), archiveBytes: 4 * 1024 * 1024 }),
    JSON.stringify({ ...prior, libraryId: "library:" + "0".repeat(24), archiveBytes: 4 * 1024 * 1024 }),
    JSON.stringify({ ...prior, archiveBytes: -1 }),
    "{", " ".repeat(513),
  ]) {
    await fs.writeFile(hint, text);
    const result = await read(f);
    assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
    assert.equal(hits(result.observation), 0);
    assert.ok(result.observation.cacheReasons.includes("source-verification-full-cost-path"));
    assert.deepEqual(JSON.parse(await fs.readFile(hint, "utf8")), prior);
  }
});
