// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createKnowledgeUnit, createKnowledgeArticle, reverifyKnowledgeUnit, refreshKnowledgeArticle, createProject, initializeKnowledgeStore, initializeLibrary, removeKnowledgeUnit, cachePath } from "../dist/build/packages/core/src/index.js";
import { localIdentityContext } from "../dist/build/packages/core/src/local-file-identity.js";
import { controlSourceAttestor } from "../dist/build/packages/core/src/source-attestor-client.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const repo = fileURLToPath(new URL("../", import.meta.url)), addon = resolve(repo, "dist/native/linux-source-lease.node");
const enabled = process.platform === "linux" && await fs.stat(addon).then(() => true, () => false);
const at = "2026-11-13T00:00:00Z", late = "2026-11-15T00:00:00Z";
const journal = process.env.EINZBERN_ATTESTOR_COMMAND_JOURNAL;
const report = process.env.EINZBERN_CREST_PROJECTION_REPORT;

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "crest-production-"))), root = join(base, "library"), home = join(base, "device"), homeB = join(base, "device-b");
  const original = { ...process.env };
  Object.assign(process.env, { EINZBERN_HOME: home, EINZBERN_SOURCE_ATTESTOR_ROOT: root, EINZBERN_SOURCE_LEASE_MODULE: addon });
  t.after(async () => {
    for (const deviceHome of [home, homeB]) {
      await controlSourceAttestor(root, deviceHome, "stop", [join(root, "crest")]).catch(() => undefined);
      await controlSourceAttestor(root, deviceHome, "stop").catch(() => undefined);
    }
    await delay(50);
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original); await fs.rm(base, { recursive: true, force: true });
  });
  const library = await initializeLibrary({ root, createdAt: at });
  const projectId = (await createProject(root, { externalKey: "CREST-PROOF-PROJECT", name: "Crest proof", occurredAt: at })).projects[0].id;
  await initializeKnowledgeStore(root, { disposableAcknowledged: true });
  const f = { base, root, home, homeB, projectId, libraryId: library.metadata.workspaceId };
  await card(f, "CREST-SENSOR", "Calibrated sensor", { expires: true });
  return f;
}
function card(f, key, subject, { expires = false, user = false, body, coexist = false, occurredAt = at } = {}) {
  return createKnowledgeUnit(f.root, { externalKey: key, scope: user ? "user" : "project", projectId: user ? null : f.projectId,
    roleScopes: [], category: "testing", kind: "fact", subject, summary: `${subject} has a measured reference.`, snippet: `${subject} reference.`,
    tags: [key.toLowerCase()], sourceReferences: [], sourceDigest: canonicalSha256(key), linkedEvidenceIds: [], linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [],
    retrievalDisposition: "default", freshnessState: "fresh", lastVerified: expires ? at : null,
    stalenessPolicy: { maximumAgeDays: expires ? 1 : null, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only",
    accountableOwnerId: "owner:crest-proof", body: body ?? `${subject}: complete independent source body.`, lifecycle: "active", occurredAt,
    ...(coexist ? { coexist: true } : {}) }, user ? { scope: "user" } : {});
}
async function read(f, mode, query = { at }, { allowError = false, home = f.home } = {}) {
  const argv = [process.execPath, resolve(repo, "tests/fixtures/crest-projection-client.mjs"), mode, f.root, JSON.stringify(query)];
  const started = Date.now(), r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, EINZBERN_HOME: home } });
  if (journal) await fs.appendFile(journal, JSON.stringify({ label: `production-${mode}`, argv, pid: r.pid, root: f.root, started, ended: Date.now(),
    home, exitCode: r.status, signal: r.signal, timedOut: r.error?.code === "ETIMEDOUT", stdout: r.stdout, stderr: r.stderr }) + "\n");
  assert.equal(r.status, 0, r.stderr); const result = JSON.parse(r.stdout); if (!allowError) assert.equal(result.error, undefined, result.error);
  return result;
}
const warmed = result => result.observation.cacheReasons.includes("crest-source-set-warm") && result.observation.cacheReasons.includes("crest-source-set-finish-valid");
const conflicts = result => result.value.unresolvedConflicts ?? result.value.diagnostics.conflictExamples ?? [];

