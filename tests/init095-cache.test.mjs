// SPDX-License-Identifier: Apache-2.0
// Neutral, generated calibration data. No private library or evaluation inputs.
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  initializeLibrary, createProject, setWorkspaceSetting, appendEvents, createWorkDelta,
  createKnowledgeUnit, initializeKnowledgeStore, materializeLibrary, materializeWorkspaceFromGenesis,
  readAllStreams, cachePath, configureStorageLocation, lockPath, backupsPath,
  declareChainIdentity, consolidateLibraries, registerLibrary, recordMinutes,
  listKnowledgeMetadata,
} from "../dist/build/packages/core/src/index.js";
import { withRecallObservation } from "../dist/build/packages/core/src/recall-observation.js";
import { withWorkspaceWriteLock } from "../dist/build/packages/core/src/workspace.js";
import { RecallIndex, recallPersistent, resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { canonicalJson, canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { localIdentityContext } from "../dist/build/packages/core/src/local-file-identity.js";

const at = "2026-11-13T00:00:00Z";
const late = "2026-11-15T00:00:00Z";
const libraryId = n => `library:${n.toString(16).padStart(24, "0")}`;
const hits = o => o.verifiedSegmentsBySource.reduce((n, s) => n + s.segments, 0);
const measure = root => withRecallObservation(() => materializeLibrary(root));

// Touch the mapping before warming any proof. Later writes through that same
// writable page need not change ctime. Restore even when the assertion fails.
async function withWritableMapping(path, offset, operation) {
  const original = await fs.readFile(path);
  const python = spawn("python3", ["-u", "-c", `import hashlib,json,mmap,sys
with open(sys.argv[1], 'r+b', buffering=0) as f:
 with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_WRITE) as m:
  offset=int(sys.argv[2]); original=m[offset]; m[offset]=original
  print(json.dumps({'ready':True}),flush=True)
  try:
   if sys.stdin.readline().strip() != 'mutate': raise RuntimeError('expected mutate')
   m[offset]=ord('X') if original != ord('X') else ord('Y')
   print(json.dumps({'mutated':True}),flush=True)
   sys.stdin.readline()
  finally:
   m[offset]=original
   print(json.dumps({'restored':hashlib.sha256(m).hexdigest()}),flush=True)
`, path, String(offset)], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  python.stderr.on("data", value => { stderr += value; });
  const finished = new Promise((resolve, reject) => { python.once("error", reject); python.once("close", code => resolve(code)); });
  const lines = createInterface({ input: python.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    assert.equal(line.done, false, stderr);
    return JSON.parse(line.value);
  };
  assert.equal((await next()).ready, true);
  try {
    return await operation(async () => { python.stdin.write("mutate\n"); assert.equal((await next()).mutated, true); });
  } finally {
    python.stdin.end("restore\n");
    const restored = await next();
    assert.equal(await finished, 0, stderr);
    assert.equal(restored.restored, createHash("sha256").update(original).digest("hex"));
  }
}

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "einzbern-init095-")));
  const previous = process.env.EINZBERN_HOME;
  const home = join(base, "device");
  process.env.EINZBERN_HOME = home;
  const root = join(base, "library");
  await initializeLibrary({ root, createdAt: at, libraryId: libraryId(95001) });
  const state = await createProject(root, { externalKey: "P095-PROJECT", name: "Calibration", occurredAt: at });
  t.after(async () => { resetRecallCache(); process.env.EINZBERN_HOME = previous; await fs.rm(base, { recursive: true, force: true }); });
  return { base, home, root, id: state.metadata.workspaceId, projectId: state.projects[0].id };
}

