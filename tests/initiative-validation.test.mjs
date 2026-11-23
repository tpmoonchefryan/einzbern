// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { cli, instant, workspaceFixture } from "./helpers/workspace-fixture.mjs";
import { planImplementationBatch } from "../dist/build/packages/core/src/implementation-batch.js";
import { validationDispatchProblem, validationTransition } from "../dist/build/packages/core/src/work-validation.js";
import { codexWorkerArguments, observedCodexCapacity, observedCodexUsage, observedHooks } from "../dist/build/packages/core/src/codex-dispatch-input.js";
import { workContentDraft } from "../dist/build/packages/core/src/work-content.js";
import { workRequirementProblems } from "../dist/build/packages/core/src/work-requirements.js";

test("normal work commands defer formal validation to the INIT, preserve partial work and replay batch results", async t => {
  const { workspace, projectId } = await workspaceFixture(t);
  let second = 2;
  const cmd = (name, ...args) => cli([name, "--workspace", workspace, "--at", instant(second++), ...args]);
  const create = async (kind, key, parent) => (await cmd("work-create", "--project-id", projectId, "--external-key", key,
    "--kind", kind, "--title", key, "--status", "active", ...(parent ? ["--parent-id", parent] : []),
    ...(kind === "Story" ? ["--goal", "Deliver candidate", "--acceptance", "Candidate runs against both interfaces"] : []))).record.id;
  const init = await create("Initiative", "CYCLE-INIT");
  const e1 = await create("Epic", "CYCLE-E1", init), e2 = await create("Epic", "CYCLE-E2", init);
  const a = await create("Story", "CYCLE-A", e1), b = await create("Story", "CYCLE-B", e1), c = await create("Story", "CYCLE-C", e2);
  const move = (id, status, ...args) => cmd("work-transition", "--id", id, "--status", status, ...args);
  const show = id => cli(["work-show", "--workspace", workspace, "--id", id]);
  const list = status => cli(["work-list", "--workspace", workspace, "--status", status]);
  const batch = async members => {
    const path = join(workspace, "..", "validation-test-batch.json");
    await writeFile(path, JSON.stringify({ schemaVersion: "tcrn.work-batch.v1", members }));
    return cmd("work-batch", "--from-file", path);
  };
  await move(a, "pending-validate");
  await assert.rejects(move(e1, "pending-validate"), /still open/);
  await move(b, "pending-validate");
  await move(e1, "pending-validate");
  await assert.rejects(move(a, "validated", "--summary", "Independent report A"), /CYCLE-E2/);
  await assert.rejects(move(a, "done"), /INIT acceptance/);
  await assert.rejects(cmd("work-annotate", "--id", a, "--labels", "einzbern:validation:passed"), /work-transition/);
  await move(c, "pending-validate");
  await move(e2, "pending-validate");
  await move(init, "pending-validate");
  assert.equal((await list("pending-validate")).records.length, 6);
  await move(a, "active", "--summary", "Independent report A found an invalid interface");
  await assert.rejects(move(b, "blocked", "--summary", "Cannot run checks"), /predecessor/);
  await batch([{ verb: "work-annotate", id: b, relations: { blockedBy: [a] } },
    { verb: "work-transition", id: b, status: "blocked", summary: "Every criterion needs the failed A interface" },
    { verb: "work-transition", id: c, status: "validated", summary: "Independent report C, candidate 1" }]);
  assert.equal((await show(b)).record.status, "blocked");
  assert.deepEqual((await show(a)).relations.reverse.blocks, [b]);
  assert.equal((await show(c)).record.status, "validated");
  await assert.rejects(move(b, "pending-validate"), /hard predecessor/);
  await move(a, "pending-validate");
  await assert.rejects(move(b, "pending-validate"), /hard predecessor/);
  await move(a, "validated", "--summary", "Independent report A, fixed candidate 2");
  await move(b, "pending-validate");
  for (const id of [b, e1, e2, init]) await move(id, "validated", "--summary", "Independent report for frozen candidate 2");
  assert.equal((await list("validated")).records.length, 6);
  assert.equal((await list("done")).records.length, 0);
});

