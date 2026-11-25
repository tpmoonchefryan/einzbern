// SPDX-License-Identifier: Apache-2.0
// Candidate fixtures only; no native host call is made here.
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runNativeToolCommand } from "../dist/build/packages/cli/src/native-tool-commands.js";
import { prepareHostNativeDispatch } from "../dist/build/packages/core/src/dispatch-workflow.js";
import { recordHostNativeEvents } from "../dist/build/packages/core/src/native-tool-evidence.js";
import { recordMinutes } from "../dist/build/packages/core/src/workspace.js";
import { applyEngineModelPolicySet, engineModelPolicyOnboarding } from "../dist/build/packages/core/src/engine-model-policy.js";
import { recordCodexPeerBatch, normalizeCodexPeerBatch } from "../dist/build/packages/core/src/codex-peer-batch.js";
import { packDispatchRequired, resolvePackDispatchContext, validatePackDispatchContext } from "../dist/build/packages/core/src/pack-dispatch.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { nativeFixture, selection, codexGuardFixture } from "./helpers/host-native-fixture.mjs";

const candidatePackInput = JSON.parse(await readFile(new URL("./fixtures/pack-init108-candidate.json", import.meta.url), "utf8"));

const content = (kind, workId) => {
  const requirement = { workId, requirementId: "R01", version: 1 };
  const details = kind === "Initiative" ? { boundary: "Fixture boundary", approvalBasis: "Fixture approval", allocationPlan: "One test row" }
    : kind === "Pack" ? { batchContract: "Frozen test assignment" }
      : kind === "Subtask" ? { assignedRequirements: "R01@1", deliverables: "Fixture deliverable", dependencies: "Recorded fixture inputs", verificationOwner: "Fixture verifier" }
      : { behavior: "Fixture behavior", discretion: "No additional discretion" };
  return {
    schemaVersion: "tcrn.work-content.v1", kind, variant: "standard", goal: `Fixture ${kind}`,
    sources: [{ id: "test-request", kind: "user-request", locator: `fixture:${workId}`, version: "1", extraction: "complete", text: "Synthetic test input only" }],
    scope: "Isolated candidate fixture", constraints: [],
    requirements: [{ id: "R01", version: 1, text: "Verify Pack assignment binding", sourceIds: ["test-request"], shared: false, disposition: kind === "Initiative" ? "deferred" : "required" }],
    allocations: [],
    acceptance: [{ id: "AC01", version: 1, requirement, scenario: "Consume the selected Pack row", expected: "The same Pack and assignment are retained", method: "Candidate CLI preparation and receipt validation" }],
    evidence: [], body: "Synthetic fixture only", details,
  };
};

function withPack(f) {
  const plan = structuredClone(candidatePackInput.plan);
  const workRows = candidatePackInput.works.map(row => {
    const isInitiative = row.id === plan.initiative.id;
    return {
      ...f.work, ...row, projectId: f.work.projectId, scopeDigest: null, tombstone: false,
      title: row.externalKey,
      extensions: isInitiative ? f.work.extensions : { "advisory:work-content": { required: true, value: content(row.kind, row.id) } },
    };
  });
  const initiative = workRows.find(row => row.id === plan.initiative.id);
  assert.ok(initiative, "candidate Pack input must name its frozen Initiative revision");
  const assignment = plan.assignments[0];
  const packId = deriveStableId("work", candidatePackInput.fixtureIdentity);
  const packRecord = {
    ...initiative, id: packId, externalKey: "TCRN-CROSS-PACK-CANDIDATE-FIXTURE", kind: "Pack", revision: 1,
    parentId: null, status: "planned", title: "Pack candidate fixture", scopeDigest: null,
    extensions: { "advisory:work-content": { required: true, value: { ...content("Pack", packId), packPlan: plan } } },
  };
  const candidateIds = new Set([...candidatePackInput.works.map(row => row.id), packId]);
  const work = f.state.work.filter(row => !candidateIds.has(row.id));
  return { state: { ...f.state, work: [...work, ...workRows, packRecord] }, initiative, packRecord, assignment, assignments: plan.assignments,
    binding: { packId, packRevision: 1, assignmentId: assignment.id, ...candidatePackInput.dispatch } };
}