function child(f, mode, queryAt = at, projectId, query = "P095-FRESH P095-MIN#D2") {
  const source = `
    import { runCli } from ${JSON.stringify(new URL("../dist/build/packages/cli/src/index.js", import.meta.url).href)};
    import { listKnowledgeMetadata } from ${JSON.stringify(new URL("../dist/build/packages/core/src/knowledge-core.js", import.meta.url).href)};
    import { withRecallObservation } from ${JSON.stringify(new URL("../dist/build/packages/core/src/recall-observation.js", import.meta.url).href)};
    const root = ${JSON.stringify(f.root)}, at = ${JSON.stringify(queryAt)};
    const result = await withRecallObservation(async () => {
      if (${JSON.stringify(mode)} === "list") return listKnowledgeMetadata(root, { at, projectId: ${JSON.stringify(projectId)} });
      if (${JSON.stringify(mode)} === "hook") {
        const NativeDate = Date;
        globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return NativeDate.parse(at); } };
        const { runHookEvent } = await import(${JSON.stringify(new URL("../scripts/einzbern-hook.mjs", import.meta.url).href)});
        return runHookEvent({ event: "user-prompt-submit", libraryPath: root, cwd: ${JSON.stringify(f.base)}, payload: { prompt: ${JSON.stringify(query)}, cwd: ${JSON.stringify(f.base)} } });
      }
      let output = "";
      await runCli(["recall", "--workspace", root, "--at", at, "--query", ${JSON.stringify(query)}, "--view", "agent", ...${JSON.stringify(projectId === undefined ? [] : ["--project-id", projectId])}], {write: value => { output += value; }});
      return output;
    });
    console.log(JSON.stringify(result));
  `;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", env: { ...process.env, EINZBERN_HOME: f.home, EINZBERN_HOST: "claude-code" } });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
}