test("typed INIT scope retains child criteria and counts only fully blocked validation", () => {
  const req = { id: "R", version: 1, text: "Validate both interfaces", shared: false, disposition: "required", sourceIds: ["D"] };
  const content = { ...workContentDraft("Initiative"), details: { acceptanceScope: "initiative" }, allocations: [{ workId: "i", requirementId: "R", version: 1, childId: "e", responsibility: "implementation" }],
    sources: [{ id: "D", kind: "decision", locator: "test:approval", version: "1", extraction: "complete", text: "Use INIT acceptance" }], requirements: [req], acceptance: [], evidence: [] };
  const row = (id, kind, parentId, status, labels = [], extensions = {}) => ({ id, kind, parentId, status, labels, extensions });
  const data = value => ({ "advisory:work-content": { required: false, value } });
  const i = row("i", "Initiative", null, "active", [], data(content));
  const e = row("e", "Epic", "i", "active", ["einzbern:validation:pending"]);
  const a = row("a", "Story", "e", "active", ["einzbern:validation:repair"]);
  const b = row("b", "Story", "e", "active", ["einzbern:validation:pending"], { ...data({ ...workContentDraft("Story"), acceptance: ["A", "B"].map(id => ({ id, version: 1, requirement: { workId: "i", requirementId: "R", version: 1 }, scenario: id, expected: "passes", method: "execute" })) }),
    "advisory:relations": { required: false, value: { blockedBy: ["a"] } } });
  const work = [i, e, a, b];
  assert.deepEqual(workRequirementProblems(work, i), []);
  assert.match(validationTransition(work, b, "blocked", "requires A", ["A"]).problem, /every acceptance criterion/);
  assert.equal(validationTransition(work, b, "blocked", "both require A", ["A", "B"]).status, "blocked");
  assert.equal(validationDispatchProblem(work, b, "validation"), null);
  assert.match(validationDispatchProblem(work, b, "implementation"), /already pending/);
  assert.match(validationDispatchProblem([i, { ...e, labels: [] }, a, b], b, "validation"), /still open/);
  const checking = { ...i, labels: ["einzbern:validation:pending"] };
  const repairing = { ...e, labels: ["einzbern:validation:repair"] };
  assert.equal(validationDispatchProblem([checking, repairing, a, b], b, "validation"), null);
  assert.match(validationDispatchProblem([checking, repairing, row("new", "Epic", "i", "active"), a, b], b, "validation"), /new/);
  assert.equal(validationTransition(work, row("unrelated", "Review", "i", "active"), "done").problem, undefined);
});

test("fill available slots with the largest compatible set, then refill with newly available inputs", () => {
  const pkg = (id, writes, requires = []) => ({ id, writes, requires, authorized: true });
  const input = { freeSlots: 2, availableCandidates: ["lib@1"], occupiedWrites: ["repo/live"],
    packages: [pkg("wide", ["repo/lib"]), pkg("a", ["repo/lib/a"], ["lib@1"]), pkg("b", ["repo/lib/b"]), pkg("next", [], ["lib@2"]), pkg("busy", ["repo/live/x"])] };
  assert.deepEqual(planImplementationBatch(input).selected, ["a", "b"]);
  assert.deepEqual(planImplementationBatch({ ...input, freeSlots: 1, availableCandidates: ["lib@2"], packages: input.packages.slice(3) }).selected, ["next"]);
  assert.deepEqual(planImplementationBatch({ ...input, freeSlots: 0 }).selected, []);
});

