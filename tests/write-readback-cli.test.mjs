// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { cli, instant, workspaceFixture } from "./helpers/workspace-fixture.mjs";
import { materializeWorkspaceFromGenesis, readBackWorkspaceWrite } from "../dist/build/packages/core/src/index.js";
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

async function checkReceipt(root, receipt) {
  const state = await materializeWorkspaceFromGenesis(root);
  assert.deepEqual([receipt.ok, receipt.localCommitted, receipt.verifiedReadback, receipt.remoteVerification], [true, true, true, "unverified"]);
  assert.equal(receipt.readback.headEventHash, state.headEventHash);
  assert.equal(receipt.readback.version, state.version);
  assert.deepEqual(receipt.readback.records.map((record) => record.id), receipt.ids);
  for (const observed of receipt.readback.records) {
    const actual = [...state.work, ...state.minutes].find((record) => record.id === observed.id);
    assert.equal(observed.recordDigest, canonicalSha256(actual));
    assert.equal(observed.revision, actual.revision);
    assert.equal(observed.status, actual.status ?? null);
  }
  return state;
}

test("665: local work and minutes receipts read committed business records and retain the remote boundary", async (context) => {
  const fixture = await workspaceFixture(context, { externalKey: "WRITE-READBACK" });
  const common = ["--workspace", fixture.workspace];
  const created = await cli(["work-create", ...common, "--at", instant(2), "--project-id", fixture.projectId,
    "--external-key", "WRITE-READBACK-INIT", "--kind", "Initiative", "--title", "Read back writes"]);
  await checkReceipt(fixture.workspace, created);
  const id = created.record.id;
  const annotated = await cli(["work-annotate", ...common, "--at", instant(3), "--id", id, "--summary", "Verified business fields"]);
  await checkReceipt(fixture.workspace, annotated);
  const transitioned = await cli(["work-transition", ...common, "--at", instant(4), "--id", id, "--status", "ready"]);
  await checkReceipt(fixture.workspace, transitioned);
  const file = join(fixture.base, "batch.json");
  await writeFile(file, JSON.stringify({ schemaVersion: "tcrn.work-batch.v1", members: [
    { verb: "work-transition", id, status: "active" },
    { verb: "work-annotate", id, summary: "The final batch revision is read back" },
  ] }));
  const batched = await cli(["work-batch", ...common, "--at", instant(5), "--from-file", file]);
  await checkReceipt(fixture.workspace, batched);
  const recorded = await cli(["minutes-record", ...common, "--at", instant(6), "--project-id", fixture.projectId,
    "--external-key", "WRITE-READBACK-MIN-001", "--title", "Write readback", "--summary", "Record the decision", "--decisions", "Read each committed business record"]);
  await checkReceipt(fixture.workspace, recorded);
});

test("665: changed business fields and unavailable source remain committed with an unverified receipt", async (context) => {
  const fixture = await workspaceFixture(context, { externalKey: "WRITE-READBACK-FAILURE" });
  const created = await cli(["work-create", "--workspace", fixture.workspace, "--at", instant(2), "--project-id", fixture.projectId,
    "--external-key", "WRITE-READBACK-FAILURE-INIT", "--kind", "Initiative", "--title", "Actual committed title"]);
  const state = await materializeWorkspaceFromGenesis(fixture.workspace);
  const mismatched = { ...state, work: state.work.map((record) => ({ ...record, title: "Incorrect expected title" })) };
  const mismatch = await readBackWorkspaceWrite(fixture.workspace, mismatched, created.ids);
  assert.deepEqual([mismatch.localCommitted, mismatch.verifiedReadback, mismatch.ok], [true, false, false]);
  assert.equal(mismatch.reasonCode, "WORKSPACE_WRITE_READBACK_UNVERIFIED");
  assert.match(mismatch.remedy, /before retrying/u);
  const moved = `${fixture.workspace}-temporarily-moved`;
  await rename(fixture.workspace, moved);
  try {
    const unavailable = await readBackWorkspaceWrite(fixture.workspace, state, created.ids);
    assert.deepEqual([unavailable.localCommitted, unavailable.verifiedReadback, unavailable.ok], [true, false, false]);
    assert.equal(unavailable.reasonCode, "WORKSPACE_WRITE_READBACK_UNVERIFIED");
  } finally {
    await rename(moved, fixture.workspace);
  }
  assert.equal((await materializeWorkspaceFromGenesis(fixture.workspace)).version, state.version);
});