test("general host preparation retains the live Pack row and frozen native capacity", async t => {
  const f = await nativeFixture(t);
  const pack = withPack(f);
  const minutesKey = "DISPATCH-MIN-601";
  const recorded = await recordMinutes(f.workspace, {
    occurredAt: "2026-11-25T10:00:00Z", projectId: pack.initiative.projectId, externalKey: minutesKey, title: "Fixture relay",
    summary: "Checkpoint review", decisions: ["An original decision passage to read separately."],
    decisionMetadata: [{ title: "Checkpoint restart", tags: ["replay"] }], decidedBy: [], linkedWorkIds: [],
  });
  const reference = `${recorded.minutes[0].id}#D1`;
  const requestWork = { ...pack.initiative, extensions: { ...pack.initiative.extensions,
    "advisory:goal": { required: false, value: `Follow ${minutesKey}` },
  } };
  const state = { ...pack.state, minutes: recorded.minutes, headEventHash: recorded.headEventHash,
    work: pack.state.work.map(row => row.id === requestWork.id ? requestWork : row) };
  const context = { home: f.home, resolveWorkspace: async () => ({ root: f.workspace, state }) };
  const request = { ...f.request, workId: requestWork.id, workRevision: requestWork.revision, action: "implementation", phase: "dispatch", packBinding: pack.binding,
    authorization: { ...f.request.authorization, workIds: [requestWork.id] },
    sourceScope: { repository: "fixture:repository", writableRoots: [f.root], permission: "granted" },
    capabilities: { ...f.request.capabilities, toolName: "collaboration.spawn_agent" } };
  const requestPath = join(f.root, "pack-request.json");
  const argumentsPath = join(f.root, "pack-arguments.json");
  const output = join(f.root, "pack-preparation.json");
  await writeFile(requestPath, JSON.stringify(request));
  await writeFile(argumentsPath, JSON.stringify({ selection, argumentsValue: { prompt: "Synthetic Pack preparation fixture" } }));
  const result = await runNativeToolCommand("execution-host-prepare", { workspace: f.workspace, request: requestPath, arguments: argumentsPath, output }, context);
  assert.ok(["HOST_PREPARATION_READY", "HOST_PREPARATION_NOT_EXECUTABLE"].includes(result.reasonCode));
  const prepared = JSON.parse(await readFile(output, "utf8"));
  const binding = validatePackDispatchContext(prepared.context.packDispatch);
  assert.equal(binding.pack.id, pack.packRecord.id);
  assert.equal(binding.assignment.id, pack.assignment.id);
  assert.deepEqual(binding.batch.assignmentIds, [pack.assignments[0].id, pack.assignments[1].id]);
  assert.deepEqual(binding.batch.capacity, { limit: 2, active: 0 });
  assert.equal(binding.batch.plannedConcurrency, 2);
  assert.deepEqual(binding.batch.remainingAssignments.map(row => row.id), [pack.assignments[2].id], "one of three planned rows remains for the next batch when only two slots are available");
  assert.deepEqual(binding.assignment.sourceWorks.filter(work => work.kind === "Subtask").map(work => work.id), [
    "work:8e8d67728916dfdd6492308d", "work:359cd763ffc00b103f5dd634", "work:cb679ad937f9f152564a6dfd",
  ], "the three real CLI work identities share one sequential assignment row");
  assert.deepEqual(pack.assignments[1].sourceWorks.filter(work => work.kind === "Subtask").map(work => work.id), ["work:ac69221954f370ee1353f465"], "Linux evidence stays in its own row");
  assert.equal(pack.assignments[1].criteria[0].acceptanceId, "AC01");
  assert.equal(pack.assignments[1].criteria[0].requirementId, "R01");
  assert.equal(pack.assignments[2].verification.trigger, "after-results-recorded");
  assert.deepEqual(pack.assignments[2].verification.afterAssignmentIds, [pack.assignments[1].id]);
  assert.deepEqual(pack.assignments[2].verification.verifiers.map(work => work.id), ["work:8b4954093364ae1d5a03cd5a"]);
  assert.ok(prepared.attempt, JSON.stringify(prepared.decision.reasons));
  assert.equal(prepared.decision.request.packBinding.assignmentId, pack.assignment.id);
  assert.match(prepared.attempt.argumentsValue.prompt, new RegExp(pack.assignment.id, "u"));
  assert.match(prepared.attempt.argumentsValue.prompt, new RegExp(pack.packRecord.externalKey, "u"));
  assert.deepEqual(prepared.context.recallCandidates, { workspaceId: recorded.metadata.workspaceId, references: [reference] });
  assert.ok(prepared.attempt.argumentsValue.prompt.includes(`minutes · ${minutesKey} · Checkpoint restart · ${reference}`));
  assert.ok(prepared.attempt.argumentsValue.prompt.includes("You may continue without reading any."));
  assert.ok(!prepared.attempt.argumentsValue.prompt.includes(recorded.minutes[0].decisions[0]));

  const nativeArguments = { task_name: "sub793-r05-native-message", message: "Synthetic Pack preparation fixture", fork_turns: "none" };
  const nativeArgumentsPath = join(f.root, "pack-native-arguments.json");
  const nativeOutput = join(f.root, "pack-native-preparation.json");
  await writeFile(nativeArgumentsPath, JSON.stringify({ selection, argumentsValue: nativeArguments }));
  const nativeResult = await runNativeToolCommand("execution-host-prepare", { workspace: f.workspace, request: requestPath, arguments: nativeArgumentsPath, output: nativeOutput }, context);
  assert.ok(["HOST_PREPARATION_READY", "HOST_PREPARATION_NOT_EXECUTABLE"].includes(nativeResult.reasonCode));
  const nativePrepared = JSON.parse(await readFile(nativeOutput, "utf8"));
  assert.ok(nativePrepared.attempt, JSON.stringify(nativePrepared.decision.reasons));
  const { message: boundMessage, task_name: boundTaskName, ...otherNativeArguments } = nativePrepared.attempt.argumentsValue;
  assert.equal(boundMessage, prepared.attempt.argumentsValue.prompt, "the native message receives the same Pack delegation as the generic prompt path");
  assert.match(boundTaskName, /^sub793_r05_native_message_[a-f0-9]{12}$/u);
  assert.deepEqual(otherNativeArguments, {
    fork_turns: nativeArguments.fork_turns,
    model: prepared.attempt.argumentsValue.model,
    reasoning_effort: prepared.attempt.argumentsValue.reasoning_effort,
  }, "fork_turns and selection fields stay unchanged");
  assert.equal(nativePrepared.context.packDispatch.digest, prepared.context.packDispatch.digest);
  assert.match(nativePrepared.attempt.argumentsValue.message, new RegExp(pack.assignment.id, "u"));
  assert.match(nativePrepared.attempt.argumentsValue.message, new RegExp(pack.packRecord.externalKey, "u"));

  const completedState = { ...pack.state, work: pack.state.work.map(row => row.id === pack.initiative.id ? { ...row, status: "done" } : row) };
  const gatedContext = { ...context, resolveWorkspace: async () => ({ root: f.workspace, state: completedState }) };
  const missingPackRequestPath = join(f.root, "missing-pack-request.json");
  const missingPackOutput = join(f.root, "missing-pack-preparation.json");
  await writeFile(missingPackRequestPath, JSON.stringify({ ...request, packBinding: undefined }));
  await assert.rejects(runNativeToolCommand("execution-host-prepare", { workspace: f.workspace, request: missingPackRequestPath, arguments: argumentsPath, output: missingPackOutput }, gatedContext), /requires a live Pack assignment/u);
  await assert.rejects(readFile(missingPackOutput), { code: "ENOENT" }, "no preparation or native attempt is written without a Pack row after activation");
});