test("assemble worker selection, hooks, capacity and quota from observed fields without granting missing permission", () => {
  const now = "2026-11-21T22:07:03Z", observedAt = "2026-11-21T22:07:02.781Z";
  const tuple = { runner: "codex", model: "test", effort: "low" };
  const selection = { kind: "explicit", tuple };
  const args = codexWorkerArguments({ selection }, { selection: tuple, argumentsValue: { message: "fixture" } });
  assert.deepEqual(args, { selection, argumentsValue: { message: "fixture", model: "test", reasoning_effort: "low", fork_turns: "none" } });
  assert.throws(() => codexWorkerArguments({ selection }, { argumentsValue: { model: "wrong" } }), /conflict/);
  const native = { observedAt };
  assert.equal(observedHooks({ native }), native);
  assert.equal(observedHooks({ native, trust: "denied" }), undefined);
  const quota = { observedAt, primary: { usedPercent: 20, windowDurationMins: 10080 } };
  assert.deepEqual(observedCodexUsage(quota, now), { observedAt, weeklyUsedPercent: 20 });
  assert.throws(() => observedCodexUsage({ ...quota, observedAt: undefined }, now), /observedAt/);
  assert.throws(() => observedCodexUsage(quota, "2026-11-21T23:00:00Z"), /refresh/);
  const roster = { observedAtUpperBound: observedAt, sourceTool: "collaboration.list_agents", counts: { limit: 4, active: 1, includesCoordinator: true },
    actualResult: { agents: [{ agent_name: "/root", agent_status: "running" }, { agent_name: "/root/a", agent_status: "completed" }] } };
  assert.deepEqual(observedCodexCapacity(roster, now), { limit: 4, active: 1, includesParent: true, parentActive: true });
  assert.throws(() => observedCodexCapacity({ ...roster, counts: { ...roster.counts, active: 0 } }, now), /differ/);
});

test("empty batches reconcile both authorized Initiative trees, legacy evidence, native receipts and conditional work", async t => {
  const { workspace, projectId } = await workspaceFixture(t);
  let second = 2;
  const run = (verb, ...args) => cli([verb, "--workspace", workspace, "--at", instant(second++), ...args]);
  const create = async (kind, key, parent, status = "active", summary = key) => (await run("work-create", "--project-id", projectId,
    "--external-key", key, "--kind", kind, "--title", key, "--summary", summary, "--status", status,
    ...(parent ? ["--parent-id", parent] : []), ...(kind === "Story" ? ["--goal", key, "--acceptance", "Observed result"] : []))).record.id;
  const one = await create("Initiative", "AUDIT-ONE"), two = await create("Initiative", "AUDIT-TWO");
  const unrelated = await create("Initiative", "AUDIT-OUTSIDE");
  const e1 = await create("Epic", "AUDIT-E1", one), e2 = await create("Epic", "AUDIT-E2", two);
  const delivered = await create("Story", "AUDIT-DELIVERED", e1, "planned", "Pending Validate from the old workflow");
  const conditional = await create("Story", "AUDIT-CONDITION", e1, "planned");
  const blocked = await create("Story", "AUDIT-MAC", e2);
  const minutes = await run("minutes-record", "--project-id", projectId, "--external-key", "AUDIT-GRANT", "--title", "Grant implementation",
    "--summary", "Authorize both initiatives", "--decisions", "Implement both", "--work-ids", [one, two].join(","));
  const scope = join(workspace, "..", "owner-grants.json");
  const evidence = join(workspace, "..", "review.json");
  const batch = join(workspace, "..", "apply.json");
  await writeFile(scope, JSON.stringify({ decisions: [minutes.id + "#D1"] }));
  const execution = { evidence: "native roster and report inbox #4", inFlight: [], unreceived: [] };
  const audit = async (items, observation = execution) => {
    const inventory = await cli(["execution-queue-reconcile", "--workspace", workspace, "--scope", scope]);
    await writeFile(evidence, JSON.stringify({ items, ...(observation ? { execution: { scopeDigest: inventory.scopeDigest, observedAt: new Date().toISOString(), ...observation } } : {}) }));
    return cli(["execution-queue-reconcile", "--workspace", workspace, "--scope", scope, "--assessments", evidence]);
  };
  const apply = async result => {
    await writeFile(batch, JSON.stringify(result.batch));
    return run("work-batch", "--from-file", batch);
  };
  const at = (result, id) => result.rows.find(row => row.id === id);
  const status = async id => (await cli(["work-show", "--workspace", workspace, "--id", id])).record;
  const found = (workId, revision, finding, fields = {}) => ({ workId, revision, finding, reason: "Reviewed full applicable scope", evidence: "fixture:original-receipt", ...fields });
  const initial = await audit([]);
  assert.deepEqual(new Set(initial.initiatives.map(row => row.id)), new Set([one, two]));
  assert.equal(at(initial, unrelated), undefined);
  assert.equal(at(initial, delivered).next, "review-legacy");
  assert.equal(initial.canStop, false);
  assert.equal(initial.batch.members.length, 0);
  const mac = found(blocked, 1, "blocked", { resumeWhen: "Named Mac receiver returns online" });
  const dormant = found(conditional, 1, "condition-not-triggered", { basis: "AC applies after release", resumeWhen: "Release is published" });
  assert.equal((await audit([mac])).canStop, false);
  await assert.rejects(audit([found(unrelated, 1, "ready")]), /outside/);
  await assert.rejects(audit([found(conditional, 1, "blocked")]), /release or trigger/);
  const plan = await audit([mac, dormant, found(delivered, 1, "implemented")]);
  assert.equal(at(plan, delivered).next, "apply");
  assert.deepEqual(plan.batch.members.filter(m => m.id === delivered).map(m => m.expectedRevision), [1, 2, 3]);
  await apply(plan);
  await assert.rejects(apply(plan), /revision changed/);
  assert.equal((await status(delivered)).status, "pending-validate");
  assert.equal((await status(conditional)).status, "planned");
  assert.equal(at(await audit([dormant, mac]), conditional).next, "refresh-assessment");
  const current = { ...dormant, revision: (await status(conditional)).revision };
  const rest = await audit([current, mac]);
  assert.equal(at(rest, conditional).next, "condition-not-triggered");
  assert.equal(at(rest, e1).next, "roll-up");
  assert.equal(rest.canStop, false);
  await apply(await audit([current, mac, found(e1, 1, "implemented")]));
  await apply(await audit([current, mac, found(one, 1, "implemented")]));
  assert.equal(at(await audit([current, mac]), one).next, "validate");
  for (const id of [delivered, e1, one]) await run("work-transition", "--id", id, "--status", "validated", "--summary", "Independent applicable-scope report");
  const stalled = await audit([mac]);
  assert.equal(stalled.outcome, "all-applicable-blocked");
  assert.equal((await audit([mac], null)).canStop, false);
  assert.equal((await audit([mac], { ...execution, scopeDigest: initial.scopeDigest })).canStop, false);
  assert.equal((await audit([mac], { ...execution, observedAt: instant(0) })).canStop, false);
  assert.equal((await audit([mac], { ...execution, unreceived: ["prior-attempt"] })).canStop, false);
  assert.equal((await audit([found(blocked, 1, "ready")])).canStop, false);
});

