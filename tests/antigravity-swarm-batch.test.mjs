// SPDX-License-Identifier: Apache-2.0
// Deterministic Antigravity swarm batch receipt & guard staging fixtures.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  normalizeAntigravitySwarmBatch,
  recordAntigravitySwarmBatch,
  stageAntigravitySwarmGuardFromBatch,
} from "../dist/build/packages/core/src/antigravity-swarm-batch.js";
import { prepareHostNativeDispatch } from "../dist/build/packages/core/src/dispatch-workflow.js";
import { runGates } from "../dist/build/packages/core/src/gates-run.js";
import { applyEngineModelPolicySet, engineModelPolicyOnboarding } from "../dist/build/packages/core/src/engine-model-policy.js";
import { nativeFixture } from "./helpers/host-native-fixture.mjs";
import { fileSymlinksAvailable } from "./helpers/filesystem-fixture.mjs";
import { hasPrivateWindowsPermissions } from "../scripts/lib/windows-system.mjs";

const cli = fileURLToPath(new URL("../scripts/einzbern.mjs", import.meta.url));
const at = "2026-11-12T00:00:00Z";
const selection = { kind: "explicit", tuple: { runner: "antigravity", model: "gemini-4-carbon-medium", effort: "medium" } };
const economySelection = { kind: "explicit", tuple: { runner: "antigravity", model: "gemini-4-argon-medium", effort: "medium" } };

async function swarmFixture(t) {
  const f = await nativeFixture(t);
  const draft = engineModelPolicyOnboarding("antigravity");
  const policy = await applyEngineModelPolicySet({
    home: f.home,
    host: "antigravity",
    actor: "agent:fixture",
    occurredAt: at,
    authorization: { target: "models.engine-policy", decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: f.state.metadata.workspaceId },
    policy: {
      ...draft,
      tiers: draft.tiers.map(row =>
        row.category === "main"
          ? { ...row, ...selection.tuple }
          : row.category === "economy"
            ? { ...row, ...economySelection.tuple }
            : row
      ),
    },
  });

  const authorRequest = {
    ...f.request,
    category: "main",
    authorization: {
      ...f.request.authorization,
      hosts: ["antigravity"],
    },
    capabilities: {
      ...f.request.capabilities,
      hostKind: "antigravity",
      toolName: "swarm",
      combinations: [selection.tuple, economySelection.tuple],
    },
  };
  const monitorRequest = {
    ...authorRequest,
    category: "economy",
    action: "coordination",
  };

  const authorPrep = await prepareHostNativeDispatch(f.state, authorRequest, { selection, argumentsValue: { action: "add", name: "author-1" } }, f.home);
  const monitorPrep = await prepareHostNativeDispatch(f.state, monitorRequest, { selection: economySelection, argumentsValue: { action: "add", name: "monitor" } }, f.home);
  assert.ok(authorPrep.attempt && monitorPrep.attempt);

  const coordinatorRoot = join(f.root, "coord-repo");
  const workerWorktree = join(f.root, "worktrees", "author-1");
  const manifest = {
    schemaVersion: "tcrn.antigravity-swarm-manifest.v1",
    host: "antigravity",
    batchId: "batch-092",
    attemptId: "attempt-092-1",
    workId: f.work.id,
    workRevision: f.work.revision,
    policyDigest: policy.hosts.antigravity.digest,
    coordinator: { conversationId: "coord-conv-1", workspaceRoot: coordinatorRoot },
    members: [
      {
        name: "author-1",
        role: "author",
        category: "main",
        workspace: "inherit",
        preparationAttemptId: authorPrep.attempt.id,
        workId: f.work.id,
        workRevision: f.work.revision,
        conversationId: "author-conv-1",
        workspacePath: workerWorktree,
      },
      {
        name: "monitor",
        role: "monitor",
        category: "economy",
        workspace: "inherit",
        preparationAttemptId: monitorPrep.attempt.id,
        workId: f.work.id,
        workRevision: f.work.revision,
        conversationId: "monitor-conv-1",
        workspacePath: null,
      },
    ],
  };

  return {
    ...f,
    policy,
    authorRequest,
    authorPrep,
    monitorPrep,
    manifest,
    workRevisions: [{ id: f.work.id, revision: f.work.revision }],
  };
}