test("Pack dispatch rejects stale revisions, unknown capacity, over-capacity rosters and absent post-INIT assignments", async t => {
  const f = await nativeFixture(t);
  const pack = withPack(f);
  const work = pack.initiative;
  const resolve = binding => resolvePackDispatchContext(pack.state, binding, work.id, work.revision);
  assert.equal(resolve(pack.binding).assignment.id, pack.assignment.id);
  assert.throws(() => resolve({ ...pack.binding, packRevision: 2 }), /identity or revision is not current/u);
  assert.throws(() => resolve({ ...pack.binding, capacity: { limit: 2, active: null } }), /capacity is unknown/u);
  assert.throws(() => resolve({ ...pack.binding, capacity: { limit: 1, active: 1 } }), /exceeds current available capacity/u);
  assert.throws(() => resolve({ ...pack.binding, assignmentId: "missing-row" }), /assignment is not a member/u);
  assert.equal(packDispatchRequired(pack.state, "implementation", "dispatch"), false);
  const completed = { ...pack.state, work: pack.state.work.map(row => row.id === pack.initiative.id ? { ...row, status: "done" } : row) };
  assert.equal(packDispatchRequired(completed, "implementation", "dispatch"), true);
  assert.equal(packDispatchRequired(completed, "implementation", "work"), false, "already-started work keeps the preexisting continuation path");
});

