// SPDX-License-Identifier: Apache-2.0
// Read-only corpus audit. All derived output and device caches stay in this checkout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { listKnowledgeMetadata } from "../dist/build/packages/core/src/index.js";
import { assessKnowledgePair } from "../dist/build/packages/core/src/knowledge-conflict.js";
import { readRecallAuthority } from "../dist/build/packages/core/src/recall-authority.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: {
  workspace: { type: "string" }, baseline: { type: "string" }, out: { type: "string" }, at: { type: "string", default: "2026-11-13T06:00:00Z" },
} });
assert.ok(values.workspace && values.baseline && values.out, "--workspace, --baseline and --out are required");
const output = resolve(values.out);
assert.ok(relative(root, output) && !relative(root, output).startsWith(".."), "output must be inside this checkout");
process.env.EINZBERN_HOME = resolve(root, "dist/init093/audit-device");
await mkdir(dirname(output), { recursive: true });
const baselineBytes = await readFile(values.baseline);
const baseline = JSON.parse(baselineBytes);
const { authority } = await readRecallAuthority(values.workspace);
const query = { at: values.at, selection: "all", limit: Number.MAX_SAFE_INTEGER };
const read = (extra = {}) => listKnowledgeMetadata(values.workspace, { ...query, ...extra }, authority);
const pages = {};
async function collect(mode, extra = {}) {
  const records = [];
  let snapshot;
  let offset = 0;
  let calls = 0;
  for (;;) {
    const answer = await read({ ...extra, diagnostics: mode, diagnosticLimit: 128, diagnosticOffset: offset, ...(snapshot === undefined ? {} : { snapshot }) });
    snapshot ??= answer.snapshot;
    assert.equal(answer.snapshot, snapshot);
    records.push(...answer.diagnosticPage.records);
    calls += 1;
    if (answer.diagnosticPage.nextOffset === null) {
      assert.equal(records.length, answer.diagnosticPage.total);
      pages[`${extra.projectId ?? "library"}:${mode}`] = { snapshot, calls, rows: records.length };
      return { answer, records };
    }
    offset = answer.diagnosticPage.nextOffset;
  }
}
const audit = await collect("audit");
const ids = await collect("ids");
const conflicts = await collect("conflicts");
assert.equal(ids.answer.snapshot, audit.answer.snapshot);
assert.equal(conflicts.answer.snapshot, audit.answer.snapshot);
const metadata = audit.answer.records;
assert.equal(metadata.length, audit.records.length, "all legal metadata is retained alongside the paged audit");
const byId = new Map(metadata.map(record => [record.id, record]));
const before = new Map(baseline.records.map(record => [record.id, record]));
const oldPeers = new Map();
const newPeers = new Map();
const addPeers = (map, [left, right]) => {
  map.set(left, [...(map.get(left) ?? []), right]);
  map.set(right, [...(map.get(right) ?? []), left]);
};
for (const pair of baseline.unresolvedConflicts ?? []) addPeers(oldPeers, pair);
for (const pair of conflicts.records) addPeers(newPeers, pair);
const oldPairAudit = (baseline.unresolvedConflicts ?? []).map(pair => {
  assert.ok(pair.every(id => byId.has(id)), "the original affected IDs remain auditable");
  const assessment = assessKnowledgePair(byId.get(pair[0]), byId.get(pair[1]));
  return { ids: pair, relation: assessment.relation, reason: assessment.reason };
});
const cards = audit.records.map(row => {
  const record = byId.get(row.id);
  assert.equal(canonicalSha256(record), row.metadataDigest);
  const old = before.get(row.id);
  return { ...row, metadataBytes: Buffer.byteLength(canonicalJson(record)), legalMetadata: true,
    baselineMetadataDigest: old === undefined ? null : canonicalSha256(old),
    metadataUnchanged: old === undefined ? null : canonicalSha256(old) === row.metadataDigest,
    oldConflictPeers: (oldPeers.get(row.id) ?? []).sort(), newConflictPeers: (newPeers.get(row.id) ?? []).sort(),
    resolution: row.withheld ? row.reasons.join(",") : row.eligible ? oldPeers.has(row.id) ? "restored: scope/token/claim confirmation" : "eligible: no unacknowledged contradiction" : "ineligible: lifecycle/retrieval/freshness policy",
  };
});
const views = [];
const projects = [...new Set(cards.flatMap(card => card.intrinsicScope.kind === "project" ? card.intrinsicScope.projectIds : []))].sort();
for (const projectId of [undefined, ...projects]) {
  const scoped = await read({ selection: "default", limit: 1, search: "zzzz-init093-unmatched", ...(projectId === undefined ? {} : { projectId }) });
  const { records: _records, ...overhead } = scoped;
  assert.equal(scoped.activeCount, scoped.eligibleCount + scoped.withheldCount + scoped.ineligibleCount);
  assert.deepEqual(scoped.sourceVersion, audit.answer.sourceVersion);
  assert.ok(Buffer.byteLength(JSON.stringify(scoped)) < 4096);
  views.push({ ...overhead, bytes: Buffer.byteLength(JSON.stringify(scoped)) });
}
const nullCards = cards.filter(row => byId.get(row.id).projectId === null);
const report = {
  schemaVersion: "einzbern.init093-corpus-audit.v1", at: values.at,
  sourceVersion: audit.answer.sourceVersion, snapshot: audit.answer.snapshot, projectionVersion: audit.answer.projectionVersion,
  baseline: { sha256: createHash("sha256").update(baselineBytes).digest("hex"), records: baseline.records.length,
    resultDigest: baseline.resultDigest, affectedIds: oldPeers.size, conflictPairs: (baseline.unresolvedConflicts ?? []).length },
  counts: Object.fromEntries(["activeCount", "eligibleCount", "withheldCount", "ineligibleCount"].map(key => [key, audit.answer[key]])),
  nullProject: { total: nullCards.length, byKind: Object.fromEntries(["project", "workspace-global", "user", "unresolved-legacy"].map(kind => [kind, nullCards.filter(row => row.intrinsicScope.kind === kind).length])) },
  metadataUnchangedCount: cards.filter(row => row.metadataUnchanged).length,
  addedIds: cards.filter(row => row.metadataUnchanged === null).map(row => row.id), missingIds: [...before.keys()].filter(id => !byId.has(id)),
  restoredIds: cards.filter(row => row.oldConflictPeers.length > 0 && row.eligible).map(row => row.id),
  withheldIds: ids.records, conflictPairs: conflicts.records, pages, views, cards, oldPairAudit,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(output.replace(/\.json$/u, "-metadata.json"), `${JSON.stringify(audit.answer, null, 2)}\n`);
console.log(JSON.stringify({ output: relative(root, output), records: cards.length, ...report.counts, nullProject: report.nullProject,
  metadataUnchanged: report.metadataUnchangedCount, restoredIds: report.restoredIds.length, withheldIds: ids.records.length,
  conflictPairs: conflicts.records.length, largestEmptyBytes: Math.max(...views.map(view => view.bytes)) }));
