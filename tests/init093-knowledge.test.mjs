// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  createKnowledgeUnit, createProject, initializeKnowledgeStore, initializeLibrary,
  listKnowledgeMetadata, readKnowledgeBody, setWorkspaceSetting, applyMachineSettingSet,
} from "../dist/build/packages/core/src/index.js";
import { resolveIntrinsicKnowledgeScope, intrinsicScopesIntersect } from "../dist/build/packages/core/src/knowledge-scope.js";
import { promptRecallOutcome } from "../dist/build/packages/core/src/hook-recall.js";
import { registerLibrary } from "../dist/build/packages/core/src/registry.js";
import { knowledgeProjectionConflict } from "../dist/build/packages/core/src/knowledge-core.js";
import { assessKnowledgePair, knowledgeTopicTokens } from "../dist/build/packages/core/src/knowledge-conflict.js";
import { readRecallCards } from "../dist/build/packages/core/src/recall-inputs.js";
import { resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

const at = "2026-11-13T06:00:00Z";
const projectA = `project:${"a".repeat(24)}`;
const projectB = `project:${"b".repeat(24)}`;
const claim = (summary, extra = {}) => ({
  scope: "project", projectId: projectA, subject: "Cache retention policy", summary, snippet: "", tags: [], ...extra,
});

test("653: four intrinsic states distinguish archive project sets, explicit workspace sources and missing bindings", () => {
  const native = claim("");
  const a = resolveIntrinsicKnowledgeScope(native);
  const b = resolveIntrinsicKnowledgeScope({ ...native, projectId: projectB });
  const legacy = { scope: "workspace", projectId: null };
  const archived = resolveIntrinsicKnowledgeScope(legacy, { projectIds: [projectB, projectA, projectA], workspaceGlobal: false });
  const global = resolveIntrinsicKnowledgeScope(legacy, { projectIds: [], workspaceGlobal: true });
  const unknown = resolveIntrinsicKnowledgeScope(legacy, null);
  const empty = resolveIntrinsicKnowledgeScope(legacy, { projectIds: [], workspaceGlobal: false });
  const user = resolveIntrinsicKnowledgeScope({ scope: "user", projectId: null });
  assert.deepEqual(archived, { kind: "project", projectIds: [projectA, projectB], source: "archive-binding" });
  assert.equal(global.kind, "workspace-global");
  assert.equal(unknown.kind, "unresolved-legacy");
  assert.deepEqual(unknown, empty);
  for (const scope of [a, b, global, user, unknown]) {
    assert.equal(intrinsicScopesIntersect(unknown, scope), false);
    assert.equal(intrinsicScopesIntersect(scope, unknown), false);
  }
  assert.equal(intrinsicScopesIntersect(a, b), false);
  assert.equal(intrinsicScopesIntersect(a, archived), true);
  assert.equal(intrinsicScopesIntersect(a, global), true);
  assert.equal(intrinsicScopesIntersect(global, user), false);
  assert.equal(intrinsicScopesIntersect(user, user), true);
});

test("654: exact bilingual candidates need an opposite assertion about the same target", () => {
  assert.deepEqual([...knowledgeTopicTokens(claim("的", { subject: "的", tags: [] }))], []);
  assert.equal(assessKnowledgePair(claim("Enable cache"), claim("Disable cache", { projectId: projectB })).reason, "disjoint-scope");
  const complementary = [
    ["Record cache size", "Record cache age"],
    ["Do not delete backups", "Encrypt backups"],
    ["Enable gateway cache", "Disable client cache"],
    ["开启缓存并记录命中率", "缓存提供命中率统计"],
    ["Cache must use redis", "Cache must use redis with TLS"],
  ];
  for (const [a, b] of complementary) assert.notEqual(assessKnowledgePair(claim(a), claim(b)).relation, "conflicting", `${a} / ${b}`);
  const opposites = [
    ["Enable cache", "Disable cache"],
    ["Cache must be enabled", "Cache must be disabled"],
    ["Must retain audit logs", "Must not retain audit logs"],
    ["Deploy preview builds", "Do not deploy preview builds"],
    ["必须启用缓存", "禁止启用缓存"],
    ["保留审计日志", "删除审计日志"],
    ["必须使用严格模式", "不得使用严格模式"],
    ["Cache must use only redis", "Cache must use only memcached"],
    ["缓存必须使用同步模式", "缓存必须使用异步模式"],
  ];
  for (const [a, b] of opposites) {
    assert.equal(assessKnowledgePair(claim(a), claim(b)).relation, "conflicting", `${a} / ${b}`);
    assert.equal(assessKnowledgePair(claim(b), claim(a)).relation, "conflicting", `reverse ${b} / ${a}`);
    assert.equal(assessKnowledgePair(claim(a, { scope: "workspace", projectId: null }), claim(b)).relation, "conflicting");
  }
  const prefixA = claim("Must use terraform", { subject: "terra" });
  const prefixB = claim("Must not use terracotta", { subject: "terracotta" });
  assert.notEqual(assessKnowledgePair(prefixA, prefixB).relation, "conflicting");
  const a = { ...claim("Enable cache"), id: "knowledge:a" };
  const b = { ...claim("Disable cache"), id: "knowledge:b" };
  assert.equal(knowledgeProjectionConflict(a, b, at, at), true);
  assert.equal(knowledgeProjectionConflict(b, a, at, at), true);
});

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-init093-")));
  const previous = process.env.EINZBERN_HOME;
  const homes = [join(root, "device-a"), join(root, "device-b")];
  const devices = ["a".repeat(32), "b".repeat(32)];
  for (const [n, home] of homes.entries()) {
    await mkdir(home);
    await writeFile(join(home, "device.json"), canonicalJson({ schemaVersion: "einzbern.device.v1", deviceId: devices[n], createdAt: at, displayName: `test-${n}` }));
  }
  process.env.EINZBERN_HOME = homes[0];
  t.after(async () => { resetRecallCache(); process.env.EINZBERN_HOME = previous; await rm(root, { recursive: true, force: true }); });
  const workspace = join(root, "library");
  await initializeLibrary({ root: workspace, createdAt: at });
  const a = await createProject(workspace, { externalKey: "SCOPE-A", name: "A", occurredAt: at });
  const b = await createProject(workspace, { externalKey: "SCOPE-B", name: "B", occurredAt: at });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  const ids = [a.projects.find((r) => r.externalKey === "SCOPE-A").id, b.projects.find((r) => r.externalKey === "SCOPE-B").id];
  const write = (key, summary, extra = {}) => createKnowledgeUnit(workspace, {
    occurredAt: at, externalKey: key, scope: "project", projectId: ids[0], roleScopes: [], category: "workflow", kind: "fact",
    tags: ["scope-test"], subject: "Cache policy", summary, snippet: summary, accountableOwnerId: "owner:scope-test", sourceReferences: [],
    sourceDigest: canonicalSha256({ key }), linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [],
    retrievalDisposition: "default", freshnessState: "fresh", lastVerified: null,
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only", body: summary, ...extra,
  });
  const cli = async (args) => {
    let raw = "";
    await runCli(args, { write(value) { raw += value; } });
    return { raw, answer: JSON.parse(raw) };
  };
  return { root, workspace, homes, devices, ids, write, cli };
}