async function asHome(home, operation) {
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = home;
  try { return await operation(); }
  finally { process.env.EINZBERN_HOME = previous; }
}

function gullCard(key, subject, { coexist = false, occurredAt = at } = {}) {
  const target = subject.split(",")[0].replace(/\b(?:survey|census|check|measure)$/u, "").trim();
  return {
    occurredAt, externalKey: key, scope: "workspace", projectId: null, roleScopes: [],
    category: "workflow", kind: "fact", tags: ["devices"], subject,
    summary: `${target} must use only ${key.toLowerCase()}`, snippet: `${subject}, the line to recall`,
    accountableOwnerId: "owner:sub-414", sourceReferences: [], sourceDigest: null,
    linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [], retrievalDisposition: "default",
    freshnessState: "fresh", lastVerified: null, stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: `${key} body`, ...(coexist ? { coexist: true } : {}),
  };
}

async function holdDeviceEvents(f, home) {
  const deviceId = JSON.parse(await fs.readFile(join(home, "device.json"), "utf8")).deviceId;
  const stream = join(f.root, "crest", "events", deviceId), held = join(f.base, `held-${deviceId}`);
  await fs.mkdir(held, { recursive: true });
  for (const name of await fs.readdir(stream)) await fs.rename(join(stream, name), join(held, name));
  return async () => {
    for (const name of await fs.readdir(held)) await fs.rename(join(held, name), join(stream, name));
    await fs.rm(held, { recursive: true, force: true });
  };
}

async function concurrentGullPair(f) {
  const gullA = await asHome(f.home, () => createKnowledgeUnit(f.root, gullCard("SUB-414-GULL-A", "Gull nesting cliff survey")));
  const restore = await holdDeviceEvents(f, f.home);
  let gullB;
  try {
    gullB = await asHome(f.homeB, () => createKnowledgeUnit(f.root, gullCard("SUB-414-GULL-B", "Gull nesting cliff census")));
  } finally { await restore(); }
  return { gullA, gullB };
}

async function declaredGullPair(f) {
  const gullA = await asHome(f.home, () => createKnowledgeUnit(f.root, gullCard("SUB-414-GULL-A", "Gull nesting cliff survey")));
  const gullB = await asHome(f.homeB, () => createKnowledgeUnit(f.root, gullCard("SUB-414-GULL-B", "Gull nesting cliff census", { coexist: true })));
  return { gullA, gullB };
}

async function sourceSnapshot(f) {
  const root = join(f.root, "crest"), files = [];
  const visit = async directory => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(path);
        const info = await fs.lstat(path, { bigint: true });
        files.push({ path: path.slice(root.length + 1), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
          device: info.dev.toString(), inode: info.ino.toString(), mtimeNs: info.mtimeNs.toString(), ctimeNs: info.ctimeNs.toString(), mode: info.mode.toString() });
      }
    }
  };
  await visit(root);
  return { bytes: files.reduce((total, file) => total + file.bytes, 0), files };
}

function measured(result) {
  const observation = result.observation;
  return {
    resultDigest: result.value.resultDigest,
    conflictPairCount: result.value.diagnostics.conflictPairCount,
    conflictIds: conflicts(result),
    cacheReasons: observation.cacheReasons,
    replayedEvents: observation.replayedEvents,
    replayElapsedMs: observation.replayElapsedMs,
    segmentReads: observation.segmentReads,
    logicalEventBytes: observation.logicalEventBytes,
    verificationContentBytes: observation.verificationContentBytes,
    metadataReadBytes: observation.metadataReadBytes,
    cacheReadBytes: observation.cacheReadBytes,
    cacheWriteBytes: observation.cacheWriteBytes,
    verificationRecordBytes: observation.verificationRecordBytes,
    verificationHelperInputBytes: observation.verificationHelperInputBytes,
    verificationHelperOutputBytes: observation.verificationHelperOutputBytes,
    verificationHelperElapsedMs: observation.verificationHelperElapsedMs,
    elapsedMs: observation.elapsedMs,
  };
}

