// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";

// INIT-093 extends the old {reasonCode, cards} envelope with bounded snapshot evidence.
export function assertRecallStore(store, cards, kind = "library") {
  assert.deepEqual(Object.keys(store).sort(), [
    "reasonCode", "cards", "effectiveScope", "sourceVersion", "projectionVersion", "snapshot",
    "activeCount", "eligibleCount", "withheldCount", "ineligibleCount", "diagnostics",
  ].sort());
  assert.equal(store.reasonCode, "KNOWLEDGE_LIST_READY");
  assert.equal(store.cards, cards);
  assert.equal(store.eligibleCount, cards);
  assert.equal(store.effectiveScope.kind, kind);
  assert.equal(store.activeCount, store.eligibleCount + store.withheldCount + store.ineligibleCount);
  assert.equal(store.projectionVersion, "intrinsic-scope-conflict-v2");
  assert.match(store.snapshot, /^[a-f0-9]{64}$/u);
  assert.match(store.sourceVersion.crestDigest, /^[a-f0-9]{64}$/u);
  assert.ok(store.diagnostics.idExamples.length <= 2);
  assert.ok(store.diagnostics.conflictExamples.length <= 2);
  assert.ok(Buffer.byteLength(JSON.stringify(store), "utf8") < 4096);
}