test("653/654: preflight isolates projects, admits related detail, and preserves explicit coexistence and supersession", async (t) => {
  const f = await fixture(t);
  const old = await f.write("OLD", "Enable cache");
  const related = await f.write("DETAIL", "Record cache size");
  assert.equal(related.conflicts, undefined);
  const elsewhere = await f.write("ELSEWHERE", "Disable cache", { projectId: f.ids[1] });
  assert.equal(elsewhere.conflicts, undefined);
  await assert.rejects(f.write("OPPOSITE", "Disable cache"), (error) => error.reasonCode === "KNOWLEDGE_POSSIBLE_CONFLICT" && error.details.conflicts.includes(old.id));
  await assert.rejects(f.write("GLOBAL", "Disable cache", { scope: "workspace", projectId: null }), { reasonCode: "KNOWLEDGE_POSSIBLE_CONFLICT" });
  const coexisting = await f.write("COEXIST", "Disable cache", { coexist: true });
  assert.deepEqual(coexisting.conflicts, [old.id]);
  const replaced = await f.write("REPLACE", "Disable cache", { supersedes: old.id });
  assert.equal(replaced.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  await assert.rejects(readKnowledgeBody(f.workspace, old.id, { at }), { reasonCode: "KNOWLEDGE_CARD_REMOVED" });
  const removed = await listKnowledgeMetadata(f.workspace, { at, status: "removed" });
  assert.equal(removed.records[0].removal.supersededBy, replaced.id);
});

const independent = JSON.parse(await readFile(new URL("./fixtures/init093-normal-entry.json", import.meta.url), "utf8"));
const counterFixture = JSON.parse(await readFile(new URL("./fixtures/init093-equivalent-version.json", import.meta.url), "utf8"));
const equivalentVersion = counterFixture.agreeing.map(card => claim(card.summary, card));

test("654: synonymous technical counter explanations remain Related", async (t) => {
  const [a, b] = equivalentVersion;
  assert.equal(assessKnowledgePair(a, b).relation, "related");
  assert.equal(assessKnowledgePair(b, a).relation, "related");
  const f = await fixture(t);
  const created = [];
  for (const [i, card] of equivalentVersion.entries()) {
    created.push(await f.write(`EQUIVALENT-${i}`, card.summary, { subject: card.subject, snippet: card.snippet }));
  }
  const result = await listKnowledgeMetadata(f.workspace, { at });
  assert.deepEqual([result.eligibleCount, result.withheldCount, result.diagnostics.conflictPairCount], [2, 0, 0]);

});

test("654: explicit opposite store/chain choices conflict even with the common value-type word version", async (t) => {
  const [a, b] = counterFixture.exclusive.map(card => claim(card.summary, card));
  for (const [left, right] of [[a, b], [b, a]]) {
    assert.equal(assessKnowledgePair(left, right).relation, "conflicting");
    assert.equal(assessKnowledgePair(left, right).reason, "exclusive-values");
  }
  const f = await fixture(t);
  const first = await f.write("EXCLUSIVE-STORE", a.summary, { subject: a.subject });
  await assert.rejects(f.write("EXCLUSIVE-CHAIN", b.summary, { subject: b.subject }), error => {
    assert.equal(error.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT");
    assert.deepEqual(error.details.conflicts, [first.id]);
    return true;
  });
});

for (const sample of independent.cases) {
  test(`654: normal-entry ${sample.name} blocks the second write and delayed delivery withholds both IDs`, async (t) => {
    const f = await fixture(t);
    const projectId = f.ids[0];
    const first = await f.write("SYNTHETIC-FIRST", sample.summaries[0]);
    await assert.rejects(f.write("SYNTHETIC-SECOND", sample.summaries[1]), error => {
      assert.equal(error.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT");
      assert.deepEqual(error.details.conflicts, [first.id]);
      return true;
    });
    const beforeDelivery = await listKnowledgeMetadata(f.workspace, { at, projectId });
    assert.deepEqual(beforeDelivery.records.map(record => record.id), [first.id], "a refused write commits nothing");
    const stream = join(f.workspace, "crest", "events", f.devices[0]);
    await rename(stream, join(f.root, "delayed"));
    process.env.EINZBERN_HOME = f.homes[1];
    const second = await f.write("SYNTHETIC-SECOND", sample.summaries[1]);
    await rename(join(f.root, "delayed"), stream);
    const { answer, raw } = await f.cli(["knowledge-list", "--workspace", f.workspace, "--at", at, "--project-id", projectId]);
    const ids = [first.id, second.id].sort();
    assert.deepEqual(answer.records, []);
    assert.deepEqual([answer.activeCount, answer.eligibleCount, answer.withheldCount], [2, 0, 2]);
    assert.equal(answer.diagnostics.conflictPairCount, 1);
    assert.deepEqual(answer.diagnostics.idExamples, ids);
    assert.deepEqual(answer.unresolvedConflicts, [ids]);
    assert.ok(Buffer.byteLength(raw, "utf8") < 4096);
    const explicit = await listKnowledgeMetadata(f.workspace, { at, projectId, diagnostics: "conflicts", snapshot: answer.snapshot });
    assert.deepEqual(explicit.diagnosticPage.records, [ids]);
    const recalled = await readRecallCards(f.workspace, { at, projectId });
    assert.equal(recalled.projectCrestDegraded.withheldCards, 2);
    t.diagnostic(JSON.stringify({ inputs: sample.summaries, ids, conflictPairs: explicit.diagnosticPage.records, summaryBytes: Buffer.byteLength(raw) }));
  });
}

test("654: negative equivalence, compatible detail and intersecting quantitative constraints remain Related through the real API", async (t) => {
  const compatible = [
    ["Enable cache", "Do not disable cache"], ["必须启用缓存", "禁止关闭缓存"],
    ["必须启用缓存", "不禁用缓存"], ["Must not delete backups", "Must retain backups"],
    ["Cache maximum age must be 60 seconds", "Cache maximum age must be 1 minute"],
    ["Cache maximum age must be 60 seconds", "Cache maximum age must be at most 120 seconds"],
    ["Cache maximum age must be at least 30 seconds", "Cache maximum age must be at most 120 seconds"],
    ["Cache maximum age must be 60 seconds", "Cache minimum age must be 120 seconds"],
    ["Cache maximum age must be 60 seconds", "Cache maximum age must not be 120 seconds"],
    ["Cache must be secure", "Cache must be observable"], ["Cache must use redis", "Cache must use TLS"],
    ["Must enable cache node 60", "Must disable cache node 120"],
    ["Do not delete backups and enable cache", "Enable cache"],
    ["必须使用同步缓存", "缓存必须记录命中率"],
    ["The sync argument names ledger revision, not graph revision.", "The diagnostic compares ledger revision vs. graph revision."],
  ];
  for (const [a, b] of compatible) await t.test(`${a} / ${b}`, async (sub) => {
    const f = await fixture(sub);
    await f.write("FIRST", a);
    await f.write("SECOND", b);
    const list = await listKnowledgeMetadata(f.workspace, { at, projectId: f.ids[0] });
    assert.deepEqual([list.activeCount, list.eligibleCount, list.withheldCount, list.diagnostics.conflictPairCount], [2, 2, 0, 0]);
  });
  for (const [a, b] of [
    ["Cache age must be at most 60 seconds", "Cache age must be at least 120 seconds"],
    ["Cache age must be less than 60 seconds", "Cache age must be 60 seconds"],
    ["Cache shard count must be 1", "Cache shard count must be 2"],
    ["缓存有效期必须为60秒", "缓存有效期必须为120秒"],
  ]) {
    assert.equal(assessKnowledgePair(claim(a), claim(b)).relation, "conflicting", `${a} / ${b}`);
  }
});

test("653/655: global contradiction remains withheld when its peer is outside the selected project view", async (t) => {
  const f = await fixture(t);
  const global = await f.write("GLOBAL", "Enable cache", { scope: "workspace", projectId: null });
  const stream = join(f.workspace, "crest", "events", f.devices[0]);
  await rename(stream, join(f.root, "delayed"));
  process.env.EINZBERN_HOME = f.homes[1];
  const local = await f.write("LOCAL", "Disable cache", { projectId: f.ids[1] });
  await rename(join(f.root, "delayed"), stream);
  let source;
  for (const [projectId, count] of [[undefined, 2], [f.ids[0], 1], [f.ids[1], 2]]) {
    const result = await listKnowledgeMetadata(f.workspace, { at, diagnostics: "ids", ...(projectId === undefined ? {} : { projectId }) });
    source ??= result.sourceVersion;
    assert.deepEqual(result.sourceVersion, source);
    assert.deepEqual([result.activeCount, result.eligibleCount, result.withheldCount, result.diagnostics.conflictPairCount], [count, 0, count, 1]);
    assert.deepEqual(result.unresolvedConflicts, [[global.id, local.id].sort()]);
    assert.ok(result.diagnosticPage.records.some(row => row.id === global.id));
    assert.deepEqual(result.records, []);
  }
});

test("655/656: 146 affected IDs have bounded summaries, same-snapshot counts and lossless diagnostic pages through CLI and Recall", async (t) => {
  const f = await fixture(t);
  const expectedIds = [];
  const expectedPairs = [];
  const positive = [];
  for (let n = 0; n < 73; n += 1) {
    positive.push(await f.write(`ENABLED-${n}`, `Enable channel-${n}`, { subject: `Channel-${n} policy`, projectId: f.ids[n % 2] }));
  }
  const streamA = join(f.workspace, "crest", "events", f.devices[0]);
  await rename(streamA, join(f.root, "held"));
  process.env.EINZBERN_HOME = f.homes[1];
  for (let n = 0; n < 73; n += 1) {
    const opposite = await f.write(`DISABLED-${n}`, `Disable channel-${n}`, { subject: `Channel-${n} policy`, projectId: f.ids[n % 2] });
    expectedIds.push(positive[n].id, opposite.id);
    expectedPairs.push([positive[n].id, opposite.id].sort());
  }
  await rename(join(f.root, "held"), streamA);
  expectedIds.sort();
  expectedPairs.sort(([a], [b]) => a.localeCompare(b));
  const list = (extra = {}) => listKnowledgeMetadata(f.workspace, { at, ...extra });
  const empty = await list({ search: "zzzzunmatched", limit: 1 });
  assert.equal(empty.total, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(empty), "utf8") < 4096);
  assert.deepEqual([empty.activeCount, empty.eligibleCount, empty.withheldCount, empty.ineligibleCount], [146, 0, 146, 0]);
  assert.equal(empty.diagnostics.affectedIdCount, 146);
  assert.equal(empty.diagnostics.conflictPairCount, 73);
  assert.equal(empty.diagnostics.truncated, true);
  assert.equal(empty.diagnostics.idExamples.length, 2);
  for (const selection of ["default", "all"]) {
    const scoped = await list({ selection, projectId: f.ids[0], limit: 1 });
    assert.deepEqual([scoped.activeCount, scoped.eligibleCount, scoped.withheldCount], [74, 0, 74]);
    assert.equal(scoped.effectiveScope.kind, "project");
    assert.deepEqual(scoped.sourceVersion, empty.sourceVersion, "query scope cannot alter physical source identity");
  }
  for (const mode of ["ids", "conflicts", "audit"]) {
    const rows = [];
    let snapshot;
    let offset = 0;
    for (;;) {
      const flags = ["knowledge-list", "--workspace", f.workspace, "--at", at, "--diagnostics", mode, "--diagnostic-limit", "19", "--diagnostic-offset", String(offset), "--limit", "1"];
      if (snapshot !== undefined) flags.push("--snapshot", snapshot);
      const { answer } = await f.cli(flags);
      snapshot ??= answer.snapshot;
      assert.equal(answer.snapshot, snapshot);
      rows.push(...answer.diagnosticPage.records);
      if (answer.diagnosticPage.nextOffset === null) break;
      offset = answer.diagnosticPage.nextOffset;
    }
    assert.deepEqual(mode === "conflicts" ? rows : rows.map((r) => r.id), mode === "conflicts" ? expectedPairs : expectedIds);
  }
  await assert.rejects(list({ diagnostics: "ids", diagnosticOffset: 1 }), { reasonCode: "KNOWLEDGE_INPUT_INVALID" });
  const pinned = await list({ diagnostics: "ids" });
  await assert.rejects(list({ diagnostics: "ids", snapshot: pinned.snapshot, projectId: f.ids[0] }), { reasonCode: "KNOWLEDGE_SNAPSHOT_CHANGED" });
  await assert.rejects(list({ diagnostics: "ids", snapshot: pinned.snapshot, at: "2026-11-14T06:00:00Z" }), { reasonCode: "KNOWLEDGE_SNAPSHOT_CHANGED" });
  const recalled = await readRecallCards(f.workspace, { at });
  assert.equal(recalled.projectCrestDegraded.withheldCards, 146);
  assert.equal(recalled.stores.project.evidence.diagnostics.conflictPairCount, 73);
  assert.equal(recalled.stores.project.evidence.withheldCount, 146);
  const { raw, answer } = await f.cli(["recall", "--workspace", f.workspace, "--at", at, "--query", "zzzzunmatched", "--project-id", f.ids[0]]);
  assert.equal(answer.knowledgeStores.project.withheldCount, 74);
  assert.ok(Buffer.byteLength(raw, "utf8") < 4096, `empty Recall is ${Buffer.byteLength(raw)} bytes`);
  await f.write("LARGE-METADATA", "λ".repeat(3000), { subject: "A legal metadata record" });
  await assert.rejects(list({ diagnostics: "ids", snapshot: pinned.snapshot, diagnosticOffset: 1 }), { reasonCode: "KNOWLEDGE_SNAPSHOT_CHANGED" });
  const large = await list({ search: "legal", limit: 1 });
  assert.equal(large.records[0].summary, "λ".repeat(3000));
  assert.ok(Buffer.byteLength(JSON.stringify(large.records[0]), "utf8") > 4411);
  const { records, ...overhead } = large;
  assert.ok(Buffer.byteLength(JSON.stringify(overhead), "utf8") < 4096);
  t.diagnostic(JSON.stringify({ affectedIds: expectedIds.length, pairs: expectedPairs.length, emptyListBytes: Buffer.byteLength(JSON.stringify(empty)), emptyRecallBytes: Buffer.byteLength(raw), legalMetadataBytes: Buffer.byteLength(JSON.stringify(records[0])), overheadBytes: Buffer.byteLength(JSON.stringify(overhead)) }));
});

test("655: empty library and user reads self-describe, and diagnostic arguments reject malformed windows", async (t) => {
  const f = await fixture(t);
  for (const scope of [undefined, "user"]) {
    const answer = await listKnowledgeMetadata(f.workspace, { at, ...(scope === undefined ? {} : { scope }) });
    assert.equal(answer.effectiveScope.kind, scope === "user" ? "user" : "library");
    assert.deepEqual([answer.activeCount, answer.eligibleCount, answer.withheldCount], [0, 0, 0]);
    assert.ok(Buffer.byteLength(JSON.stringify(answer)) < 4096);
  }
  for (const flags of [
    ["--diagnostics", "unknown"], ["--diagnostic-limit", "2"], ["--diagnostics", "ids", "--diagnostic-limit", "0"],
    ["--diagnostics", "conflicts", "--diagnostic-offset", "-1"], ["--snapshot", "bad"],
  ]) await assert.rejects(f.cli(["knowledge-list", "--workspace", f.workspace, "--at", at, ...flags]), { reasonCode: "KNOWLEDGE_INPUT_INVALID" });
  // Projection evidence must not add fields to the immutable metadata schema.
  const card = await f.write("LEGACY", "Retain audit logs");
  const listed = await listKnowledgeMetadata(f.workspace, { at, selection: "all" });
  assert.equal(listed.records.find((r) => r.id === card.id).schemaVersion, "tcrn.knowledge-unit-metadata.v1");
  assert.equal(Object.hasOwn(listed.records[0], "intrinsicScope"), false);
});

test("653/655: prompt Recall applies a registered project binding on an ordinary library, matching CLI and preserving global/user cards", async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, "checkout");
  await mkdir(directory);
  await registerLibrary({ projectPath: directory, projectId: f.ids[0], libraryPath: f.workspace, registeredAt: at, gitRemote: null });
  await setWorkspaceSetting(f.workspace, { occurredAt: at, key: "retrieval.tau", value: "0" });
  const local = await f.write("LOCAL", "Zebrafish maintenance for this project");
  const foreign = await f.write("FOREIGN", "Zebrafish maintenance for another project", { projectId: f.ids[1] });
  const global = await f.write("GLOBAL", "Zebrafish maintenance shared by all projects", { scope: "workspace", projectId: null });
  const user = await f.write("USER", "Zebrafish maintenance personal note", { scope: "user", projectId: null });
  const bound = await f.cli(["recall", "--workspace", f.workspace, "--at", at, "--query", "zebrafish", "--project-id", f.ids[0], "--tau", "0"]);
  assert.equal(bound.answer.knowledgeStores.project.effectiveScope.projectId, f.ids[0]);
  assert.equal(bound.answer.knowledgeStores.project.activeCount, 2);
  assert.equal(bound.answer.knowledgeStores.user.activeCount, 1);
  assert.deepEqual(bound.answer.records.filter((r) => r.kind === "card").map((r) => r.id).sort(), [local.id, global.id, user.id].sort());
  const outcome = await promptRecallOutcome({ libraryPath: f.workspace, cwd: directory, prompt: "zebrafish", host: "codex", at });
  assert.equal(outcome.reasonCode, "HOOK_RECALL_ANSWERED");
  const context = outcome.answer.lines.join("\n");
  for (const id of [local.id, global.id, user.id]) assert.ok(context.includes(id), `bound hook includes ${id}`);
  assert.ok(!context.includes(foreign.id), "the registered project binding excludes a foreign intrinsic project");
  const library = await f.cli(["recall", "--workspace", f.workspace, "--at", at, "--query", "zebrafish", "--tau", "0"]);
  assert.equal(library.answer.knowledgeStores.project.activeCount, 3);
  assert.ok(library.answer.records.some((r) => r.id === foreign.id), "the same card remains available in the library view");
});