async function recordReport(value) {
  if (report) await fs.appendFile(report, `${JSON.stringify(value)}\n`);
}

test("Crest production: a cold Recall entry establishes continuity for the next fresh Recall process", { skip: !enabled }, async t => {
  const f = await fixture(t);
  const first = await read(f, "recall");
  assert.equal(first.value.cards.length, 1);
  const second = await read(f, "recall");
  assert.deepEqual(second.value, first.value); assert.equal(warmed(second), true);
  assert.deepEqual((await read(f, "fast")).value, (await read(f, "full")).value);
});

test("Crest production: ordinary list, fast metadata and readRecallCards adopt a complete proof across fresh processes and fixed-head expiry", { skip: !enabled }, async t => {
  const f = await fixture(t), full = await read(f, "full");
  assert.deepEqual((await read(f, "list")).value, full.value);
  const warm = await read(f, "list"); assert.deepEqual(warm.value, full.value); assert.equal(warmed(warm), true);
  const fast = await read(f, "fast"); assert.deepEqual(fast.value, full.value); assert.equal(warmed(fast), true);
  const recall = await read(f, "recall"); assert.equal(warmed(recall), true); assert.equal(recall.value.cards.length, 1);
  assert.equal(new Set([warm.pid, fast.pid, recall.pid]).size, 3);
  const expired = await read(f, "fast", { at: late }); assert.equal(warmed(expired), true); assert.equal(expired.value.records.length, 0);
  assert.deepEqual(expired.value, (await read(f, "full", { at: late })).value);
  assert.equal(expired.value.sourceVersion.headEventHash, full.value.sourceVersion.headEventHash);
  assert.equal((await read(f, "recall", { at: late })).value.cards.length, 0);
});

test("Crest production: no-client additions and removals, user independence, and damaged projection/receipt use full-equivalent results", { skip: !enabled }, async t => {
  const f = await fixture(t); await read(f, "list"); assert.equal(warmed(await read(f, "fast")), true);
  await card(f, "CREST-GAP-ADDED", "Independent pressure gauge");
  const addition = await read(f, "fast"); assert.deepEqual(addition.value, (await read(f, "full")).value);
  assert.ok(addition.value.records.some(row => row.externalKey === "CREST-GAP-ADDED"));
  await read(f, "list"); await read(f, "list");
  await removeKnowledgeUnit(f.root, { id: deriveStableId("knowledge", "CREST-GAP-ADDED"), reason: "invalid", basis: "owned fixture removal", actor: "owner:crest-proof", occurredAt: at });
  const removal = await read(f, "fast"); assert.deepEqual(removal.value, (await read(f, "full")).value);
  assert.ok(!removal.value.records.some(row => row.externalKey === "CREST-GAP-ADDED"));
  assert.deepEqual((await read(f, "list", { at, status: "removed" })).value, (await read(f, "full", { at, status: "removed" })).value);
  await card(f, "CREST-USER", "User independent notebook", { user: true });
  assert.ok((await read(f, "recall")).value.cards.some(row => row.scope === "user"));
  await read(f, "list"); await read(f, "list");
  const cache = cachePath(f.libraryId); await fs.writeFile(join(cache, "crest-meta.bin"), "damaged projection");
  const damagedMeta = await read(f, "fast"); assert.deepEqual(damagedMeta.value, (await read(f, "full")).value);
  assert.notEqual((await fs.readFile(join(cache, "crest-meta.bin"))).toString(), "damaged projection", "the fallback rebuilds the damaged projection");
  const repairedMeta = await read(f, "fast"); assert.deepEqual(repairedMeta.value, damagedMeta.value);
  assert.ok(repairedMeta.observation.cacheReasons.includes("crest-projection-hit"), "the repaired metadata projection serves the next request");
  const proofs = join(f.home, "derived-projections", f.libraryId.replace(":", "-"));
  for (const field of ["schemaVersion", "engine", "binding", "sha256"]) {
    await read(f, "list"); await read(f, "list");
    const file = join(proofs, "crest-meta.json"), receipt = JSON.parse(await fs.readFile(file, "utf8"));
    receipt[field] = "old-or-damaged"; await fs.writeFile(file, JSON.stringify(receipt));
    const recovered = await read(f, "fast");
    assert.deepEqual(recovered.value, (await read(f, "full")).value, `${field}: full reader equivalence`);
    const reread = await read(f, "fast"); assert.deepEqual(reread.value, recovered.value, `${field}: repaired receipt is reusable`);
    assert.ok(reread.observation.cacheReasons.includes("crest-projection-hit"), `${field}: repaired receipt serves a hit`);
  }
});