test("invalid, unassigned and absent Pack dispatches stop before the native call boundary", async t => {
  const f = await nativeFixture(t);
  const pack = withPack(f);
  const request = { ...f.request, workId: pack.initiative.id, workRevision: pack.initiative.revision, action: "implementation", phase: "dispatch", packBinding: pack.binding,
    authorization: { ...f.request.authorization, workIds: [pack.initiative.id] },
    sourceScope: { repository: "fixture:repository", writableRoots: [f.root], permission: "granted" },
    capabilities: { ...f.request.capabilities, toolName: "collaboration.spawn_agent" } };
  const tool = { selection, argumentsValue: { task_name: "sub793-r05-native-message", message: "Synthetic invalid Pack fixture", fork_turns: "none" } };
  let nativeCalls = 0;
  const dispatch = async (state, requestValue) => {
    const preparation = await prepareHostNativeDispatch(state, requestValue, tool, f.home);
    if (preparation.attempt !== null) nativeCalls += 1;
    return preparation;
  };

  await assert.rejects(dispatch(pack.state, { ...request, packBinding: { ...pack.binding, packRevision: pack.binding.packRevision + 1 } }), /identity or revision is not current/u);
  assert.equal(nativeCalls, 0, "a stale Pack identity never reaches the native call boundary");

  await assert.rejects(dispatch(pack.state, { ...request, packBinding: { ...pack.binding, assignmentId: "missing-row" } }), /assignment is not a member/u);
  assert.equal(nativeCalls, 0, "an unassigned row never reaches the native call boundary");

  const completedState = { ...pack.state, work: pack.state.work.map(row => row.id === pack.initiative.id ? { ...row, status: "done" } : row) };
  await assert.rejects(dispatch(completedState, { ...request, packBinding: undefined }), /requires a live Pack assignment/u);
  assert.equal(nativeCalls, 0, "a post-INIT dispatch without a Pack never reaches the native call boundary");
});