test("656: two-store empty Recall bounds duplicate-version diagnostics without losing same-snapshot totals", async (t) => {
  const f = await fixture(t);
  const crest = join(f.root, "shared-user-crest");
  for (const home of f.homes) {
    process.env.EINZBERN_HOME = home;
    await applyMachineSettingSet({ key: "crest.userPath", value: crest, occurredAt: at });
  }
  process.env.EINZBERN_HOME = f.homes[0];
  const scopes = ["project", "user"];
  for (const scope of scopes) await f.write(`DUPLICATE-${scope}`, "Alpha measurement", { scope, projectId: scope === "user" ? null : f.ids[0], subject: "Synthetic measurement position near river" });
  for (const scope of scopes) await f.write(`PAIR-A-${scope}`, "Enable cache", { scope, projectId: scope === "user" ? null : f.ids[0] });
  const streams = [join(f.workspace, "crest", "events", f.devices[0]), join(crest, "events", f.devices[0])];
  for (const [i, stream] of streams.entries()) await rename(stream, join(f.root, `held-${i}`));
  process.env.EINZBERN_HOME = f.homes[1];
  for (const scope of scopes) await f.write(`DUPLICATE-${scope}`, "Beta measurement", { scope, projectId: scope === "user" ? null : f.ids[0], subject: "Synthetic measurement position near river" });
  for (const scope of scopes) await f.write(`PAIR-B-${scope}`, "Disable cache", { scope, projectId: scope === "user" ? null : f.ids[0] });
  for (const [i, stream] of streams.entries()) await rename(join(f.root, `held-${i}`), stream);
  const { raw, answer } = await f.cli(["recall", "--workspace", f.workspace, "--at", at, "--query", "zzzzunmatched"]);
  for (const scope of scopes) {
    const store = answer.knowledgeStores[scope];
    assert.deepEqual([store.activeCount, store.eligibleCount, store.withheldCount, store.diagnostics.duplicateIdCount], [4, 0, 4, 1]);
    assert.equal(store.diagnostics.affectedIdCount, 3);
    assert.equal(store.diagnostics.conflictPairCount, 1);
    assert.equal(store.diagnostics.idExamples.length, 2);
  }
  assert.ok(Buffer.byteLength(raw, "utf8") < 4096, `two-store empty Recall is ${Buffer.byteLength(raw)} bytes`);
  t.diagnostic(JSON.stringify({ twoStoreEmptyRecallBytes: Buffer.byteLength(raw) }));
});