test("execution-antigravity-swarm-record and evidence roundtrip stages guard and keeps actual.* unknown", async t => {
  const f = await swarmFixture(t);
  const manifestPath = join(f.root, "manifest.json");
  const prepsPath = join(f.root, "preps.json");
  const obsPath = join(f.root, "obs.json");
  const outDir = await mkdtemp(join(tmpdir(), "einzbern-swarm-out-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const outPath = join(outDir, "receipt.json");
  const outPath2 = join(outDir, "receipt-2.json");
  const gate = await runGates({
    projectRoot: f.root, release: true, base: null, workIds: [f.work.id], changed: null, roots: ["."],
    declarationsDigest: "fixture", evidenceOnly: true, gates: [{
      name: "fixture-check", root: ".", command: [process.execPath, "-e", "process.stdout.write('ok')"],
      required: true, releaseOnly: false, reason: "release", matched: [], matchedWorkIds: [f.work.id],
    }],
  }, { libraryId: f.state.metadata.workspaceId, at: new Date().toISOString(), deviceHome: f.home });

  await writeFile(manifestPath, JSON.stringify(f.manifest));
  await writeFile(prepsPath, JSON.stringify([f.authorPrep, f.monitorPrep]));
  await writeFile(obsPath, JSON.stringify({
    statusSnapshots: [{
      observedAt: new Date().toISOString(),
      members: [
        { name: "author-1", state: "killed" },
        { name: "monitor", state: "waiting" },
      ],
    }],
    modelSwitches: [{
      at: new Date().toISOString(),
      name: "author-1",
      reason: "quota-exhausted",
      preparationAttemptId: f.authorPrep.attempt.id,
      fromRequestedModel: "gemini-4-carbon-medium",
      toRequestedModel: "gemini-4-argon-medium",
    }],
    boardDeliverables: [{ seq: 12, author: "author-1", summary: "Landed batch", commitSha: "abc1234", gateRunIds: [gate.run.runId] }],
    landings: [{
      name: "author-1",
      disposition: "merged",
      coordinatorHead: "def5678",
      workerHead: "abc1234",
      workerClean: true,
      verifiedAt: new Date().toISOString(),
    }],
  }));

  const invoke = args => JSON.parse(execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, EINZBERN_HOME: f.home },
    timeout: 30_000,
  }));

  const receipt = invoke([
    "execution-antigravity-swarm-record",
    "--workspace", f.workspace,
    "--manifest", manifestPath,
    "--preparations", prepsPath,
    "--observations", obsPath,
    "--output", outPath,
  ]);
  assert.equal(receipt.schemaVersion, "tcrn.antigravity-swarm-batch.v1");
  assert.equal(receipt.actual.model.status, "unknown");
  assert.equal(receipt.actual.effort.status, "unknown");
  assert.equal(receipt.actual.usage.status, "unknown");
  assert.deepEqual(receipt.observations.boardDeliverables[0].gateRunIds, [gate.run.runId]);

  // Read-only evidence replay is idempotent.
  const replayed = invoke(["execution-antigravity-swarm-evidence", "--from-file", outPath]);
  assert.deepEqual(replayed, receipt);

  // Staged guard state exists with 0600 permissions and exact schema.
  const guardHash = createHash("sha256").update(f.manifest.coordinator.conversationId).digest("hex");
  const guardPath = join(f.home, "cache", "antigravity-swarm-guards", `${guardHash}.json`);
  const guardStat = await lstat(guardPath);
  if (process.platform === "win32") assert.ok(hasPrivateWindowsPermissions(guardPath, true));
  else assert.equal(guardStat.mode & 0o777, 0o600);
  const guard = JSON.parse(await readFile(guardPath, "utf8"));
  assert.equal(guard.schemaVersion, "einzbern.antigravity-swarm-guard.v1");
  assert.equal(guard.members.find(m => m.name === "author-1").landed, true);
  assert.equal(guard.members.find(m => m.name === "author-1").killed, true);

  // Monotonic --prior update succeeds.
  const receipt2 = invoke([
    "execution-antigravity-swarm-record",
    "--workspace", f.workspace,
    "--manifest", manifestPath,
    "--preparations", prepsPath,
    "--observations", obsPath,
    "--prior", outPath,
    "--output", outPath2,
  ]);
  assert.equal(receipt2.schemaVersion, "tcrn.antigravity-swarm-batch.v1");
});