test("untriggered parents cannot hide applicable children and a new observation reopens the scoped work", async t => {
  const { workspace, projectId } = await workspaceFixture(t);
  let sec = 1;
  const run = (verb, ...args) => cli([verb, "--workspace", workspace, "--at", instant(sec++), ...args]);
  const create = async (kind, key, parent) => (await run("work-create", "--project-id", projectId, "--external-key", key, "--title", key,
    "--kind", kind, "--status", "active", ...(parent ? ["--parent-id", parent] : []), ...(kind === "Story" ? ["--goal", key, "--acceptance", "record result"] : []))).record.id;
  const root = await create("Initiative", "TRIGGER-INIT"), epic = await create("Epic", "TRIGGER-E", root);
  const story = await create("Story", "TRIGGER-S", epic), sub = await create("Subtask", "TRIGGER-T", story);
  const path = join(workspace, "..", "conditions.json");
  const write = async members => { await writeFile(path, JSON.stringify({ schemaVersion: "tcrn.work-batch.v1", members })); return run("work-batch", "--from-file", path); };
  const defer = id => ({ verb: "work-annotate", id, expectedRevision: 1, implementationCondition: { basis: "Actual release criterion", evidence: "release-readback", resumeWhen: "Published" } });
  await assert.rejects(write([defer(story)]), /each implementation child/);
  await write([defer(sub), defer(story)]);
  await assert.rejects(run("work-transition", "--id", story, "--status", "pending-validate"), /condition/);
  await write([{ verb: "work-annotate", id: sub, expectedRevision: 2, implementationCondition: null }]);
  await assert.rejects(run("work-transition", "--id", epic, "--status", "pending-validate"), /still open/);
});
