// R03: append historical decision metadata without rewriting source minutes; batch interruption is resumable.
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProject,
  initializeLibrary,
  minutesById,
  recordMinutes,
  recoverWorkspace,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import {
  applyMinutesSupplementBatch,
  minutesSupplementInventory,
} from "../dist/build/packages/core/src/minutes-supplement.js";

const at = (second = 0) => `2026-11-25T12:00:${String(second).padStart(2, "0")}Z`;

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-minute-supplement-")));
  const root = join(base, "library");
  await initializeLibrary({ root, createdAt: at(0) });
  const state = await createProject(root, { occurredAt: at(1), externalKey: "R03-PROJECT", name: "R03 fixture" });
  const projectId = state.projects[0].id;
  const first = await recordMinutes(root, {
    occurredAt: at(2), projectId, externalKey: "R03-MIN-001", title: "Old decision record",
    summary: "Keep source text unchanged.", decisions: ["Preserve source text.", "Append metadata separately."],
    decidedBy: [], linkedWorkIds: [],
  });
  const second = await recordMinutes(root, {
    occurredAt: at(3), projectId, externalKey: "R03-MIN-002", title: "Another old decision record",
    summary: "Resume a partially applied migration.", decisions: ["Record coverage."],
    decidedBy: [], linkedWorkIds: [],
  });
  return { base, root, firstId: first.minutes[0].id, secondId: second.minutes[0].id };
}

const metadata = (title, ...tags) => [{ title, tags }];
const batch = (members) => ({ schemaVersion: "tcrn.minutes-supplement-batch.v1", members });

async function refused(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return { reasonCode: error?.reasonCode, payload: JSON.parse(error.message) };
  }
}

test("R03: a supplement is append-only, inventory-bounded, and safely resumes after an interrupted batch", async (context) => {
  const library = await fixture();
  context.after(() => rm(library.base, { recursive: true, force: true }));

  const before = await validateWorkspace(library.root);
  const original = before.minutes.find((entry) => entry.id === library.firstId);
  const inventory = await minutesSupplementInventory(library.root);
  assert.equal(inventory.coverage.needsSupplement, 2);
  const firstCandidate = inventory.records.find((entry) => entry.minutesId === library.firstId);
  const secondCandidate = inventory.records.find((entry) => entry.minutesId === library.secondId);
  assert.equal(firstCandidate.status, "needs-supplement");
  assert.deepEqual(firstCandidate.decisions.map((entry) => entry.text), original.decisions);

  const interrupted = await refused(() => applyMinutesSupplementBatch(library.root, batch([
    { minutesId: library.firstId, contentDigest: firstCandidate.contentDigest, decisionMetadata: [
      { title: "Source text stays fixed", tags: ["history", "source-preservation"] },
      { title: "Append metadata", tags: ["metadata", "migration"] },
    ] },
    { minutesId: library.secondId, contentDigest: "a".repeat(64), decisionMetadata: metadata("Record coverage", "audit") },
  ]), { occurredAt: at(4) }));
  assert.equal(interrupted.reasonCode, "WORK_BATCH_REFUSED");
  assert.equal(interrupted.payload.stage, "apply");
  assert.equal(interrupted.payload.applied.length, 1);
  assert.equal(interrupted.payload.failed.index, 1);
  assert.equal(interrupted.payload.failed.reasonCode, "WORKSPACE_INPUT_INVALID");

  let state = await validateWorkspace(library.root);
  assert.equal(state.minutesSupplements.length, 1);
  assert.equal(state.version, before.version + 1, "one complete supplement committed before the failure");
  assert.deepEqual(state.minutes.find((entry) => entry.id === library.firstId), original, "the original record remains byte-for-byte unchanged");
  assert.deepEqual(minutesById(state, library.firstId).decisions, [
    { number: 1, text: "Preserve source text.", title: "Source text stays fixed", tags: ["history", "source-preservation"] },
    { number: 2, text: "Append metadata separately.", title: "Append metadata", tags: ["metadata", "migration"] },
  ]);

  const currentInventory = await minutesSupplementInventory(library.root);
  assert.equal(currentInventory.coverage.needsSupplement, 1);
  assert.equal(currentInventory.coverage.supplemented, 1);
  assert.equal(currentInventory.coverage.ownerAuditPending, 1);
  assert.equal(currentInventory.records.find((entry) => entry.minutesId === library.firstId).status, "supplemented-pending-owner-audit");

  const resumed = await applyMinutesSupplementBatch(library.root, batch([
    { minutesId: library.firstId, contentDigest: firstCandidate.contentDigest, decisionMetadata: [
      { title: "Source text stays fixed", tags: ["history", "source-preservation"] },
      { title: "Append metadata", tags: ["metadata", "migration"] },
    ] },
    { minutesId: library.secondId, contentDigest: secondCandidate.contentDigest, decisionMetadata: metadata("Record coverage", "audit") },
  ]), { occurredAt: at(5) });
  assert.equal(resumed.appended, 1);
  assert.equal(resumed.alreadyApplied, 1);
  assert.equal(resumed.ownerAuditPending, 2);
  assert.equal(resumed.eligibleToSwitch, 0, "this row records readiness for Owner review without switching retrieval");
  assert.equal(resumed.version, state.version + 1);

  const repeated = await applyMinutesSupplementBatch(library.root, batch([
    { minutesId: library.firstId, contentDigest: firstCandidate.contentDigest, decisionMetadata: [
      { title: "Source text stays fixed", tags: ["history", "source-preservation"] },
      { title: "Append metadata", tags: ["metadata", "migration"] },
    ] },
    { minutesId: library.secondId, contentDigest: secondCandidate.contentDigest, decisionMetadata: metadata("Record coverage", "audit") },
  ]), { occurredAt: at(6) });
  assert.equal(repeated.appended, 0);
  assert.equal(repeated.alreadyApplied, 2);
  assert.equal(repeated.version, resumed.version, "repeating the batch adds no duplicate supplement events");

  const recovered = await recoverWorkspace(library.root);
  assert.equal(recovered.minutesSupplements.length, 2);
  assert.deepEqual(await validateWorkspace(library.root), recovered, "the cached snapshot and genesis replay retain supplements");
});