test("Codex peer receipts retain Pack outcomes across coordinator handoff and new application attempts", async t => {
  const f = await nativeFixture(t);
  const pack = withPack(f);
  const plan = pack.packRecord.extensions["advisory:work-content"].value.packPlan;
  plan.maxConcurrency = 3;
  plan.assignments[2] = {
    ...plan.assignments[2],
    role: "implementation",
    parallelGroup: plan.assignments[0].parallelGroup,
    prerequisites: [],
    resultSources: [],
    verification: null,
  };
  const nextAssignment = plan.assignments[2];
  const nextWork = nextAssignment.sourceWorks.find(work => work.kind === "Subtask");
  assert.ok(nextWork, "the next assignment has its own Subtask scope");
  const ancestors = nextAssignment.sourceWorks.filter(work => work.kind === "Story" || work.kind === "Epic");
  // The stored fixture captured a completed verifier. Use a ready copy of its lineage
  // to exercise implementation admission for the Subtask in this recovery scenario.
  const nextState = { ...pack.state, work: pack.state.work.map(work => {
    const key = "advisory:work-content";
    const workDefinition = work.extensions[key];
    if (work.id === nextWork.id) {
      const ownCriterion = workDefinition.value.acceptance[0];
      const acceptance = [ownCriterion, ...ancestors.map(ancestor => ({
        ...ownCriterion, id: `AC-${ancestor.kind.toUpperCase()}`,
        requirement: { workId: ancestor.id, requirementId: "R01", version: 1 },
      }))];
      return { ...work, status: "active", extensions: { ...work.extensions, [key]: { ...workDefinition, value: { ...workDefinition.value, acceptance } } } };
    }
    if (!ancestors.some(ancestor => ancestor.id === work.id)) return work;
    const child = nextAssignment.sourceWorks.find(source => source.parentId === work.id);
    const allocations = ["implementation", "verification"].map(responsibility => ({
      workId: work.id, requirementId: "R01", version: 1, childId: child.id, responsibility,
    }));
    return { ...work, extensions: { ...work.extensions, [key]: { ...workDefinition, value: { ...workDefinition.value, allocations } } } };
  }) };
  const guard = await codexGuardFixture(f);
  const observedAt = "2026-10-30T00:00:00Z";
  const policyDraft = engineModelPolicyOnboarding("codex");
  const policy = await applyEngineModelPolicySet({
    home: f.home, host: "codex", actor: "agent:fixture", occurredAt: observedAt,
    authorization: { target: "models.engine-policy", decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: f.state.metadata.workspaceId },
    policy: { ...policyDraft, tiers: policyDraft.tiers.map(row => row.category === "flagship" ? row : { ...row, ...selection.tuple }) },
  });
  const startup = conversationId => ({
    conversationId, sourceRef: "fixture:native-thread-start", raw: { id: 1, result: { thread: { id: conversationId }, sandbox: { type: "dangerFullAccess" } } }, conversationPointer: "/result/thread/id",
  });
  const assignmentIds = pack.assignments.slice(0, 2).map(row => row.id);
  const binding = { ...pack.binding, assignmentIds };
  const request = { ...f.request, workId: pack.initiative.id, workRevision: pack.initiative.revision, action: "implementation", phase: "dispatch", category: "economy", packBinding: binding,
    authorization: { ...f.request.authorization, workIds: [pack.initiative.id] },
    sourceScope: { repository: "fixture:repository", writableRoots: [f.root], permission: "granted" },
    capabilities: { ...f.request.capabilities, toolName: "collaboration.spawn_agent" } };
  const prepareWorker = (assignment, coordinatorId) => {
    const work = pack.initiative;
    return prepareHostNativeDispatch(pack.state, { ...request, workId: work.id, workRevision: work.revision, packBinding: { ...binding, assignmentId: assignment.id },
      authorization: { ...request.authorization, workIds: [work.id] } }, {
    selection, argumentsValue: { prompt: "Synthetic Pack worker fixture only" }, peerWorker: true,
    nativeSessionId: coordinatorId, codexCoordinatorStartup: startup(coordinatorId),
    codexObservation: guard.native, userHome: guard.userHome,
    }, f.home);
  };
  const preparation = await prepareWorker(pack.assignments[0], "fixture-economy");
  const secondPreparation = await prepareWorker(pack.assignments[1], "fixture-economy");
  assert.ok(preparation.attempt, JSON.stringify(preparation.decision.reasons));
  assert.ok(secondPreparation.attempt, JSON.stringify(secondPreparation.decision.reasons));
  const pending = recordHostNativeEvents(preparation, []);
  const secondPending = recordHostNativeEvents(secondPreparation, []);
  const manifest = {
    schemaVersion: "tcrn.codex-peer-manifest.v1", host: "codex", batchId: binding.batchId, attemptId: binding.batchAttemptId,
    workId: pack.initiative.id, workRevision: pack.initiative.revision, policyDigest: policy.hosts.codex.digest,
    main: { conversationId: "fixture-main", sourceRef: "fixture:main-native-id", raw: { id: "fixture-main" }, conversationPointer: "/id" },
    coordinator: startup("fixture-economy"),
    pack: { packId: binding.packId, packRevision: binding.packRevision, assignmentIds, capacity: binding.capacity },
    members: [
      { attemptId: preparation.attempt.id, workId: pack.initiative.id, workRevision: pack.initiative.revision, conversationId: null, assignmentId: assignmentIds[0] },
      { attemptId: secondPreparation.attempt.id, workId: pack.initiative.id, workRevision: pack.initiative.revision, conversationId: null, assignmentId: assignmentIds[1] },
    ],
  };
  const input = {
    manifest, records: [pending, secondPending], policy, capacity: { limit: 4, active: 1 },
    workRevisions: [
      { id: pack.initiative.id, revision: pack.initiative.revision },
      { id: binding.packId, revision: binding.packRevision },
      { id: nextWork.id, revision: nextWork.revision },
    ],
  };
  const pendingReceipt = recordCodexPeerBatch({ observationCutoff: new Date().toISOString(), ...input });
  assert.equal(pendingReceipt.allTerminal, false);
  assert.equal(pendingReceipt.reportEligible, false, "a pending native attempt is not a terminal result or handoff report");
  assert.equal(pendingReceipt.occupancy, 2, "two unknown attempts retain their frozen worker slots");
  assert.deepEqual(pendingReceipt.manifest.members.map(row => row.assignmentId), assignmentIds);

  const completedEvent = {
    id: "worker-completed", at: new Date().toISOString(), kind: "host-response", sourceTool: "collaboration.spawn_agent",
    raw: { state: "completed", terminal: true, conversationId: "fixture-worker-completed" },
    status: { pointer: "/state", mapping: { completed: "completed" } },
    terminal: { pointer: "/terminal", values: ["true"], contract: "Synthetic spawn terminal receipt" },
    providerId: { pointer: "/conversationId" },
  };
  const completed = recordHostNativeEvents(preparation, [completedEvent], pending);
  const partialReceipt = recordCodexPeerBatch({ observationCutoff: new Date().toISOString(), ...input, records: [completed, secondPending], prior: pendingReceipt });
  assert.equal(partialReceipt.allTerminal, false);
  assert.equal(partialReceipt.records[0].execution, "completed", "an already delivered result remains attached to its Pack row");
  assert.equal(partialReceipt.records[1].execution, "unknown", "the in-flight row remains unresolved");
  assert.equal(partialReceipt.occupancy, 1, "only the in-flight member retains occupancy");

  const handedOff = recordCodexPeerBatch({
    observationCutoff: new Date().toISOString(), ...input,
    manifest: { ...manifest, coordinator: startup("fixture-economy-recovery"), recovery: { priorReceiptDigest: partialReceipt.digest, previousCoordinatorIds: ["fixture-economy"] } },
    records: [], prior: partialReceipt,
  });
  assert.equal(handedOff.manifest.coordinator.conversationId, "fixture-economy-recovery");
  assert.deepEqual(handedOff.records.map(row => row.preparation.attempt.id), [preparation.attempt.id, secondPreparation.attempt.id], "handoff reuses both original attempts without redispatch");
  assert.equal(handedOff.records[0].execution, "completed", "handoff retains the delivered result");
  assert.equal(handedOff.records[1].execution, "unknown", "handoff retains the in-flight status");

  const priorAttempt = structuredClone(handedOff);
  const nextBinding = {
    ...binding,
    assignmentId: nextAssignment.id,
    batchAttemptId: "candidate-attempt-02",
    assignmentIds: [nextAssignment.id],
    capacity: { limit: 2, active: 1 },
  };
  const nextRequest = {
    ...request,
    workId: nextWork.id,
    workRevision: nextWork.revision,
    authorization: { ...request.authorization, workIds: [nextWork.id] },
  };
  const nextCoordinator = "fixture-economy-next";
  const nextPreparation = await prepareHostNativeDispatch(nextState, {
    ...nextRequest,
    packBinding: nextBinding,
  }, {
    selection,
    argumentsValue: { prompt: "Synthetic Pack worker fixture for the next application attempt" },
    peerWorker: true,
    nativeSessionId: nextCoordinator,
    codexCoordinatorStartup: startup(nextCoordinator),
    priorPeerReceipt: handedOff,
    codexObservation: guard.native,
    userHome: guard.userHome,
  }, f.home);
  assert.ok(nextPreparation.attempt, JSON.stringify(nextPreparation.decision.reasons));
  const nextManifest = {
    ...manifest,
    attemptId: nextBinding.batchAttemptId,
    coordinator: startup(nextCoordinator),
    pack: { ...manifest.pack, assignmentIds: nextBinding.assignmentIds, capacity: nextBinding.capacity },
    applicationRecovery: nextPreparation.context.packDispatch.batch.applicationRecovery,
    members: [{
      attemptId: nextPreparation.attempt.id,
      workId: nextWork.id,
      workRevision: nextWork.revision,
      conversationId: null,
      assignmentId: nextAssignment.id,
    }],
  };
  const nextInput = {
    observationCutoff: new Date().toISOString(),
    ...input,
    manifest: nextManifest,
    records: [recordHostNativeEvents(nextPreparation, [])],
    capacity: { limit: 2, active: 1 },
    prior: handedOff,
  };
  assert.throws(() => recordCodexPeerBatch({
    ...nextInput,
    manifest: {
      ...nextManifest,
      recovery: {
        priorReceiptDigest: handedOff.digest,
        previousCoordinatorIds: ["fixture-economy", "fixture-economy-recovery"],
      },
    },
  }), /coordinator recovery and a new application attempt cannot be combined/u);
  const nextReceipt = recordCodexPeerBatch(nextInput);
  assert.equal(nextReceipt.manifest.attemptId, nextBinding.batchAttemptId);
  assert.equal(nextReceipt.manifest.workId, pack.initiative.id);
  assert.equal(nextReceipt.records[0].preparation.decision.request.workId, nextWork.id);
  assert.equal(nextReceipt.manifest.pack.packId, pack.packRecord.id);
  assert.deepEqual(nextReceipt.applicationHistory.map(attempt => attempt.manifest.attemptId), [manifest.attemptId]);
  assert.deepEqual(nextReceipt.applicationHistory[0].records.map(row => row.preparation.attempt.id), [preparation.attempt.id, secondPreparation.attempt.id]);
  assert.deepEqual(nextReceipt.applicationHistory[0].records.map(row => row.execution), ["completed", "unknown"]);
  assert.notEqual(nextReceipt.applicationHistory[0].records[1].occupancy, "released");
  assert.equal(handedOff.digest, priorAttempt.digest, "creating the new application attempt does not rewrite its predecessor");

  const duplicateAttempt = async (assignment, batchAttemptId) => {
    const coordinatorId = `fixture-economy-${batchAttemptId}`;
    const duplicateBinding = {
      ...binding,
      assignmentId: assignment.id,
      batchAttemptId,
      assignmentIds: [assignment.id],
      capacity: { limit: 2, active: 1 },
    };
    await assert.rejects(prepareHostNativeDispatch(pack.state, {
      ...request,
      packBinding: duplicateBinding,
    }, {
      selection,
      argumentsValue: { prompt: `Synthetic Pack worker duplicate attempt for ${assignment.id}` },
      peerWorker: true,
      nativeSessionId: coordinatorId,
      codexCoordinatorStartup: startup(coordinatorId),
      priorPeerReceipt: nextReceipt,
      codexObservation: guard.native,
      userHome: guard.userHome,
    }, f.home), /already completed|unknown or in-flight occupancy .*do not redispatch/iu);
  };

  await duplicateAttempt(pack.assignments[0], "candidate-attempt-03-completed");
  await duplicateAttempt(pack.assignments[1], "candidate-attempt-03-unknown");

  const recoveredNextReceipt = recordCodexPeerBatch({
    observationCutoff: new Date().toISOString(), ...input,
    manifest: {
      ...nextReceipt.manifest,
      coordinator: startup("fixture-economy-next-recovery"),
      recovery: { priorReceiptDigest: nextReceipt.digest, previousCoordinatorIds: [nextCoordinator] },
    },
    records: [], prior: nextReceipt, capacity: { limit: 2, active: 1 },
  });
  assert.equal(recoveredNextReceipt.manifest.attemptId, nextReceipt.manifest.attemptId);
  assert.deepEqual(recoveredNextReceipt.manifest.applicationRecovery, nextReceipt.manifest.applicationRecovery);
  assert.deepEqual(recoveredNextReceipt.applicationHistory, nextReceipt.applicationHistory);
  assert.deepEqual(recoveredNextReceipt.records, nextReceipt.records);
  assert.equal(recoveredNextReceipt.occupancy, nextReceipt.occupancy);
  assert.equal(normalizeCodexPeerBatch(recoveredNextReceipt).digest, recoveredNextReceipt.digest);

  const nextFailed = recordHostNativeEvents(nextPreparation, [{
    id: "next-worker-failed", at: new Date().toISOString(), kind: "host-response", sourceTool: "collaboration.spawn_agent",
    raw: { error: "fixture pre-creation refusal" },
    status: { pointer: "/error", mapping: { "fixture pre-creation refusal": "failed" } },
    terminal: { pointer: "/error", values: ["fixture pre-creation refusal"], contract: "Synthetic refusal before native agent creation" },
  }], recoveredNextReceipt.records[0]);
  const settledNextReceipt = recordCodexPeerBatch({
    observationCutoff: new Date().toISOString(), ...input,
    manifest: recoveredNextReceipt.manifest, records: [nextFailed], prior: recoveredNextReceipt,
    capacity: { limit: 2, active: 0 },
  });
  assert.equal(settledNextReceipt.applicationHistory[0].receiptDigest, handedOff.digest);
  assert.equal(settledNextReceipt.records[0].execution, "failed", "same-application continuation records its actual result after recovery");
  assert.equal(settledNextReceipt.records[0].occupancy, "released");
  assert.equal(settledNextReceipt.records[0].providerId.status, "unknown");
  assert.equal(settledNextReceipt.reportEligible, false, "a pre-creation refusal allows retry but cannot be reported as a completed batch");
  const retryBinding = { ...nextBinding, batchAttemptId: "candidate-attempt-04", capacity: { limit: 2, active: 1 } };
  const retryCoordinator = "fixture-economy-retry";
  const retryPreparation = await prepareHostNativeDispatch(nextState, {
    ...nextRequest,
    packBinding: retryBinding,
  }, {
    selection,
    argumentsValue: { prompt: "Synthetic Pack worker fixture for the retry application attempt" },
    peerWorker: true,
    nativeSessionId: retryCoordinator,
    codexCoordinatorStartup: startup(retryCoordinator),
    priorPeerReceipt: settledNextReceipt,
    codexObservation: guard.native,
    userHome: guard.userHome,
  }, f.home);
  assert.ok(retryPreparation.attempt, JSON.stringify(retryPreparation.decision.reasons));
  const retryManifest = {
    ...nextManifest,
    attemptId: retryBinding.batchAttemptId,
    coordinator: startup(retryCoordinator),
    pack: { ...nextManifest.pack, capacity: retryBinding.capacity },
    applicationRecovery: retryPreparation.context.packDispatch.batch.applicationRecovery,
    members: [{
      attemptId: retryPreparation.attempt.id,
      workId: nextWork.id,
      workRevision: nextWork.revision,
      conversationId: null,
      assignmentId: nextAssignment.id,
    }],
  };
  const retryReceipt = recordCodexPeerBatch({
    observationCutoff: new Date().toISOString(), ...input,
    manifest: retryManifest,
    records: [recordHostNativeEvents(retryPreparation, [])],
    capacity: { limit: 2, active: 1 },
    prior: settledNextReceipt,
  });
  assert.deepEqual(retryReceipt.applicationHistory.map(attempt => attempt.manifest.attemptId), [manifest.attemptId, nextBinding.batchAttemptId]);
  assert.deepEqual(retryReceipt.applicationHistory.map(attempt => attempt.records.map(row => row.execution)), [["completed", "unknown"], ["failed"]]);
  assert.deepEqual(retryReceipt.applicationHistory[1].applicationHistory.map(attempt => attempt.manifest.attemptId), [manifest.attemptId]);
  assert.equal(retryReceipt.applicationHistory[1].receiptDigest, settledNextReceipt.digest, "the full predecessor receipt, including its actual result, remains bound");

  const failedEvent = {
    id: "worker-failed", at: new Date().toISOString(), kind: "host-response", sourceTool: "collaboration.spawn_agent",
    raw: { state: "failed", terminal: true, conversationId: "fixture-worker-failed" },
    status: { pointer: "/state", mapping: { failed: "failed" } },
    terminal: { pointer: "/terminal", values: ["true"], contract: "Synthetic spawn terminal receipt" },
    providerId: { pointer: "/conversationId" },
  };
  const failed = recordHostNativeEvents(secondPreparation, [failedEvent], secondPending);
  const failureReceipt = recordCodexPeerBatch({
    observationCutoff: new Date().toISOString(), ...input,
    manifest: handedOff.manifest, records: [failed], prior: handedOff,
  });
  assert.equal(failureReceipt.allTerminal, true);
  assert.deepEqual(failureReceipt.records.map(row => row.execution), ["completed", "failed"], "native failure is terminal and does not erase the delivered result");
  assert.equal(failureReceipt.records[1].preparation.context.packDispatch.assignment.id, assignmentIds[1]);
  assert.equal(normalizeCodexPeerBatch(handedOff).digest, handedOff.digest);
  assert.equal(normalizeCodexPeerBatch(failureReceipt).digest, failureReceipt.digest);

  const paths = Object.fromEntries(["manifest", "records", "capacity", "prior"].map(name => [name, join(f.root, "continuation-" + name + ".json")]));
  await Promise.all([
    writeFile(paths.manifest, JSON.stringify(manifest)),
    writeFile(paths.records, JSON.stringify([completed, failed])),
    writeFile(paths.capacity, JSON.stringify(input.capacity)),
    writeFile(paths.prior, JSON.stringify(pendingReceipt)),
  ]);
  const { prior: priorPath, ...ordinary } = paths;
  const advanced = { ...pack.state, work: pack.state.work.map(row => row.id === nextWork.id ? { ...row, revision: row.revision + 1 } : row) };
  const recordIn = async (state, name, prior) => {
    const output = join(f.root, name + ".json");
    await runNativeToolCommand("execution-codex-peer-record", { workspace: f.workspace, output, ...ordinary, ...(prior ? { prior } : {}) },
      { home: f.home, resolveWorkspace: async () => ({ root: f.workspace, state }) });
    return JSON.parse(await readFile(output, "utf8"));
  };
  const newRecord = await recordIn(advanced, "unprepared-record", undefined);
  assert.equal(newRecord.reasonCode, "CODEX_PEER_RECORD_INVALID");
  const continued = await recordIn(advanced, "retained-record", priorPath);
  assert.equal(continued.reportEligible, true);
  assert.equal(continued.allTerminal, true);
  assert.deepEqual(continued.records.map(row => row.preparation.attempt.id), [preparation.attempt.id, secondPreparation.attempt.id]);
  const changedInitiative = { ...advanced, work: advanced.work.map(row => row.id === manifest.workId ? { ...row, revision: row.revision + 1 } : row) };
  const drifted = await recordIn(changedInitiative, "advanced-initiative-record", priorPath);
  assert.equal(drifted.reportEligible, false);
  assert.ok(drifted.blockedReasons.includes("work-revision-drift:" + manifest.workId));
  const anotherLibrary = { ...advanced, metadata: { ...advanced.metadata, workspaceId: "workspace:" + "0".repeat(24) } };
  assert.equal((await recordIn(anotherLibrary, "foreign-retained-record", priorPath)).reasonCode, "CODEX_PEER_RECORD_INVALID");

  t.diagnostic(JSON.stringify({
    fixtureIdentity: candidatePackInput.fixtureIdentity,
    packId: pack.packRecord.id,
    assignmentIds,
    newAssignmentId: nextAssignment.id,
    applicationAttempts: [manifest.attemptId, nextBinding.batchAttemptId, retryBinding.batchAttemptId],
    workerAttempts: {
      oldCompleted: preparation.attempt.id,
      oldInFlight: secondPreparation.attempt.id,
      newFailed: nextPreparation.attempt.id,
      retry: retryPreparation.attempt.id,
    },
    receiptDigests: {
      oldHandoff: handedOff.digest,
      newAttempt: nextReceipt.digest,
      settledNewAttempt: settledNextReceipt.digest,
      retry: retryReceipt.digest,
    },
    retainedResults: retryReceipt.applicationHistory.map(application => ({
      applicationAttemptId: application.manifest.attemptId,
      records: application.records.map(record => ({
        assignmentId: record.preparation.context.packDispatch.assignment.id,
        workerAttemptId: record.preparation.attempt.id,
        execution: record.execution,
        occupancy: record.occupancy,
      })),
    })),
    rejectedReplays: [pack.assignments[0].id, pack.assignments[1].id],
  }));
});