test("095: 220 segments, tail delta, in-place tampering, manifest tampering and unknown identity", async t => {
  const f = await fixture(t);
  await setWorkspaceSetting(f.root, { key: "storage.segmentBytes", value: "4096", occurredAt: at });
  await appendEvents(f.root, Array.from({ length: 219 }, (_, n) => createWorkDelta({
    projectId: f.projectId, externalKey: `P095-W${n}`, kind: "Initiative", parentId: null,
    title: `Calibration ${n}`, body: "Neutral sensor calibration. ".repeat(180), occurredAt: at,
  })), { occurredAt: at });
  const read = await readAllStreams(f.root);
  const stream = read.streams.find(s => s.manifest?.segments.length >= 220);
  assert.ok(stream);
  const supported = await localIdentityContext(f.root) !== null;
  const first = await measure(f.root);
  const second = await measure(f.root);
  if (supported) assert.ok(hits(second.observation) >= 220);
  else assert.equal(hits(second.observation), 0);
  assert.ok(second.observation.logicalEventBytes > 0, "attributes cannot replace current content verification");
  assert.deepEqual(second.value, await materializeWorkspaceFromGenesis(f.root));
  await appendEvents(f.root, [createWorkDelta({ projectId: f.projectId, externalKey: "P095-TAIL", kind: "Initiative", parentId: null, title: "Tail calibration", body: "Neutral tail. ".repeat(500), occurredAt: at })], { occurredAt: at });
  const delta = await measure(f.root);
  if (supported) assert.ok(hits(delta.observation) >= 220);
  else assert.equal(hits(delta.observation), 0);
  assert.ok(delta.observation.logicalEventBytes > 0);
  assert.ok(delta.value.version > first.value.version);
  assert.deepEqual(delta.value, await materializeWorkspaceFromGenesis(f.root));
  const strong = await withWorkspaceWriteLock(f.root, () => measure(f.root));
  assert.equal(hits(strong.observation), 0);
  assert.ok(strong.observation.logicalEventBytes > 0);
  const path = join(f.root, "akasha", stream.deviceId, stream.manifest.segments[1].name);
  const bytes = await fs.readFile(path);
  const info = await fs.stat(path);
  const changed = Buffer.from(bytes.toString("utf8").replace("Neutral sensor", "neutral sensor"));
  assert.equal(changed.length, bytes.length);
  assert.notDeepEqual(changed, bytes);
  await fs.writeFile(path, changed);
  await fs.utimes(path, info.atime, info.mtime);
  await assert.rejects(materializeLibrary(f.root), e => /AKASHA_.*CORRUPT/u.test(e.reasonCode));
  await fs.writeFile(path, bytes);
  const manifestPath = join(f.root, "akasha", stream.deviceId, "manifest.json");
  const originalManifest = await fs.readFile(manifestPath);
  const manifest = JSON.parse(originalManifest);
  manifest.segments[1].sha256 = "f".repeat(64);
  await fs.writeFile(manifestPath, canonicalJson(manifest));
  await assert.rejects(materializeLibrary(f.root));
  await fs.writeFile(manifestPath, originalManifest);
  const nativeReadFile = fs.readFile;
  t.mock.method(fs, "readFile", async (path, ...args) => String(path) === "/proc/sys/kernel/osrelease" ? "6.12.0-calibration\n" : nativeReadFile(path, ...args));
  syncBuiltinESMExports();
  try {
    const coarseKernel = await measure(f.root);
    assert.equal(hits(coarseKernel.observation), 0);
    assert.ok(coarseKernel.observation.logicalEventBytes > 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const statfs = fs.statfs;
  t.mock.method(fs, "statfs", async (...args) => ({ ...await statfs(...args), type: 0x65735546n }));
  syncBuiltinESMExports();
  try {
    const unknown = await measure(f.root);
    assert.equal(hits(unknown.observation), 0);
    assert.ok(unknown.observation.logicalEventBytes > 0);
    await fs.writeFile(path, changed);
    await assert.rejects(materializeLibrary(f.root), e => /AKASHA_.*CORRUPT/u.test(e.reasonCode));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  t.diagnostic(JSON.stringify({ segments: stream.manifest.segments.length, reused: hits(second.observation), tailBytes: delta.observation.logicalEventBytes, tailReplay: delta.observation.replayedEvents }));
});

test("095: local cache loss/corruption rebuilds; synchronized runtime locks and backups retain their paths", async t => {
  const f = await fixture(t);
  const runtime = join(f.root, ".einzbern", "runtime");
  await configureStorageLocation(f.home, f.root, runtime, at, `minutes:${"0".repeat(23)}1#D1`, true);
  const lock = lockPath(f.id), backup = backupsPath();
  assert.ok(lock.startsWith(runtime));
  assert.ok(backup.startsWith(runtime));
  assert.ok(cachePath(f.id).startsWith(join(f.home, "derived-cache")));
  const before = await measure(f.root);
  await fs.rm(cachePath(f.id), { recursive: true, force: true });
  assert.deepEqual((await measure(f.root)).value, before.value);
  await fs.writeFile(join(cachePath(f.id), "views", "STATUS.md"), "broken projection");
  assert.deepEqual((await measure(f.root)).value, await materializeWorkspaceFromGenesis(f.root));
  assert.equal(lockPath(f.id), lock);
  assert.equal(backupsPath(), backup);
});

test("095: same-head cross-process Crest/FTS freshness and old projection recovery match cold CLI output", async t => {
  const f = await fixture(t);
  await registerLibrary({ projectPath: f.base, projectId: f.projectId, libraryPath: f.root, registeredAt: at, gitRemote: null });
  await recordMinutes(f.root, { occurredAt: at, externalKey: "P095-MIN", projectId: f.projectId, title: "Neutral calibration decisions", summary: "Calibration provenance",
    decisions: ["Keep the neutral reference.", "Calibrate the alloy sensor."], decidedBy: [], linkedWorkIds: [] });
  await initializeKnowledgeStore(f.root, { disposableAcknowledged: true });
  await createKnowledgeUnit(f.root, {
    externalKey: "P095-FRESH", scope: "project", projectId: f.projectId, roleScopes: [], category: "testing", kind: "fact",
    subject: "Alloy calibration", summary: "The sensor measures seven units.", snippet: "Seven units.", tags: ["calibration"],
    sourceReferences: [], sourceDigest: canonicalSha256("init095.synthetic-source.v1"), linkedEvidenceIds: [], linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [],
    retrievalDisposition: "default", freshnessState: "fresh", lastVerified: at,
    stalenessPolicy: { maximumAgeDays: 1, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only", accountableOwnerId: "owner:calibration",
    body: "The neutral alloy sensor measures seven units.", lifecycle: "active", occurredAt: at,
  });
  const cold = child(f, "cli");
  const warm = child(f, "cli");
  assert.equal(warm.value, cold.value);
  assert.equal(warm.observation.cacheReasons.includes("crest-projection-hit"), await localIdentityContext(f.root) !== null);
  assert.ok(warm.observation.logicalEventBytes > 0);
  assert.ok(warm.observation.cacheReasons.includes("fts-persistent-hit"));
  const hookCold = child(f, "hook"), hookWarm = child(f, "hook");
  assert.equal(hookWarm.value, hookCold.value);
  assert.ok(hookWarm.value.includes("D2 现行有效"));
  assert.ok(hookWarm.value.includes("minutes-show --id"));
  assert.ok(hookWarm.observation.cacheReasons.includes("fts-persistent-hit"));
  const expired = child(f, "cli", late);
  assert.notEqual(expired.value, warm.value);
  assert.ok(!expired.value.includes("Seven units."));
  const hookExpired = child(f, "hook", late);
  assert.ok(hookExpired.value.includes("D2 现行有效"));
  await fs.rm(cachePath(f.id), { recursive: true, force: true });
  const expiredCold = child(f, "cli", late);
  assert.equal(expiredCold.value, expired.value);
  assert.equal(child(f, "hook", late).value, hookExpired.value);
  await fs.writeFile(join(cachePath(f.id), "crest.bin"), "broken crest projection");
  const crestRebuilt = child(f, "cli", late);
  assert.equal(crestRebuilt.value, expiredCold.value);
  assert.equal(crestRebuilt.observation.cacheReasons.includes("crest-projection-hit"), false);
  const proofs = join(f.home, "derived-projections", f.id.replace(":", "-"));
  for (const name of await fs.readdir(proofs)) {
    const path = join(proofs, name), record = JSON.parse(await fs.readFile(path, "utf8"));
    record.binding = "old-projection-version";
    await fs.writeFile(path, JSON.stringify(record));
  }
  const upgraded = child(f, "cli", late);
  assert.equal(upgraded.value, expiredCold.value);
  assert.equal(upgraded.observation.cacheReasons.includes("crest-projection-hit"), false);
  assert.equal(upgraded.observation.cacheReasons.includes("fts-persistent-hit"), false);
  assert.equal(child(f, "hook", late).value, hookExpired.value);
});

function documents(text = "Seven alloy units") {
  return ["P095-SENSOR", "P095-OTHER"].map((key, n) => ({ id: deriveStableId("knowledge", key), kind: "card", key,
    status: "active", title: key, body: n === 0 ? text : "Neutral reference", tags: "alloy", expansions: "", summary: n === 0 ? text : "Neutral reference",
    recordKind: "card", parentChain: [], lead: "", decisions: [{ number: 1, text: n === 0 ? text : "Neutral reference", reference: `${key}#D1`, scope: "calibration", status: "valid" }] }));
}

test("095: persistent FTS updates only changed rows, and truncation/busy locks recover", async t => {
  const f = await fixture(t);
  const request = (docs, checkpoint) => ({ cacheKey: "init095.synthetic-source.v1", checkpoint, query: "alloy", documents: () => docs, tau: 0 });
  await recallPersistent(request(documents(), "head-1"), f.root);
  resetRecallCache();
  const reused = await withRecallObservation(() => recallPersistent({ ...request([], "head-1"), documents() { throw new Error("same head must not rebuild documents"); } }, f.root));
  assert.ok(reused.observation.cacheReasons.includes("fts-persistent-hit"));
  resetRecallCache();
  const next = documents("Eight alloy units");
  const delta = await withRecallObservation(() => recallPersistent(request(next, "head-2"), f.root));
  assert.ok(delta.observation.cacheReasons.includes("fts-persistent-delta:1:1"));
  const baseline = new RecallIndex(next, "head-2");
  assert.deepEqual(delta.value.records, baseline.search("alloy"));
  baseline.close();
  resetRecallCache();
  const path = join(cachePath(f.id), (await fs.readdir(cachePath(f.id))).find(name => name.endsWith(".sqlite")));
  const locked = new DatabaseSync(path);
  locked.exec("BEGIN EXCLUSIVE");
  try {
    const busy = await withRecallObservation(() => recallPersistent(request(next, "head-2"), f.root));
    assert.deepEqual(busy.value.records, delta.value.records);
    assert.ok(busy.observation.cacheReasons.includes("fts-persistent-invalid-or-busy"));
  } finally { locked.exec("ROLLBACK"); locked.close(); resetRecallCache(); }
  await fs.truncate(path, 31);
  const repaired = await recallPersistent(request(next, "head-2"), f.root);
  assert.deepEqual(repaired.records, delta.value.records);
  resetRecallCache();
  const before = await fs.stat(path);
  const corrupted = new DatabaseSync(path);
  corrupted.exec("DELETE FROM recall_prose; DELETE FROM recall_index; DELETE FROM recall_clauses");
  corrupted.close();
  await fs.utimes(path, before.atime, before.mtime);
  assert.equal((await fs.stat(path)).size, before.size);
  const restored = await recallPersistent(request(next, "head-2"), f.root);
  assert.deepEqual(restored.records, delta.value.records, "same-size/mtime cache edits cannot authorize reuse");
});

test("095: an existing writable mapping cannot hide source damage from warmed segment projections", async t => {
  const f = await fixture(t);
  const stream = (await readAllStreams(f.root)).streams.find(stream => stream.manifest?.segments.length);
  const path = join(f.root, "akasha", stream.deviceId, stream.manifest.segments[0].name);
  const original = await fs.readFile(path);
  const offset = original.indexOf("Calibration");
  assert.ok(offset >= 0);
  await withWritableMapping(path, offset, async mutate => {
    await measure(f.root);
    const warm = await measure(f.root);
    if (await localIdentityContext(f.root) !== null) assert.ok(hits(warm.observation) > 0);
    const before = await fs.stat(path, { bigint: true });
    await mutate();
    const after = await fs.stat(path, { bigint: true });
    assert.notDeepEqual(await fs.readFile(path), original);
    t.diagnostic(JSON.stringify({ mappedSourceCtimeUnchanged: before.ctimeNs === after.ctimeNs }));
    for (const read of [materializeLibrary, materializeWorkspaceFromGenesis, readAllStreams]) {
      await assert.rejects(read(f.root), { reasonCode: "AKASHA_EVENT_CORRUPT" });
    }
  });
  assert.deepEqual(await materializeLibrary(f.root), await materializeWorkspaceFromGenesis(f.root));
});

test("095: Crest projection content proof rejects an existing mapped event write", async t => {
  const f = await fixture(t);
  await initializeKnowledgeStore(f.root, { disposableAcknowledged: true });
  await createKnowledgeUnit(f.root, {
    externalKey: "P095-MAPPED", scope: "project", projectId: f.projectId, roleScopes: [], category: "testing", kind: "fact",
    subject: "Mapped sensor", summary: "Mapped sensor units", snippet: "Seven mapped units", tags: ["calibration"],
    sourceReferences: [], sourceDigest: canonicalSha256("init095.mapped-sensor.v1"), linkedEvidenceIds: [], linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [],
    retrievalDisposition: "default", freshnessState: "fresh", lastVerified: at,
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only", accountableOwnerId: "owner:calibration",
    body: "The mapped sensor measures seven units.", lifecycle: "active", occurredAt: at,
  });
  const eventRoot = join(f.root, "crest", "events");
  const device = (await fs.readdir(eventRoot))[0];
  const folder = join(eventRoot, device);
  const path = join(folder, (await fs.readdir(folder)).find(name => name.endsWith(".json")));
  const offset = (await fs.readFile(path)).indexOf("Mapped sensor units");
  assert.ok(offset >= 0);
  await withWritableMapping(path, offset, async mutate => {
    const query = () => listKnowledgeMetadata(f.root, { at });
    await query();
    const warm = await withRecallObservation(query);
    assert.equal(warm.value.records.length, 1);
    assert.equal(warm.observation.cacheReasons.includes("crest-projection-hit"), await localIdentityContext(f.root) !== null);
    await mutate();
    await assert.rejects(query(), { reasonCode: "KNOWLEDGE_RECORD_INVALID" });
  });
  assert.equal((await listKnowledgeMetadata(f.root, { at })).records[0].summary, "Mapped sensor units");
});

test("095: persistent FTS verifies a mapped database edit at the same checkpoint in one process", async t => {
  const f = await fixture(t);
  const docs = documents();
  const request = { cacheKey: "init095.mapped-index.v1", checkpoint: "mapped-head", query: "alloy", documents: () => docs, tau: 0 };
  const expected = (await recallPersistent(request, f.root)).records;
  const path = join(cachePath(f.id), (await fs.readdir(cachePath(f.id))).find(name => name.startsWith("recall-") && name.endsWith(".sqlite")));
  await withWritableMapping(path, 0, async mutate => {
    await recallPersistent(request, f.root);
    await mutate();
    const repaired = await withRecallObservation(() => recallPersistent(request, f.root));
    assert.deepEqual(repaired.value.records, expected);
    assert.ok(repaired.observation.cacheReasons.includes("fts-persistent-invalid-or-busy"));
  });
});

test("095: archived intrinsic scope survives a new-process projection without changing metadata", async t => {
  const f = await fixture(t);
  const other = join(f.base, "archive");
  await initializeLibrary({ root: other, createdAt: at, libraryId: libraryId(95002) });
  const archived = await createProject(other, { externalKey: "P095-ARCHIVE", name: "Archive calibration", occurredAt: at });
  const sources = [{ path: f.root, id: f.id, projectId: f.projectId, role: "coordination" }, { path: other, id: libraryId(95002), projectId: archived.projects[0].id, role: "project" }];
  for (const [n, source] of sources.entries()) {
    await declareChainIdentity(source.path, { role: source.role, coordinationLibraryId: f.id, ...(n ? { primaryProjectId: source.projectId } : {}) }, { occurredAt: at });
    await initializeKnowledgeStore(source.path, { disposableAcknowledged: true });
    await createKnowledgeUnit(source.path, {
      externalKey: n ? "P095-LEFT" : "P095-RIGHT", scope: "workspace", projectId: null, roleScopes: [], category: "testing", kind: "fact",
      subject: "Cache policy", summary: n ? "Enable cache" : "Disable cache", snippet: "Calibration policy", tags: ["calibration"], sourceReferences: [], sourceDigest: null,
      linkedEvidenceIds: [], linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], retrievalDisposition: "default", freshnessState: "fresh", lastVerified: null,
      stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only", accountableOwnerId: "owner:calibration",
      body: n ? "Enable cache" : "Disable cache", lifecycle: "active", occurredAt: at,
    });
    const projectPath = join(f.base, `project-${n}`);
    await fs.mkdir(projectPath);
    await registerLibrary({ projectPath, projectId: source.projectId, libraryPath: source.path, registeredAt: at, gitRemote: null });
    source.projectPath = projectPath;
  }
  const merged = join(f.base, "merged");
  await consolidateLibraries({ primary: f.root, sources: sources.map(source => ({ path: source.path, bindings: [{ projectPath: source.projectPath, projectId: source.projectId, role: source.role }] })) }, merged,
    { at, actor: "agent:codex", decidedIn: `minutes:${"0".repeat(23)}1#D1`, yes: true });
  const target = { ...f, root: merged };
  const before = child(target, "list", at, sources[1].projectId);
  const after = child(target, "list", at, sources[1].projectId);
  const supported = await localIdentityContext(merged) !== null;
  assert.equal(after.observation.cacheReasons.includes("crest-projection-hit"), supported);
  assert.deepEqual(after.value, before.value);
  assert.deepEqual(after.value.records.map(r => r.externalKey), ["P095-LEFT"]);
  assert.equal(after.value.diagnostics.conflictPairCount, 0);
  await registerLibrary({ projectPath: f.base, projectId: sources[1].projectId, libraryPath: merged, registeredAt: at, gitRemote: null });
  const cli = child(target, "cli", at, sources[1].projectId, "P095-LEFT P095-RIGHT");
  const hook = child(target, "hook", at, undefined, "P095-LEFT P095-RIGHT");
  const cardId = deriveStableId("knowledge", "P095-LEFT");
  assert.ok(cli.value.includes(cardId), cli.value);
  assert.ok(hook.value.includes(cardId));
  assert.equal(child(target, "cli", at, sources[1].projectId, "P095-LEFT P095-RIGHT").value, cli.value);
  assert.equal(child(target, "hook", at, undefined, "P095-LEFT P095-RIGHT").value, hook.value);
  await fs.rm(cachePath(f.id), { recursive: true, force: true });
  assert.equal(child(target, "cli", at, sources[1].projectId, "P095-LEFT P095-RIGHT").value, cli.value);
  assert.equal(child(target, "hook", at, undefined, "P095-LEFT P095-RIGHT").value, hook.value);
  if (supported) {
    const projection = join(cachePath(f.id), "materialized.bin");
    assert.ok((await fs.stat(projection)).size > 0);
    await fs.writeFile(projection, "broken projection");
    const rebuilt = child(target, "list", at, sources[1].projectId);
    assert.deepEqual(rebuilt.value, after.value);
    assert.equal(rebuilt.observation.cacheReasons.includes("materialized-state-hit"), false);
  }
  {
    const sourceRead = await readAllStreams(merged);
    const source = sourceRead.consolidation.sources.find(entry => entry.read.streams.some(stream => stream.manifest?.segments.length));
    const stream = source.read.streams.find(entry => entry.manifest?.segments.length);
    const path = join(merged, source.source.archive, "akasha", stream.deviceId, stream.manifest.segments[0].name);
    const bytes = await fs.readFile(path), info = await fs.stat(path);
    const changed = Buffer.from(bytes.toString("utf8").replace("Calibration", "calibration"));
    assert.equal(changed.length, bytes.length);
    assert.notDeepEqual(changed, bytes);
    await fs.writeFile(path, changed);
    await fs.utimes(path, info.atime, info.mtime);
    await assert.rejects(materializeLibrary(merged));
    await fs.writeFile(path, bytes);
    assert.deepEqual((await measure(merged)).value, await materializeWorkspaceFromGenesis(merged));
  }
});
