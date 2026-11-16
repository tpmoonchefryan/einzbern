// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createKnowledgeUnit, createKnowledgeArticle, reverifyKnowledgeUnit, refreshKnowledgeArticle, createProject, initializeKnowledgeStore, initializeLibrary, removeKnowledgeUnit, cachePath } from "../dist/build/packages/core/src/index.js";
import { controlSourceAttestor } from "../dist/build/packages/core/src/source-attestor-client.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const repo = fileURLToPath(new URL("../", import.meta.url)), addon = resolve(repo, "dist/native/linux-source-lease.node");
const enabled = process.platform === "linux" && await fs.stat(addon).then(() => true, () => false);
const at = "2026-11-13T00:00:00Z", late = "2026-11-15T00:00:00Z";
const journal = process.env.EINZBERN_ATTESTOR_COMMAND_JOURNAL;

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "crest-production-"))), root = join(base, "library"), home = join(base, "device");
  const original = { ...process.env };
  Object.assign(process.env, { EINZBERN_HOME: home, EINZBERN_SOURCE_ATTESTOR_ROOT: root, EINZBERN_SOURCE_LEASE_MODULE: addon });
  t.after(async () => {
    await controlSourceAttestor(root, home, "stop", [join(root, "crest")]).catch(() => undefined);
    await controlSourceAttestor(root, home, "stop").catch(() => undefined);
    await delay(50);
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original); await fs.rm(base, { recursive: true, force: true });
  });
  const library = await initializeLibrary({ root, createdAt: at });
  const projectId = (await createProject(root, { externalKey: "CREST-PROOF-PROJECT", name: "Crest proof", occurredAt: at })).projects[0].id;
  await initializeKnowledgeStore(root, { disposableAcknowledged: true });
  const f = { base, root, home, projectId, libraryId: library.metadata.workspaceId };
  await card(f, "CREST-SENSOR", "Calibrated sensor", { expires: true });
  return f;
}
function card(f, key, subject, { expires = false, user = false } = {}) {
  return createKnowledgeUnit(f.root, { externalKey: key, scope: user ? "user" : "project", projectId: user ? null : f.projectId,
    roleScopes: [], category: "testing", kind: "fact", subject, summary: `${subject} has a measured reference.`, snippet: `${subject} reference.`,
    tags: [key.toLowerCase()], sourceReferences: [], sourceDigest: canonicalSha256(key), linkedEvidenceIds: [], linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [],
    retrievalDisposition: "default", freshnessState: "fresh", lastVerified: expires ? at : null,
    stalenessPolicy: { maximumAgeDays: expires ? 1 : null, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only",
    accountableOwnerId: "owner:crest-proof", body: `${subject}: complete independent source body.`, lifecycle: "active", occurredAt: at }, user ? { scope: "user" } : {});
}
async function read(f, mode, query = { at }) {
  const argv = [process.execPath, resolve(repo, "tests/fixtures/crest-projection-client.mjs"), mode, f.root, JSON.stringify(query)];
  const started = Date.now(), r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024, env: process.env });
  if (journal) await fs.appendFile(journal, JSON.stringify({ label: `production-${mode}`, argv, pid: r.pid, root: f.root, started, ended: Date.now(),
    exitCode: r.status, signal: r.signal, timedOut: r.error?.code === "ETIMEDOUT", stdout: r.stdout, stderr: r.stderr }) + "\n");
  assert.equal(r.status, 0, r.stderr); const result = JSON.parse(r.stdout); assert.equal(result.error, undefined, result.error);
  return result;
}
const warmed = result => result.observation.cacheReasons.includes("crest-source-set-warm") && result.observation.cacheReasons.includes("crest-source-set-finish-valid");

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
  assert.deepEqual((await read(f, "fast")).value, (await read(f, "full")).value);
  const proofs = join(f.home, "derived-projections", f.libraryId.replace(":", "-"));
  for (const field of ["schemaVersion", "engine", "binding", "sha256"]) {
    await read(f, "list"); await read(f, "list");
    const file = join(proofs, "crest-meta.json"), receipt = JSON.parse(await fs.readFile(file, "utf8"));
    receipt[field] = "old-or-damaged"; await fs.writeFile(file, JSON.stringify(receipt));
    assert.deepEqual((await read(f, "fast")).value, (await read(f, "full")).value, `${field}: full reader equivalence`);
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