test("negative cases: forged actual.*, out-of-bounds output, unlanded killed worker, unbound prep, and role/name rules", async t => {
  const f = await swarmFixture(t);
  const outDir = await mkdtemp(join(tmpdir(), "einzbern-swarm-out-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const manifestPath = join(f.root, "manifest.json");
  const prepsPath = join(f.root, "preps.json");
  const forgedObsPath = join(f.root, "forged-obs.json");
  const unlandedObsPath = join(f.root, "unlanded-obs.json");
  const abandonedObsPath = join(f.root, "abandoned-obs.json");

  await writeFile(manifestPath, JSON.stringify(f.manifest));
  await writeFile(prepsPath, JSON.stringify([f.authorPrep, f.monitorPrep]));
  await writeFile(forgedObsPath, JSON.stringify({ actual: { model: "gemini-4-carbon-medium" } }));
  await writeFile(unlandedObsPath, JSON.stringify({
    statusSnapshots: [{ observedAt: new Date().toISOString(), members: [{ name: "author-1", state: "killed" }] }],
  }));
  await writeFile(abandonedObsPath, JSON.stringify({
    statusSnapshots: [{ observedAt: new Date().toISOString(), members: [{ name: "author-1", state: "killed" }] }],
    landings: [{ name: "author-1", disposition: "abandoned", decidedIn: "minutes:abc123#D2", verifiedAt: new Date().toISOString() }],
  }));

  // 1. Forged actual.* rejected and retained as ANTIGRAVITY_SWARM_RECORD_INVALID.
  const forgedOut = join(outDir, "forged-out.json");
  const forgedRun = spawnSync(process.execPath, [
    cli, "execution-antigravity-swarm-record",
    "--workspace", f.workspace, "--manifest", manifestPath, "--preparations", prepsPath, "--observations", forgedObsPath, "--output", forgedOut,
  ], { encoding: "utf8", env: { ...process.env, EINZBERN_HOME: f.home }, timeout: 30_000 });
  assert.equal(forgedRun.status, 1);
  assert.equal(JSON.parse(forgedRun.stderr).reasonCode, "ANTIGRAVITY_SWARM_RECORD_INVALID");
  assert.equal(JSON.parse(await readFile(forgedOut, "utf8")).reasonCode, "ANTIGRAVITY_SWARM_RECORD_INVALID");

  // 2. Out-of-bounds --output inside workspace library rejected.
  const oobRun = spawnSync(process.execPath, [
    cli, "execution-antigravity-swarm-record",
    "--workspace", f.workspace, "--manifest", manifestPath, "--preparations", prepsPath, "--observations", abandonedObsPath, "--output", join(f.workspace, "leak.json"),
  ], { encoding: "utf8", env: { ...process.env, EINZBERN_HOME: f.home }, timeout: 30_000 });
  assert.equal(oobRun.status, 1);

  // 3. Unlanded killed isolated-workspace worker rejected.
  const unlandedOut = join(outDir, "unlanded-out.json");
  const unlandedRun = spawnSync(process.execPath, [
    cli, "execution-antigravity-swarm-record",
    "--workspace", f.workspace, "--manifest", manifestPath, "--preparations", prepsPath, "--observations", unlandedObsPath, "--output", unlandedOut,
  ], { encoding: "utf8", env: { ...process.env, EINZBERN_HOME: f.home }, timeout: 30_000 });
  assert.equal(unlandedRun.status, 1);
  assert.equal(JSON.parse(unlandedRun.stderr).reasonCode, "ANTIGRAVITY_SWARM_RECORD_INVALID");

  // 4. Abandoned killed isolated-workspace worker with minutes:<id>#D<n> succeeds.
  const abandonedOut = join(outDir, "abandoned-out.json");
  const abandonedRun = spawnSync(process.execPath, [
    cli, "execution-antigravity-swarm-record",
    "--workspace", f.workspace, "--manifest", manifestPath, "--preparations", prepsPath, "--observations", abandonedObsPath, "--output", abandonedOut,
  ], { encoding: "utf8", env: { ...process.env, EINZBERN_HOME: f.home }, timeout: 30_000 });
  assert.equal(abandonedRun.status, 0, abandonedRun.stderr);

  // 5. Core validation rejections: unbound prep, narrator without auth, monitor non-economy, verifier non-inherit, reserved name, backward cutoff, symlink guard.
  const cutoff = new Date().toISOString();
  assert.throws(() => recordAntigravitySwarmBatch({
    observationCutoff: cutoff, manifest: f.manifest, preparations: [f.authorPrep], observations: {}, policy: f.policy, workRevisions: f.workRevisions,
  }), /missing preparation/u);

  const narratorManifest = {
    ...f.manifest,
    members: [{ ...f.manifest.members[1], name: "narrator", role: "narrator", category: "economy" }],
  };
  assert.throws(() => recordAntigravitySwarmBatch({
    observationCutoff: cutoff, manifest: narratorManifest, preparations: [f.monitorPrep], observations: {}, policy: f.policy, workRevisions: f.workRevisions,
  }), /narratorAuthorizedBy/u);

  const badMonitorManifest = {
    ...f.manifest,
    members: [{ ...f.manifest.members[0], name: "monitor", role: "monitor", workspacePath: null }],
  };
  assert.throws(() => recordAntigravitySwarmBatch({
    observationCutoff: cutoff, manifest: badMonitorManifest, preparations: [f.authorPrep], observations: {}, policy: f.policy, workRevisions: f.workRevisions,
  }), /economy/u);

  const badVerifierManifest = {
    ...f.manifest,
    members: [{ ...f.manifest.members[1], name: "verifier", role: "verifier", workspace: "share" }],
  };
  assert.throws(() => recordAntigravitySwarmBatch({
    observationCutoff: cutoff, manifest: badVerifierManifest, preparations: [f.monitorPrep], observations: {}, policy: f.policy, workRevisions: f.workRevisions,
  }), /inherit/u);

  const reservedNameManifest = {
    ...f.manifest,
    members: [{ ...f.manifest.members[1], name: "coordinator" }],
  };
  assert.throws(() => recordAntigravitySwarmBatch({
    observationCutoff: cutoff, manifest: reservedNameManifest, preparations: [f.monitorPrep], observations: {}, policy: f.policy, workRevisions: f.workRevisions,
  }), /reserved/u);

  const validReceipt = recordAntigravitySwarmBatch({
    observationCutoff: cutoff, manifest: f.manifest, preparations: [f.authorPrep, f.monitorPrep], observations: {}, policy: f.policy, workRevisions: f.workRevisions,
  });
  assert.deepEqual(normalizeAntigravitySwarmBatch(validReceipt), validReceipt);

  assert.throws(() => recordAntigravitySwarmBatch({
    observationCutoff: "2020-01-01T00:00:00Z", manifest: f.manifest, preparations: [f.authorPrep, f.monitorPrep], observations: {}, policy: f.policy, workRevisions: f.workRevisions, prior: validReceipt,
  }), /backwards/u);

  const guardDir = join(f.home, "cache", "antigravity-swarm-guards");
  await mkdir(guardDir, { recursive: true });
  const guardHash = createHash("sha256").update(f.manifest.coordinator.conversationId).digest("hex");
  const guardFile = join(guardDir, `${guardHash}.json`);
  await rm(guardFile, { force: true });
  if (await fileSymlinksAvailable(f.root)) await symlink(join(f.root, "target.json"), guardFile, "file");
  else await symlink(f.root, guardFile, "junction");
  await assert.rejects(() => stageAntigravitySwarmGuardFromBatch(validReceipt, f.home, f.state.metadata.workspaceId), /symlink/u);
});

test("modelSwitches preparation binding, groupSize numbered instances, and symlinked cache dir", async t => {
  const f = await swarmFixture(t);
  const cutoff = new Date(Date.now() + 60_000).toISOString();
  const switchPrep = await prepareHostNativeDispatch(
    f.state,
    f.authorRequest,
    { selection, argumentsValue: { action: "model", name: "author-1" } },
    f.home,
  );

  // (a) Unbound modelSwitch.preparationAttemptId is rejected.
  assert.throws(() => recordAntigravitySwarmBatch({
    observationCutoff: cutoff,
    manifest: f.manifest,
    preparations: [f.authorPrep, f.monitorPrep],
    observations: {
      modelSwitches: [{
        at: new Date().toISOString(),
        name: "author-1",
        reason: "quota-exhausted",
        preparationAttemptId: "unbound-prep-id",
        fromRequestedModel: "gemini-4-carbon-medium",
        toRequestedModel: "gemini-4-argon-medium",
      }],
    },
    policy: f.policy,
    workRevisions: f.workRevisions,
  }), /unbound modelSwitch preparationAttemptId/u);

  // Valid switchPreparations + bound modelSwitch succeeds.
  const switchReceipt = recordAntigravitySwarmBatch({
    observationCutoff: cutoff,
    manifest: f.manifest,
    preparations: [f.authorPrep, f.monitorPrep],
    observations: {
      switchPreparations: [switchPrep],
      modelSwitches: [{
        at: new Date().toISOString(),
        name: "author-1",
        reason: "quota-exhausted",
        preparationAttemptId: switchPrep.attempt.id,
        fromRequestedModel: "gemini-4-carbon-medium",
        toRequestedModel: "gemini-4-argon-medium",
      }],
    },
    policy: f.policy,
    workRevisions: f.workRevisions,
  });
  assert.equal(switchReceipt.observations.modelSwitches?.length, 1);

  // (b) groupSize > 1 numbered instances (worker-1, worker-2): unlanded killed rejected, landed killed accepted.
  const groupManifest = {
    ...f.manifest,
    members: [
      { ...f.manifest.members[0], name: "worker", groupSize: 2 },
      f.manifest.members[1],
    ],
  };
  assert.throws(() => recordAntigravitySwarmBatch({
    observationCutoff: cutoff,
    manifest: groupManifest,
    preparations: [f.authorPrep, f.monitorPrep],
    observations: {
      statusSnapshots: [{
        observedAt: new Date().toISOString(),
        members: [
          { name: "worker-1", state: "killed" },
          { name: "worker-2", state: "waiting" },
        ],
      }],
    },
    policy: f.policy,
    workRevisions: f.workRevisions,
  }), /worker-1.*killed without a verified merge landing/u);

  const partialGroupReceipt = recordAntigravitySwarmBatch({
    observationCutoff: cutoff,
    manifest: groupManifest,
    preparations: [f.authorPrep, f.monitorPrep],
    observations: {
      statusSnapshots: [{
        observedAt: new Date().toISOString(),
        members: [
          { name: "worker-1", state: "killed" },
          { name: "worker-2", state: "waiting" },
        ],
      }],
      landings: [{
        name: "worker-1",
        disposition: "merged",
        coordinatorHead: "abc123",
        workerHead: "def456",
        workerClean: true,
        verifiedAt: new Date().toISOString(),
      }],
    },
    policy: f.policy,
    workRevisions: f.workRevisions,
  });
  const partialGuardPath = await stageAntigravitySwarmGuardFromBatch(
    partialGroupReceipt,
    f.home,
    f.state.metadata.workspaceId,
  );
  const partialGuard = JSON.parse(await readFile(partialGuardPath, "utf8"));
  assert.equal(partialGuard.members[0].name, "worker");
  assert.equal(partialGuard.members[0].groupSize, 2);
  assert.equal(partialGuard.members[0].landed, false);
  assert.equal(partialGuard.members[0].killed, false);

  const landedGroupReceipt = recordAntigravitySwarmBatch({
    observationCutoff: cutoff,
    manifest: groupManifest,
    preparations: [f.authorPrep, f.monitorPrep],
    observations: {
      statusSnapshots: [{
        observedAt: new Date().toISOString(),
        members: [
          { name: "worker-1", state: "killed" },
          { name: "worker-2", state: "killed" },
        ],
      }],
      landings: [
        {
          name: "worker-1",
          disposition: "merged",
          coordinatorHead: "abc123",
          workerHead: "def456",
          workerClean: true,
          verifiedAt: new Date().toISOString(),
        },
        {
          name: "worker-2",
          disposition: "merged",
          coordinatorHead: "abc123",
          workerHead: "ghi789",
          workerClean: true,
          verifiedAt: new Date().toISOString(),
        },
      ],
    },
    policy: f.policy,
    workRevisions: f.workRevisions,
  });
  const groupGuardPath = await stageAntigravitySwarmGuardFromBatch(
    landedGroupReceipt,
    f.home,
    f.state.metadata.workspaceId,
  );
  const groupGuard = JSON.parse(await readFile(groupGuardPath, "utf8"));
  assert.equal(groupGuard.members[0].name, "worker");
  assert.equal(groupGuard.members[0].groupSize, 2);
  assert.equal(groupGuard.members[0].landed, true);
  assert.equal(groupGuard.members[0].killed, true);

  // (c) Symlinked deviceHome/cache is refused before mkdir.
  const symlinkHome = await mkdtemp(join(tmpdir(), "einzbern-swarm-symhome-"));
  t.after(() => rm(symlinkHome, { recursive: true, force: true }));
  const targetDir = await mkdtemp(join(tmpdir(), "einzbern-swarm-symtarget-"));
  t.after(() => rm(targetDir, { recursive: true, force: true }));
  await symlink(targetDir, join(symlinkHome, "cache"), "junction");
  await assert.rejects(
    () => stageAntigravitySwarmGuardFromBatch(landedGroupReceipt, symlinkHome, f.state.metadata.workspaceId),
    /symlink/u,
  );

  // (d) Relocated storage-location.json v2 with symlinked <deviceHome>/cache -> <runtime>/cache succeeds via runtimeHome().
  const relocatedRoot = await mkdtemp(join(tmpdir(), "einzbern-swarm-reloc-"));
  t.after(() => rm(relocatedRoot, { recursive: true, force: true }));
  const relocatedHome = join(relocatedRoot, "home");
  const relocatedRuntime = join(relocatedRoot, "runtime");
  const relocatedLibrary = join(relocatedRoot, "library");
  await mkdir(relocatedHome, { recursive: true });
  await mkdir(join(relocatedRuntime, "cache"), { recursive: true });
  await mkdir(relocatedLibrary, { recursive: true });
  await writeFile(join(relocatedHome, "storage-location.json"), JSON.stringify({
    schemaVersion: "einzbern.storage-location.v2",
    library: relocatedLibrary,
    runtime: relocatedRuntime,
  }));
  await symlink(join(relocatedRuntime, "cache"), join(relocatedHome, "cache"), "junction");
  const relocatedGuardPath = await stageAntigravitySwarmGuardFromBatch(
    landedGroupReceipt,
    relocatedHome,
    f.state.metadata.workspaceId,
  );
  assert.ok(relocatedGuardPath.startsWith(join(relocatedRuntime, "cache", "antigravity-swarm-guards")));
  const relocatedGuard = JSON.parse(await readFile(relocatedGuardPath, "utf8"));
  assert.equal(relocatedGuard.schemaVersion, "einzbern.antigravity-swarm-guard.v1");
});