test("Crest production: metadata and body revisions written in client gaps equal the complete reader", { skip: !enabled }, async t => {
  const f = await fixture(t); await read(f, "list"); assert.equal(warmed(await read(f, "fast")), true);
  await reverifyKnowledgeUnit(f.root, { expectedRevision: 1, occurredAt: late, id: deriveStableId("knowledge", "CREST-SENSOR") });
  const reverified = await read(f, "fast", { at: late });
  assert.deepEqual(reverified.value, (await read(f, "full", { at: late })).value);
  assert.equal(reverified.value.records[0].revision, 2); assert.equal(reverified.value.records[0].lastVerified, late);
  const article = await createKnowledgeArticle(f.root, { occurredAt: late, path: "continuity.md", category: "workflow", title: "Continuity reference",
    summary: "Original index summary.", content: "Original article body.", accountableOwnerId: "owner:crest-proof", linkedEvidenceIds: ["evidence:crest-owned-fixture"] });
  const query = { at: late, includeExplicitOnly: true };
  const before = await read(f, "list", query); await read(f, "fast", query);
  const old = before.value.records.find(row => row.id === article.id);
  await fs.writeFile(article.path, (await fs.readFile(article.path, "utf8")).replace("Original article body.", "Revised article body."));
  await refreshKnowledgeArticle(f.root, { expectedRevision: 1, occurredAt: late, id: article.id, path: "continuity.md", summary: "Revised index summary." });
  const changed = await read(f, "fast", query);
  assert.deepEqual(changed.value, (await read(f, "full", query)).value);
  const current = changed.value.records.find(row => row.id === article.id);
  assert.equal(current.revision, 2); assert.notEqual(current.bodySha256, old.bodySha256); assert.equal(current.summary, "Revised index summary.");
});