test("R03: supplement batches reject malformed members before committing any source record", async (context) => {
  const library = await fixture();
  context.after(() => rm(library.base, { recursive: true, force: true }));
  const before = await validateWorkspace(library.root);
  const inventory = await minutesSupplementInventory(library.root);
  const candidate = inventory.records.find((entry) => entry.minutesId === library.firstId);
  const refusal = await refused(() => applyMinutesSupplementBatch(library.root, batch([
    { minutesId: library.firstId, contentDigest: candidate.contentDigest, decisionMetadata: [{ title: "No tags", tags: [] }] },
  ]), { occurredAt: at(4) }));
  assert.equal(refusal.reasonCode, "WORK_BATCH_REFUSED");
  assert.equal(refusal.payload.stage, "shape");
  assert.equal((await validateWorkspace(library.root)).version, before.version);
  assert.equal((await validateWorkspace(library.root)).minutesSupplements.length, 0);
});

test("R03: a project-scoped batch rejects any member from another project before its first write", async (context) => {
  const library = await fixture();
  context.after(() => rm(library.base, { recursive: true, force: true }));
  const workspace = await validateWorkspace(library.root);
  const otherProject = await createProject(library.root, { occurredAt: at(4), externalKey: "R03-OTHER-PROJECT", name: "Other fixture" });
  const foreign = await recordMinutes(library.root, {
    occurredAt: at(5), projectId: otherProject.projects.find((entry) => entry.externalKey === "R03-OTHER-PROJECT").id,
    externalKey: "R03-FOREIGN-MIN", title: "Other project minutes", summary: "Scope must hold.",
    decisions: ["Remain outside the selected project."], decidedBy: [], linkedWorkIds: [],
  });
  const foreignId = foreign.minutes.find((entry) => entry.externalKey === "R03-FOREIGN-MIN").id;
  const inventory = await minutesSupplementInventory(library.root);
  const candidate = inventory.records.find((entry) => entry.minutesId === foreignId);
  const before = await validateWorkspace(library.root);
  const refusal = await refused(() => applyMinutesSupplementBatch(library.root, batch([
    { minutesId: foreignId, contentDigest: candidate.contentDigest, decisionMetadata: metadata("Wrong scope", "migration") },
  ]), { occurredAt: at(6), projectId: workspace.projects[0].id }));
  assert.equal(refusal.reasonCode, "WORK_BATCH_REFUSED");
  assert.equal(refusal.payload.stage, "scope");
  assert.equal((await validateWorkspace(library.root)).version, before.version);
  assert.equal((await validateWorkspace(library.root)).minutesSupplements.length, 0);
});
