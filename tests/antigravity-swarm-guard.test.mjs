// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileSymlinksAvailable } from "./helpers/filesystem-fixture.mjs";
import { hasPrivateWindowsPermissions } from "../scripts/lib/windows-system.mjs";

import {
  ANTIGRAVITY_SWARM_GUARD_VERSION,
  antigravitySwarmGuardPath,
  antigravitySwarmPreToolObservation,
  memberHasIsolatedWorkspace,
  parseAntigravitySwarmModels,
  readAntigravitySwarmGuardStatesSync,
  resolveAntigravitySwarmSwitchDecision,
  stageAntigravitySwarmGuardState,
  verifyAntigravitySwarmWorkspaceLanding,
} from "../dist/build/packages/core/src/antigravity-swarm.js";
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import { runHookEvent } from "../scripts/einzbern-hook.mjs";

const originalHost = process.env.EINZBERN_HOST;
const originalDeviceHome = process.env.EINZBERN_HOME;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-agy-swarm-")));
  t.after(async () => {
    if (originalHost === undefined) delete process.env.EINZBERN_HOST;
    else process.env.EINZBERN_HOST = originalHost;
    if (originalDeviceHome === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = originalDeviceHome;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    deviceHome: join(root, "device"),
  };
}

function buildTestPolicy() {
  const config = {
    categories: [
      { id: "flagship", name: "Flagship", description: "", order: 10 },
      { id: "main", name: "Main", description: "", order: 20 },
      { id: "economy", name: "Economy", description: "", order: 30 },
    ],
    tiers: [
      { order: 10, category: "main", runner: "antigravity", model: "gemini-4-carbon-medium", effort: "medium", note: "" },
      { order: 20, category: "economy", runner: "antigravity", model: "gemini-4-argon-medium", effort: "medium", note: "" },
      { order: 30, category: "economy", runner: "antigravity", model: "gemini-4-hydrogen-high", effort: "high", note: "" },
      { order: 40, category: "economy", runner: "antigravity", model: "gemini-4-hydrogen-medium", effort: "medium", note: "" },
    ],
    escalation: {
      enabled: true,
      threshold: 2,
      ceiling: "main",
    },
  };
  return {
    schemaVersion: "tcrn.engine-model-policy.v1",
    revision: 1,
    hosts: {
      antigravity: {
        ...config,
        revision: 1,
        digest: canonicalSha256({ host: "antigravity", ...config }),
        updatedAt: "2026-11-12T00:00:00Z",
        actor: "agent:antigravity",
        decidedIn: "minutes:342992f777c9f0217a0293e6#D1",
        decidedInLibraryId: "workspace:7732a51de4c38afb83bb77cf",
      },
    },
  };
}

function git(cwd, args) {
  const res = spawnSync("git", ["-C", cwd, ...args], { shell: false, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return (res.stdout ?? "").trim();
}

function initRepo(dir) {
  const init = spawnSync("git", ["init", dir], { shell: false, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  git(dir, ["config", "user.email", "swarm-guard-test-at-example.invalid"]);
  git(dir, ["config", "user.name", "Test User"]);
}

test("INIT092-SUB710-1: parseAntigravitySwarmModels maps effort suffixes and 0% quota with/without AI credits", () => {
  const observedAt = "2026-11-12T22:00:00Z";
  const parsed = parseAntigravitySwarmModels(
    {
      models: [
        "gemini-4-hydrogen-low",
        "gemini-4-hydrogen-medium",
        "gemini-4-hydrogen-high",
        "claude-opus-xhigh",
        "claude-opus-max",
        "custom-default-model",
      ],
      quotas: {
        "gemini-4-hydrogen-low": { quota_remaining: "0%", quota_resets: "2026-11-13T00:00:00Z", quota_note: "" },
        "gemini-4-hydrogen-medium": { quota_remaining: "0%", quota_note: "Covered by AI credits overage" },
        "gemini-4-hydrogen-high": { quota_remaining: "45%" },
        "claude-opus-xhigh": { quota_remaining: "unavailable" },
      },
      display_names: {
        "gemini-4-hydrogen-medium": "Gemini 4 Hydrogen Medium",
      },
    },
    { observedAt },
  );

  assert.deepEqual(
    parsed.combinations.map((c) => [c.runner, c.model, c.effort]),
    [
      ["antigravity", "gemini-4-hydrogen-low", "low"],
      ["antigravity", "gemini-4-hydrogen-medium", "medium"],
      ["antigravity", "gemini-4-hydrogen-high", "high"],
      ["antigravity", "claude-opus-xhigh", "xhigh"],
      ["antigravity", "claude-opus-max", "max"],
      ["antigravity", "custom-default-model", "default"],
    ],
  );
  assert.deepEqual(
    parsed.parsedModels.map((m) => [m.id, m.support, m.aiCreditsFallback]),
    [
      ["gemini-4-hydrogen-low", "unsupported", false],
      ["gemini-4-hydrogen-medium", "supported", true],
      ["gemini-4-hydrogen-high", "supported", false],
      ["claude-opus-xhigh", "unknown", false],
      ["claude-opus-max", "unknown", false],
      ["custom-default-model", "unknown", false],
    ],
  );
  assert.equal(parsed.parsedModels[1].displayName, "Gemini 4 Hydrogen Medium");
  assert.equal(parsed.selectionObservations[0].observedAt, observedAt);
  assert.deepEqual(
    parsed.supportedCombinations.map((c) => c.model),
    [
      "gemini-4-hydrogen-medium",
      "gemini-4-hydrogen-high",
      "claude-opus-xhigh",
      "claude-opus-max",
      "custom-default-model",
    ],
  );
});

test("INIT092-SUB710-2: resolveAntigravitySwarmSwitchDecision keeps quota/capacity exhaustion orthogonal to quality escalation", () => {
  const policy = buildTestPolicy();

  // Quota exhaustion at rejections=0 keeps nextRejections=0 and switches in-place to next supported tier (30).
  const remaining = [
    { runner: "antigravity", model: "gemini-4-hydrogen-high", effort: "high" },
    { runner: "antigravity", model: "gemini-4-argon-medium", effort: "medium" },
    { runner: "antigravity", model: "gemini-4-carbon-medium", effort: "medium" },
  ];
  const quotaSwitch = resolveAntigravitySwarmSwitchDecision({
    reason: "quota-exhausted",
    currentRejections: 0,
    category: "economy",
    policy,
    availableCombinations: remaining,
  });
  assert.equal(quotaSwitch.swarmAction, "model");
  assert.equal(quotaSwitch.status, "selected");
  assert.equal(quotaSwitch.nextRejections, 0);
  assert.equal(quotaSwitch.selected?.order, 30);

  // Capacity exhaustion at rejections=1 keeps nextRejections=1 and picks next supported tier.
  const capacitySwitch = resolveAntigravitySwarmSwitchDecision({
    reason: "capacity-exhausted",
    currentRejections: 1,
    category: "economy",
    policy,
    availableCombinations: [
      { runner: "antigravity", model: "gemini-4-argon-medium", effort: "medium" },
      { runner: "antigravity", model: "gemini-4-carbon-medium", effort: "medium" },
    ],
  });
  assert.equal(capacitySwitch.swarmAction, "model");
  assert.equal(capacitySwitch.nextRejections, 1);
  assert.equal(capacitySwitch.selected?.order, 20);

  // Quality rejection increments rejections and escalates along 40 -> 30 -> 20 -> 10 with threshold=2.
  const q1 = resolveAntigravitySwarmSwitchDecision({ reason: "quality-rejected", currentRejections: 0, category: "economy", policy });
  assert.equal(q1.nextRejections, 1);
  assert.equal(q1.selected?.order, 40);

  const q2 = resolveAntigravitySwarmSwitchDecision({ reason: "quality-rejected", currentRejections: 1, category: "economy", policy });
  assert.equal(q2.nextRejections, 2);
  assert.equal(q2.selected?.order, 30);

  const q4 = resolveAntigravitySwarmSwitchDecision({ reason: "quality-rejected", currentRejections: 3, category: "economy", policy });
  assert.equal(q4.nextRejections, 4);
  assert.equal(q4.selected?.order, 20);

  const q6 = resolveAntigravitySwarmSwitchDecision({ reason: "quality-rejected", currentRejections: 5, category: "economy", policy });
  assert.equal(q6.nextRejections, 6);
  assert.equal(q6.selected?.order, 10);
  assert.equal(q6.atCeiling, true);

  // (a) capacity-exhausted with order=40 still in availableCombinations switches to order=30, and chained currentModel switches 30 -> 20.
  const allCombos = [
    { runner: "antigravity", model: "gemini-4-hydrogen-medium", effort: "medium" },
    { runner: "antigravity", model: "gemini-4-hydrogen-high", effort: "high" },
    { runner: "antigravity", model: "gemini-4-argon-medium", effort: "medium" },
    { runner: "antigravity", model: "gemini-4-carbon-medium", effort: "medium" },
  ];
  const capFrom40 = resolveAntigravitySwarmSwitchDecision({
    reason: "capacity-exhausted",
    currentRejections: 0,
    category: "economy",
    policy,
    availableCombinations: allCombos,
  });
  assert.equal(capFrom40.status, "selected");
  assert.equal(capFrom40.nextRejections, 0);
  assert.equal(capFrom40.selected?.order, 30);

  const chainedFrom30 = resolveAntigravitySwarmSwitchDecision({
    reason: "capacity-exhausted",
    currentRejections: 0,
    category: "economy",
    policy,
    availableCombinations: allCombos,
    currentModel: "gemini-4-hydrogen-high",
  });
  assert.equal(chainedFrom30.status, "selected");
  assert.equal(chainedFrom30.nextRejections, 0);
  assert.equal(chainedFrom30.selected?.order, 20);

  // (b) quota-exhausted at currentRejections=2 (currentOrder=30) with order=40 still in availableCombinations picks order=20 (no regression to 40).
  const noRegress = resolveAntigravitySwarmSwitchDecision({
    reason: "quota-exhausted",
    currentRejections: 2,
    category: "economy",
    policy,
    availableCombinations: [
      { runner: "antigravity", model: "gemini-4-hydrogen-medium", effort: "medium" },
      { runner: "antigravity", model: "gemini-4-argon-medium", effort: "medium" },
      { runner: "antigravity", model: "gemini-4-carbon-medium", effort: "medium" },
    ],
  });
  assert.equal(noRegress.status, "selected");
  assert.equal(noRegress.nextRejections, 2);
  assert.equal(noRegress.selected?.order, 20);

  // (c) quality-rejected (0 -> 1) with order=40 absent selects order=30; with all economy absent returns exhausted + selected: null.
  const qFallback = resolveAntigravitySwarmSwitchDecision({
    reason: "quality-rejected",
    currentRejections: 0,
    category: "economy",
    policy,
    availableCombinations: remaining,
  });
  assert.equal(qFallback.status, "selected");
  assert.equal(qFallback.nextRejections, 1);
  assert.equal(qFallback.selected?.order, 30);

  const qExhausted = resolveAntigravitySwarmSwitchDecision({
    reason: "quality-rejected",
    currentRejections: 0,
    category: "economy",
    policy,
    availableCombinations: [{ runner: "antigravity", model: "gemini-4-carbon-medium", effort: "medium" }],
  });
  assert.equal(qExhausted.status, "exhausted");
  assert.equal(qExhausted.nextRejections, 1);
  assert.equal(qExhausted.selected, null);
});

test("INIT092-SUB710-3: guard state staging enforces 0700/0600 permissions, exact sha256 path, and symlink refusal", async (t) => {
  const f = await fixture(t);
  const coordId = "coord-conv-123";
  const expectedPath = join(
    f.deviceHome,
    "cache",
    "antigravity-swarm-guards",
    `${createHash("sha256").update(coordId).digest("hex")}.json`,
  );
  assert.equal(antigravitySwarmGuardPath(f.deviceHome, coordId), expectedPath);

  const state = {
    schemaVersion: ANTIGRAVITY_SWARM_GUARD_VERSION,
    updatedAt: "2026-11-12T22:00:00Z",
    libraryId: "workspace:7732a51de4c38afb83bb77cf",
    workId: "work:d4809fe3461cfea910e7102e",
    workRevision: 1,
    manifestDigest: "a".repeat(64),
    coordinator: { conversationId: coordId, workspaceRoot: join(f.root, "repo") },
    members: [],
  };

  const writtenPath = await stageAntigravitySwarmGuardState(f.deviceHome, state);
  assert.equal(writtenPath, expectedPath);
  const guardDir = join(f.deviceHome, "cache", "antigravity-swarm-guards");
  if (process.platform === "win32") {
    assert.ok(hasPrivateWindowsPermissions(guardDir, true));
    assert.ok(hasPrivateWindowsPermissions(writtenPath, true));
  } else {
    assert.equal((await stat(guardDir)).mode & 0o777, 0o700);
    assert.equal((await stat(writtenPath)).mode & 0o777, 0o600);
  }
  assert.equal(readAntigravitySwarmGuardStatesSync(f.deviceHome).length, 1);

  // Symlink at target path is refused on write and skipped on read.
  const evil = join(f.root, "evil.json");
  await writeFile(evil, "{}");
  const symPath = antigravitySwarmGuardPath(f.deviceHome, "coord-symlink");
  if (await fileSymlinksAvailable(f.root)) await symlink(evil, symPath, "file");
  else await symlink(f.root, symPath, "junction");
  await assert.rejects(
    stageAntigravitySwarmGuardState(f.deviceHome, { ...state, coordinator: { ...state.coordinator, conversationId: "coord-symlink" } }),
    { reasonCode: "ANTIGRAVITY_SWARM_GUARD_SYMLINK" },
  );
  assert.equal(readAntigravitySwarmGuardStatesSync(f.deviceHome).length, 1);
});

test("INIT092-SUB710-4: landing verifier & PreToolUse guard cover share/branch, multi-repo worktree, abandoned decision, worker denial, and unbound allow", async (t) => {
  const f = await fixture(t);
  process.env.EINZBERN_HOST = "antigravity";
  process.env.EINZBERN_HOME = f.deviceHome;

  const mainRepo = join(f.root, "main-repo");
  const worktreeDir = join(f.root, "worker-wt");
  await mkdir(mainRepo, { recursive: true });
  initRepo(mainRepo);
  await writeFile(join(mainRepo, "base.txt"), "base\n");
  git(mainRepo, ["add", "base.txt"]);
  git(mainRepo, ["commit", "-m", "init"]);

  // Create isolated git worktree (simulating both share/branch and multi-repo inherit+worktree).
  git(mainRepo, ["worktree", "add", "-b", "feat/worker", worktreeDir]);
  await writeFile(join(worktreeDir, "worker.txt"), "wip\n");

  // Uncommitted dirty worktree -> not landed.
  const dirtyLanding = verifyAntigravitySwarmWorkspaceLanding({
    coordinatorWorkspaceRoot: mainRepo,
    workerWorkspacePath: worktreeDir,
  });
  assert.equal(dirtyLanding.landed, false);
  assert.equal(dirtyLanding.workerClean, false);

  // Commit in worktree (still unmerged into mainRepo HEAD) -> clean, but not ancestor.
  git(worktreeDir, ["add", "worker.txt"]);
  git(worktreeDir, ["commit", "-m", "worker commit"]);
  const unmergedLanding = verifyAntigravitySwarmWorkspaceLanding({
    coordinatorWorkspaceRoot: mainRepo,
    workerWorkspacePath: worktreeDir,
  });
  assert.equal(unmergedLanding.landed, false);
  assert.equal(unmergedLanding.workerClean, true);

  const coordConv = "conv-coord";
  const workerConv = "conv-worker-1";
  const umbrellaRoot = join(f.root, "umbrella");
  await mkdir(umbrellaRoot, { recursive: true });

  // Multi-repo case: member has workspace:"inherit" but workspacePath !== coordinator.workspaceRoot.
  const multiRepoMember = {
    name: "swarm-guard",
    groupSize: 2,
    role: "author",
    workspace: "inherit",
    conversationId: workerConv,
    workspacePath: worktreeDir,
    landed: false,
    abandonedByDecision: null,
    killed: false,
  };
  const guardState = {
    schemaVersion: ANTIGRAVITY_SWARM_GUARD_VERSION,
    updatedAt: "2026-11-12T22:00:00Z",
    libraryId: "workspace:7732a51de4c38afb83bb77cf",
    workId: "work:d4809fe3461cfea910e7102e",
    workRevision: 1,
    manifestDigest: "b".repeat(64),
    coordinator: { conversationId: coordConv, workspaceRoot: mainRepo },
    members: [multiRepoMember],
  };
  assert.equal(memberHasIsolatedWorkspace(multiRepoMember, guardState), true);
  await stageAntigravitySwarmGuardState(f.deviceHome, guardState);

  // Worker add/model/kill denied by conversationId AND by cwd inside isolated workspacePath.
  for (const action of ["add", "model", "kill"]) {
    const byConv = antigravitySwarmPreToolObservation(
      { conversationId: workerConv, toolCall: { name: "swarm", args: { action } } },
      mainRepo,
      f.deviceHome,
    );
    assert.equal(byConv.status, "denied");
    assert.equal(byConv.reasonCode, "HOOK_ANTIGRAVITY_SWARM_WORKER_MUTATION_DENIED");

    const byCwd = antigravitySwarmPreToolObservation(
      { conversationId: "unknown-worker-conv", toolCall: { name: "swarm", args: { action } } },
      worktreeDir,
      f.deviceHome,
    );
    assert.equal(byCwd.status, "denied");
    assert.equal(byCwd.reasonCode, "HOOK_ANTIGRAVITY_SWARM_WORKER_MUTATION_DENIED");
  }

  // Coordinator kill of unlanded numbered group (<base> and <base>-1) denied via runHookEvent too.
  for (const targetName of ["swarm-guard", "swarm-guard-1", undefined]) {
    const hookOut = JSON.parse(await runHookEvent({
      event: "PreToolUse",
      payload: {
        conversationId: coordConv,
        toolCall: { name: "swarm", args: targetName === undefined ? { action: "kill" } : { action: "kill", name: targetName } },
        workspacePaths: [mainRepo],
      },
      cwd: mainRepo,
    }));
    assert.equal(hookOut.decision, "deny");
    assert.match(hookOut.reason, /isolated workspace/u);
  }

  // Merge worker branch into mainRepo -> clean & ancestor -> kill allowed!
  git(mainRepo, ["merge", "--no-ff", "feat/worker", "-m", "merge worker"]);
  const mergedOut = JSON.parse(await runHookEvent({
    event: "PreToolUse",
    payload: {
      conversationId: coordConv,
      toolCall: { name: "swarm", args: { action: "kill", name: "swarm-guard-1" } },
      workspacePaths: [mainRepo],
    },
    cwd: mainRepo,
  }));
  assert.deepEqual(mergedOut, { decision: "allow" });

  // Owner abandonment decision also allows kill even when unmerged.
  const shareWorkerDir = join(f.root, "share-dirty");
  await mkdir(shareWorkerDir, { recursive: true });
  await stageAntigravitySwarmGuardState(f.deviceHome, {
    ...guardState,
    members: [
      {
        name: "share-author",
        role: "author",
        workspace: "share",
        conversationId: "conv-share",
        workspacePath: shareWorkerDir,
        landed: false,
        abandonedByDecision: null,
        killed: false,
      },
    ],
  });
  assert.equal(
    antigravitySwarmPreToolObservation(
      { conversationId: coordConv, toolCall: { name: "swarm", args: { action: "kill", name: "share-author" } } },
      mainRepo,
      f.deviceHome,
    ).reasonCode,
    "HOOK_ANTIGRAVITY_SWARM_UNLANDED_KILL_DENIED",
  );
  await stageAntigravitySwarmGuardState(f.deviceHome, {
    ...guardState,
    members: [
      {
        name: "share-author",
        role: "author",
        workspace: "share",
        conversationId: "conv-share",
        workspacePath: shareWorkerDir,
        landed: false,
        abandonedByDecision: "minutes:0e26d32818b3fdf3415ff122#D2",
        killed: false,
      },
    ],
  });
  const abandonedAllowed = antigravitySwarmPreToolObservation(
    { conversationId: coordConv, toolCall: { name: "swarm", args: { action: "kill", name: "share-author" } } },
    mainRepo,
    f.deviceHome,
  );
  assert.equal(abandonedAllowed.status, "allowed");
  assert.equal(abandonedAllowed.reasonCode, "HOOK_ANTIGRAVITY_SWARM_OBSERVED");

  // Unbound session is allowed.
  const unbound = antigravitySwarmPreToolObservation(
    { conversationId: "unbound-session", toolCall: { name: "swarm", args: { action: "kill", name: "any" } } },
    mainRepo,
    f.deviceHome,
  );
  assert.equal(unbound.status, "allowed");
  assert.equal(unbound.reasonCode, "HOOK_ANTIGRAVITY_SWARM_UNBOUND_OBSERVED");

  // Verify hook.ndjson recorded the swarm reason codes.
  const logLines = (await readFile(join(f.deviceHome, "log", "hook.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(logLines.some((entry) => entry.reasonCode === "HOOK_ANTIGRAVITY_SWARM_UNLANDED_KILL_DENIED"));
  assert.ok(logLines.some((entry) => entry.reasonCode === "HOOK_ANTIGRAVITY_SWARM_OBSERVED"));

  // (d) Symlinked cache/antigravity-swarm-guards directory fails closed on add/model/kill while allowing non-mutating status.
  const symlinkDevice = join(f.root, "symlink-device");
  const realTarget = join(f.root, "outside-guards");
  await mkdir(join(symlinkDevice, "cache"), { recursive: true });
  await mkdir(realTarget, { recursive: true });
  await symlink(realTarget, join(symlinkDevice, "cache", "antigravity-swarm-guards"), "junction");

  for (const action of ["add", "model"]) {
    const res = antigravitySwarmPreToolObservation(
      { conversationId: "any-conv", toolCall: { name: "swarm", args: { action } } },
      mainRepo,
      symlinkDevice,
    );
    assert.equal(res.status, "denied");
    assert.equal(res.reasonCode, "HOOK_ANTIGRAVITY_SWARM_WORKER_MUTATION_DENIED");
  }
  const killRes = antigravitySwarmPreToolObservation(
    { conversationId: "any-conv", toolCall: { name: "swarm", args: { action: "kill", name: "x" } } },
    mainRepo,
    symlinkDevice,
  );
  assert.equal(killRes.status, "denied");
  assert.equal(killRes.reasonCode, "HOOK_ANTIGRAVITY_SWARM_UNLANDED_KILL_DENIED");

  const statusRes = antigravitySwarmPreToolObservation(
    { conversationId: "any-conv", toolCall: { name: "swarm", args: { action: "status" } } },
    mainRepo,
    symlinkDevice,
  );
  assert.equal(statusRes.status, "allowed");
});

test("INIT092-SUB710-5: relocated storage-location.json with symlinked deviceHome/cache resolves to runtimeHome and succeeds", async (t) => {
  const f = await fixture(t);
  const relocatedDevice = join(f.root, "relocated-device");
  const runtimeDir = join(f.root, "relocated-runtime");
  const libraryDir = join(f.root, "relocated-library");
  await mkdir(relocatedDevice, { recursive: true });
  await mkdir(join(runtimeDir, "cache"), { recursive: true });
  await mkdir(libraryDir, { recursive: true });
  await symlink(join(runtimeDir, "cache"), join(relocatedDevice, "cache"), "junction");
  await writeFile(
    join(relocatedDevice, "storage-location.json"),
    `${JSON.stringify({
      schemaVersion: "einzbern.storage-location.v2",
      library: libraryDir,
      runtime: runtimeDir,
    })}\n`,
  );

  const coordId = "coord-relocated";
  const expectedPath = join(
    runtimeDir,
    "cache",
    "antigravity-swarm-guards",
    `${createHash("sha256").update(coordId).digest("hex")}.json`,
  );
  assert.equal(antigravitySwarmGuardPath(relocatedDevice, coordId), expectedPath);

  const state = {
    schemaVersion: ANTIGRAVITY_SWARM_GUARD_VERSION,
    updatedAt: "2026-11-12T23:15:00Z",
    libraryId: "workspace:7732a51de4c38afb83bb77cf",
    workId: "work:d4809fe3461cfea910e7102e",
    workRevision: 1,
    manifestDigest: "c".repeat(64),
    coordinator: { conversationId: coordId, workspaceRoot: join(f.root, "repo") },
    members: [
      {
        name: "relocated-worker",
        role: "author",
        workspace: "share",
        conversationId: "conv-relocated-worker",
        workspacePath: join(f.root, "wt"),
        landed: false,
        abandonedByDecision: null,
        killed: false,
      },
    ],
  };

  const staged = await stageAntigravitySwarmGuardState(relocatedDevice, state);
  assert.equal(staged, expectedPath);
  assert.equal(readAntigravitySwarmGuardStatesSync(relocatedDevice).length, 1);

  const workerDeny = antigravitySwarmPreToolObservation(
    { conversationId: "conv-relocated-worker", toolCall: { name: "swarm", args: { action: "add" } } },
    join(f.root, "repo"),
    relocatedDevice,
  );
  assert.equal(workerDeny.status, "denied");
  assert.equal(workerDeny.reasonCode, "HOOK_ANTIGRAVITY_SWARM_WORKER_MUTATION_DENIED");

  const killDeny = antigravitySwarmPreToolObservation(
    { conversationId: coordId, toolCall: { name: "swarm", args: { action: "kill", name: "relocated-worker" } } },
    join(f.root, "repo"),
    relocatedDevice,
  );
  assert.equal(killDeny.status, "denied");
  assert.equal(killDeny.reasonCode, "HOOK_ANTIGRAVITY_SWARM_UNLANDED_KILL_DENIED");
});