test("Crest projection: SUB-414 conflict reuse, large source change, damage recovery, descriptor replacement, and removal match full replay", { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t), pair = await concurrentGullPair(f);
  const expectedPair = [[pair.gullA.id, pair.gullB.id].sort()];
  const sourceAtPair = await sourceSnapshot(f);
  const independent = await read(f, "full");
  assert.deepEqual(conflicts(independent), expectedPair);
  assert.equal(independent.value.diagnostics.conflictPairCount, 1);
  const cold = await read(f, "list");
  assert.deepEqual(conflicts(cold), expectedPair);
  const hot = await read(f, "fast");
  assert.deepEqual(hot.value, independent.value);
  assert.deepEqual(conflicts(hot), expectedPair);
  assert.ok(hot.observation.cacheReasons.includes("crest-projection-hit"));
  assert.equal(hot.value.diagnostics.conflictPairCount, 1);
  assert.deepEqual(await sourceSnapshot(f), sourceAtPair, "hot reuse leaves authoritative source bytes unchanged");
  await recordReport({
    scenario: "SUB-414-GULL-A/B warm reuse",
    cards: [{ externalKey: "SUB-414-GULL-A", id: pair.gullA.id }, { externalKey: "SUB-414-GULL-B", id: pair.gullB.id }],
    source: sourceAtPair, expectedConflictIds: expectedPair, fullReplay: measured(independent), coldProjection: measured(cold), warmProjection: measured(hot),
    pairRecalculationsOnWarmHit: 0,
    pairRecalculationBasis: "The validated crest-projection-hit path returns the stored unresolvedConflicts set without invoking Crest scanning or pair comparison; replay/segment counters are retained below.",
  });

  const largeBody = "L".repeat(300 * 1024);
  await asHome(f.home, () => card(f, "CREST-OVER-256-KIB", "Large verified source", { body: largeBody, expires: true }));
  const sourceAfterLarge = await sourceSnapshot(f);
  const largeBodyFiles = sourceAfterLarge.files.filter(file => file.bytes === Buffer.byteLength(largeBody));
  assert.equal(largeBodyFiles.length, 1);
  assert.equal(largeBodyFiles[0].sha256, createHash("sha256").update(largeBody).digest("hex"));
  const afterLarge = await read(f, "fast");
  const fullAfterLarge = await read(f, "full");
  assert.deepEqual(afterLarge.value, fullAfterLarge.value);
  assert.deepEqual(conflicts(afterLarge), expectedPair);
  assert.ok(!afterLarge.observation.cacheReasons.includes("crest-projection-hit"), "the new >256 KiB source invalidates the old projection");
  await recordReport({
    scenario: ">256 KiB source addition invalidates the previous projection",
    sourceBefore: sourceAtPair, sourceAfter: sourceAfterLarge,
    largeBody: { bytes: Buffer.byteLength(largeBody), sha256: createHash("sha256").update(largeBody).digest("hex"), path: largeBodyFiles[0].path },
    staleProjectionFallback: measured(afterLarge), independentFullReplay: measured(fullAfterLarge), expectedConflictIds: expectedPair,
  });

  const cache = cachePath(f.libraryId), projectionSourceBefore = await sourceSnapshot(f);
  await fs.writeFile(join(cache, "crest.bin"), "damaged Crest projection");
  const projectionRecovery = await read(f, "list"), projectionFull = await read(f, "full");
  assert.deepEqual(projectionRecovery.value, projectionFull.value);
  assert.deepEqual(conflicts(projectionRecovery), expectedPair);
  assert.ok(projectionRecovery.observation.cacheReasons.includes("crest-projection-build"));
  const projectionHit = await read(f, "fast");
  assert.deepEqual(projectionHit.value, projectionFull.value);
  assert.ok(projectionHit.observation.cacheReasons.includes("crest-projection-hit"));
  assert.deepEqual(await sourceSnapshot(f), projectionSourceBefore, "projection corruption did not alter the authoritative Crest source");
  await recordReport({
    scenario: "same-source crest projection corruption and rebuild",
    sourceBefore: projectionSourceBefore, sourceAfter: await sourceSnapshot(f), expectedConflictIds: expectedPair,
    damagedProjection: measured(projectionRecovery), independentFullReplay: measured(projectionFull), nextWarmHit: measured(projectionHit),
  });

  const metaSourceBefore = await sourceSnapshot(f);
  await fs.writeFile(join(cache, "crest-meta.bin"), "damaged Crest metadata projection");
  const metaRecovery = await read(f, "fast"), metaFull = await read(f, "full");
  assert.deepEqual(metaRecovery.value, metaFull.value);
  assert.deepEqual(conflicts(metaRecovery), expectedPair);
  const metaHit = await read(f, "fast");
  assert.deepEqual(metaHit.value, metaFull.value);
  assert.ok(metaHit.observation.cacheReasons.includes("crest-projection-hit"));
  assert.deepEqual(await sourceSnapshot(f), metaSourceBefore, "crest-meta corruption did not alter the authoritative Crest source");
  await recordReport({
    scenario: "same-source crest-meta projection corruption and repair",
    sourceBefore: metaSourceBefore, sourceAfter: await sourceSnapshot(f), expectedConflictIds: expectedPair,
    damagedProjection: measured(metaRecovery), independentFullReplay: measured(metaFull), repairedWarmHit: measured(metaHit),
  });

  const receiptSourceBefore = await sourceSnapshot(f);
  const receiptPath = join(f.home, "derived-projections", f.libraryId.replace(":", "-"), "crest-meta.json");
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  receipt.sha256 = "f".repeat(64);
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  const receiptRecovery = await read(f, "fast"), receiptFull = await read(f, "full");
  assert.deepEqual(receiptRecovery.value, receiptFull.value);
  assert.deepEqual(conflicts(receiptRecovery), expectedPair);
  const repairedBytes = await fs.readFile(join(cache, "crest-meta.bin"));
  const repairedReceipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  assert.equal(repairedReceipt.sha256, createHash("sha256").update(repairedBytes).digest("hex"));
  assert.equal(repairedReceipt.bytes, repairedBytes.length);
  const receiptHit = await read(f, "fast");
  assert.deepEqual(receiptHit.value, receiptFull.value);
  assert.ok(receiptHit.observation.cacheReasons.includes("crest-projection-hit"));
  assert.deepEqual(await sourceSnapshot(f), receiptSourceBefore, "receipt corruption did not alter the authoritative Crest source");
  await recordReport({
    scenario: "same-source crest-meta receipt corruption and repair",
    sourceBefore: receiptSourceBefore, sourceAfter: await sourceSnapshot(f), expectedConflictIds: expectedPair,
    damagedReceipt: measured(receiptRecovery), independentFullReplay: measured(receiptFull), repairedWarmHit: measured(receiptHit),
    repairedReceipt: { bytes: repairedBytes.length, sha256: repairedReceipt.sha256 },
  });

  const deviceId = JSON.parse(await fs.readFile(join(f.home, "device.json"), "utf8")).deviceId;
  const eventPath = join(f.root, "crest", "events", deviceId, (await fs.readdir(join(f.root, "crest", "events", deviceId))).find(name => name.endsWith(".json")));
  const backupPath = join(f.base, "held-read-time-replacement.json"), replacementSourceBefore = await sourceSnapshot(f);
  const replacement = await read(f, "replacement", { at, replacementPath: eventPath, backupPath }, { allowError: true });
  assert.equal(replacement.error, "KNOWLEDGE_SOURCE_CHANGED");
  assert.equal(replacement.replacementTriggered, true);
  const replacementSourceAfter = await sourceSnapshot(f);
  assert.deepEqual(replacementSourceAfter.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    replacementSourceBefore.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), "the replacement fixture restores exact source bytes");
  const afterReplacementFull = await read(f, "full");
  const afterReplacement = await read(f, "fast");
  assert.deepEqual(afterReplacement.value, afterReplacementFull.value);
  assert.deepEqual(conflicts(afterReplacement), expectedPair);
  await recordReport({
    scenario: "held event descriptor detects a same-path replacement",
    sourceBefore: replacementSourceBefore, sourceAfter: replacementSourceAfter,
    replacementError: replacement.error, replacementTriggered: replacement.replacementTriggered,
    independentFullReplay: measured(afterReplacementFull), recoveredRead: measured(afterReplacement), expectedConflictIds: expectedPair,
  });

  await asHome(f.home, () => removeKnowledgeUnit(f.root, { id: pair.gullA.id, reason: "invalid", basis: "isolated projection recovery fixture", actor: "owner:crest-proof", occurredAt: at }));
  const removed = await read(f, "list"), removedFull = await read(f, "full");
  assert.deepEqual(removed.value, removedFull.value);
  assert.deepEqual(conflicts(removed), []);
  assert.equal(removed.value.diagnostics.conflictPairCount, 0);
  const removedHit = await read(f, "fast");
  assert.deepEqual(removedHit.value, removedFull.value);
  assert.deepEqual(conflicts(removedHit), []);
  await recordReport({
    scenario: "removal removes SUB-414 pair from cached and full results",
    source: await sourceSnapshot(f), removedId: pair.gullA.id, expectedConflictIds: [],
    removalRebuild: measured(removed), independentFullReplay: measured(removedFull), warmAfterRemoval: measured(removedHit),
  });
});

test("Crest projection: declared coexistence for SUB-414-GULL-A/B is retained by reuse and full recomputation", { skip: !enabled }, async t => {
  const f = await fixture(t), pair = await declaredGullPair(f), source = await sourceSnapshot(f);
  const full = await read(f, "full");
  assert.deepEqual(conflicts(full), []);
  assert.equal(full.value.diagnostics.conflictPairCount, 0);
  const declared = full.value.records.find(record => record.id === pair.gullB.id);
  assert.ok(declared.extensions.coexistsWith.includes(pair.gullA.id));
  const cold = await read(f, "list"), hot = await read(f, "fast");
  assert.deepEqual(cold.value, full.value);
  assert.deepEqual(hot.value, full.value);
  assert.deepEqual(conflicts(hot), []);
  assert.ok(hot.observation.cacheReasons.includes("crest-projection-hit"));
  assert.deepEqual(await sourceSnapshot(f), source);
  await recordReport({
    scenario: "SUB-414-GULL-A/B declared coexistence",
    cards: [{ externalKey: "SUB-414-GULL-A", id: pair.gullA.id }, { externalKey: "SUB-414-GULL-B", id: pair.gullB.id }],
    coexistenceIds: declared.extensions.coexistsWith, source,
    fullReplay: measured(full), coldProjection: measured(cold), warmProjection: measured(hot),
  });
});

test("Crest projection: local tree proof hashes changed content in a >256 KiB source file", { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t), store = join(f.root, "crest"), context = await localIdentityContext(store);
  if (context === null) { t.skip("this filesystem does not expose the admitted local identity capability"); return; }
  const previousRoot = process.env.EINZBERN_SOURCE_ATTESTOR_ROOT;
  process.env.EINZBERN_SOURCE_ATTESTOR_ROOT = join(f.base, "attestor-disabled");
  try {
    await read(f, "list");
    const largeBody = "A".repeat(300 * 1024);
    await asHome(f.home, () => card(f, "CREST-LOCAL-TREE-LARGE", "Large local identity source", { body: largeBody, expires: true }));
    const sourceBefore = await sourceSnapshot(f);
    const bodyFile = sourceBefore.files.find(file => file.bytes === Buffer.byteLength(largeBody));
    assert.ok(bodyFile);
    assert.equal(bodyFile.sha256, createHash("sha256").update(largeBody).digest("hex"));
    const cold = await read(f, "list");
    const warm = await read(f, "fast");
    assert.deepEqual(warm.value, cold.value);
    assert.ok(warm.observation.cacheReasons.includes("crest-projection-hit"));

    const bodyPath = join(store, bodyFile.path), changedBody = Buffer.from(largeBody);
    changedBody[changedBody.length - 1] = 0x42;
    await fs.writeFile(bodyPath, changedBody);
    const sourceAfter = await sourceSnapshot(f);
    const changedFile = sourceAfter.files.find(file => file.path === bodyFile.path);
    assert.equal(changedFile.bytes, bodyFile.bytes);
    assert.notEqual(changedFile.sha256, bodyFile.sha256);
    assert.equal(changedFile.sha256, createHash("sha256").update(changedBody).digest("hex"));
    const changed = await read(f, "fast"), full = await read(f, "full");
    assert.deepEqual(changed.value, full.value);
    assert.ok(!changed.observation.cacheReasons.includes("crest-projection-hit"));
    assert.ok(changed.observation.cacheReasons.includes("crest-projection-build"));
    const rewarm = await read(f, "fast");
    assert.deepEqual(rewarm.value, full.value);
    assert.ok(rewarm.observation.cacheReasons.includes("crest-projection-hit"));
    await recordReport({
      scenario: "localTreeIdentity detects same-size >256 KiB content change without source attestor",
      context, sourceBefore, sourceAfter,
      changedFile: { path: bodyFile.path, bytes: changedFile.bytes, beforeSha256: bodyFile.sha256, afterSha256: changedFile.sha256 },
      warmBeforeChange: measured(warm), changedFallback: measured(changed), independentFullReplay: measured(full), rewarm: measured(rewarm),
      note: "The fixture changes a metadata-only body file in place; list results are compared with an independent full metadata replay. A body read remains protected by its stored SHA-256.",
    });
  } finally {
    if (previousRoot === undefined) delete process.env.EINZBERN_SOURCE_ATTESTOR_ROOT;
    else process.env.EINZBERN_SOURCE_ATTESTOR_ROOT = previousRoot;
  }
});
