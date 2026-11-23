// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { createProject, createWork, initializeLibrary, recordMinutes } from "../dist/build/packages/core/src/index.js";
import { RecallIndex, recall, recallDocuments, recallQueryTokens, resetRecallCache, segmentForIndex } from "../dist/build/packages/core/src/recall.js";
import { formatRecallLine, recallContextLines, recallInputsFromState } from "../dist/build/packages/core/src/recall-inputs.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const decisions = ["Keep the unrelated orchard.", "Quasar gateway must retain the amber audit log.", "Keep the pond.", "Keep the lake.", "Keep the stream.", "Keep the oak.", "Keep the pine.", "SubagentStop retires the collector slot.", "UTF8 delivery must preserve the expandable source."];
const minutes = { id: "minutes:111111111111111111111111", externalKey: "DELIVERY-MIN-1", conferenceTitle: "Gateway delivery contract", conferenceType: "", summary: "Gateway audit and handoff decisions", decisions, outcomeClass: "recorded", projectId: "project:111111111111111111111111" };
const at = "2026-11-13T10:00:00Z";

function search(inputs, query) {
  return recall({ cacheKey: query, checkpoint: JSON.stringify(inputs), query, documents: () => recallDocuments(inputs), tau: 0 }).records;
}

test("delivery selects D2/D8/D9 and keeps valid source and scope inside the byte budget", () => {
  for (const [query, number] of [["quasar amber audit", 2], ["SubagentStop collector slot", 8], ["UTF8 expandable source", 9], ["DELIVERY-MIN-1#D8", 8]]) {
    const hits = search({ minutes: [minutes] }, query);
    assert.equal(hits[0].decision.number, number);
    const lines = recallContextLines(hits, 1600);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(`D${number} 现行有效`));
    assert.ok(lines[0].includes(`minutes-show --id ${minutes.id}#D${number}`));
    assert.ok(lines[0].includes(`范围 ${minutes.projectId}`));
    assert.ok(Buffer.byteLength(lines.join("\n")) <= 1600);
    assert.ok(!lines[0].includes("\ufffd"));
    assert.deepEqual(recallContextLines(hits, 8), [], "a source that cannot fit is not cut into a false delivery");
  }
  resetRecallCache();
});

test("a 2060B second candidate cannot block a 788B third candidate in 1600B", () => {
  const hit = { kind: "work", key: "EVAL-STORY-1", id: "work:111111111111111111111111", status: "active", title: "Contract", summary: "Useful contract", recordKind: "Story", parentChain: [], lead: "", score: 10 };
  const sized = (size) => {
    const base = formatRecallLine(hit);
    const candidate = { ...hit, title: hit.title + "x".repeat(size - Buffer.byteLength(base)) };
    assert.equal(Buffer.byteLength(formatRecallLine(candidate)), size);
    return candidate;
  };
  const hits = [sized(600), sized(2060), sized(788)];
  assert.deepEqual(recallContextLines(hits, 1600), [formatRecallLine(hits[0]), formatRecallLine(hits[2])]);
  assert.equal(Buffer.byteLength(recallContextLines(hits, 1600).join("\n")), 1389);
  assert.deepEqual(recallContextLines([hits[1], hits[2]], 1600), [formatRecallLine(hits[2])]);
  assert.deepEqual(recallContextLines([hits[1]], 1600), []);
  for (const title of ["", "123", "EVAL-STORY-1"]) assert.deepEqual(recallContextLines([{ ...hit, title }], 1600), []);
  assert.deepEqual(recallContextLines([{ ...hit, summary: "" }], 1600), []);
});

test("UTF-8 excerpts reserve the entire source even for a long multibyte clause", () => {
  const hit = search({ minutes: [{ ...minutes, decisions: ["边界有效范围。".repeat(600)] }] }, "边界有效范围")[0];
  const line = formatRecallLine(hit);
  assert.ok(Buffer.byteLength(line) < 1600);
  assert.ok(line.includes(`minutes-show --id ${minutes.id}#D1`));
  assert.ok(line.endsWith("）"));
  assert.ok(!line.includes("\ufffd"));
  resetRecallCache();
});

test("current Work contract excludes 80KB history and decays done records without changing event bytes", () => {
  const base = { id: "work:111111111111111111111111", externalKey: "CONTRACT-STORY-1", kind: "Story", status: "active", title: "Amber gateway contract", summary: "Amber gateway contract", parentId: null, projectId: "project:111111111111111111111111", labels: [], extensions: { "advisory:goal": { required: false, value: "Deliver quasar gateway amber audit" }, "advisory:acceptance": { required: false, value: "The amber audit must be expandable" }, "advisory:body": { required: false, value: "Current offline gateway.\n\n## History\n" + "deprecated collector polling fallback ".repeat(2500) } } };
  const done = { ...base, id: "work:222222222222222222222222", externalKey: "CONTRACT-STORY-2", status: "done" };
  const state = { work: [done, base], minutes: [], conferenceMinutes: [], conferences: [] };
  const before = JSON.stringify(state);
  const inputs = recallInputsFromState(state, []);
  const docs = recallDocuments(inputs);
  assert.ok(inputs.work[0].contract.includes("expandable"));
  assert.ok(!docs[0].body.includes("deprecated"));
  assert.equal(search(inputs, "deprecated collector polling fallback").length, 0);
  assert.equal(search(inputs, "quasar gateway amber audit")[0].id, base.id);
  assert.equal(search(inputs, "CONTRACT-STORY-2")[0].id, done.id, "exact keys override status decay");
  assert.equal(JSON.stringify(state), before);
  resetRecallCache();
});

test("identifier subwords coexist with full tokens; conflict tokenization stays unchanged", () => {
  assert.ok(recallQueryTokens("SubagentStop").includes("subagentstop"));
  assert.ok(recallQueryTokens("SubagentStop").includes("subagent"));
  assert.ok(recallQueryTokens("SubagentStop").includes("stop"));
  assert.ok(segmentForIndex("SubagentStop").includes("SubagentStop subagent stop"));
  const index = new RecallIndex(recallDocuments({ minutes: [minutes] }), "identifier");
  assert.equal(index.search("subagent stop")[0]?.decision.number, 8);
  index.close();
});

test("identifier expansion does not change an unrelated prose score through corpus length", () => {
  const inputs = (summary) => ({ knowledge: [
    { id: "knowledge:111111111111111111111111", externalKey: "EVAL-CARD-1", subject: "Quasar gateway", summary: "Amber audit", snippet: "", tags: [] },
    { id: "knowledge:222222222222222222222222", externalKey: "EVAL-CARD-2", subject: "Other subject", summary, snippet: "", tags: [] },
  ] });
  const plain = new RecallIndex(recallDocuments(inputs("plaintoken")), "plain");
  const identifier = new RecallIndex(recallDocuments(inputs("readFileSync")), "identifier");
  assert.equal(identifier.search("quasar")[0].score, plain.search("quasar")[0].score);
  plain.close();
  identifier.close();
});

test("common clauses in a small library do not suppress a matching card at zero tau", () => {
  const card = { id: "knowledge:333333333333333333333333", externalKey: "EVAL-CARD-3", subject: "Kingfisher bank", summary: "Kingfisher bank notes", snippet: "", tags: [] };
  const inputs = { knowledge: [card], minutes: [
    { ...minutes, decisions: ["Film the kingfisher bank at dawn."] },
    { ...minutes, id: "minutes:222222222222222222222222", externalKey: "EVAL-MIN-2", decisions: ["Film the kingfisher bank at dusk."] },
  ] };
  const hits = search(inputs, "kingfisher bank");
  assert.ok(hits.some((hit) => hit.id === card.id));
  assert.equal(hits.filter((hit) => hit.kind === "minutes").length, 2);
  resetRecallCache();
});

test("a complete technical identifier remains a strong short query in a small shared-topic library", () => {
  const inputs = { minutes: Array.from({ length: 7 }, (_, index) => ({ ...minutes,
    id: `minutes:${String(index + 1).padStart(24, "0")}`, externalKey: `EVAL-SHARED-${index + 1}`,
    conferenceTitle: "Codex hook contract", summary: "Codex hook contract",
    decisions: [index < 2 ? "Codex hook SubagentStop delivery." : "Codex hook ordinary stream notes."],
  })) };
  const answer = recall({ cacheKey: "short-shared-topic", checkpoint: "frozen", query: "Codex hook SubagentStop", documents: () => recallDocuments(inputs) });
  assert.ok(answer.records.length > 0);
  assert.ok(recallContextLines(answer.records, 1600).some((line) => line.includes("SubagentStop") && line.includes("minutes-show --id")));
  const negative = recall({ cacheKey: "short-shared-topic", checkpoint: "frozen", query: "Codex hook unrelated SubagentStop", documents: () => recallDocuments(inputs) });
  assert.equal(negative.records.length, 0, "an unmatched constraint gets no identifier bonus");
  resetRecallCache();
});

test("normal agent CLI delivers actual valid D8, excludes superseded D2 and marks historical reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "recall-delivery-"));
  t.after(async () => { resetRecallCache(); await rm(root, { recursive: true, force: true }); });
  await initializeLibrary({ root, createdAt: at });
  let state = await createProject(root, { occurredAt: at, externalKey: "DELIVERY-PROJECT", name: "Delivery regression" });
  const projectId = state.projects[0].id;
  await createWork(root, { occurredAt: at, projectId, externalKey: "DELIVERY-INIT-1", kind: "Initiative", parentId: null, title: "Delivery project", goal: "Deliver precise decisions" });
  await recordMinutes(root, { occurredAt: at, externalKey: minutes.externalKey, projectId, title: minutes.conferenceTitle, summary: minutes.summary, decisions, decidedBy: [], linkedWorkIds: [] });
  state = await recordMinutes(root, { occurredAt: at, externalKey: "DELIVERY-MIN-2", projectId, title: "Gateway retirement", summary: "Retire the amber audit log", decisions: ["Quasar gateway must retire the amber audit log."], supersedes: [{ decision: "DELIVERY-MIN-1#D2", by: "D1" }], decidedBy: [], linkedWorkIds: [] });
  const read = async (query, extra = []) => {
    let raw;
    await runCli(["recall", "--workspace", root, "--at", at, "--query", query, "--view", "agent", ...extra], { write(value) { raw = value; } });
    return JSON.parse(raw);
  };
  const current = await read("SubagentStop");
  assert.equal(current.schemaVersion, "tcrn.recall-agent.v1");
  assert.ok(current.context.some((line) => line.includes("D8 现行有效") && line.includes("retires the collector slot")));
  assert.ok(current.context.every((line) => !line.includes("must retain the amber audit log")));
  const predecessor = state.minutes.find((r) => r.externalKey === minutes.externalKey);
  const historical = await read("历史 DELIVERY-MIN-1#D2", ["--status", "all"]);
  assert.ok(historical.context.some((line) => line.includes("D2 历史已失效") && line.includes(`${predecessor.id}#D2`) && line.includes("must retain")));
});

test("agent CLI binds each explicit clause to its full key, unique fragment or native ID", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "recall-clause-binding-"));
  t.after(async () => { resetRecallCache(); await rm(root, { recursive: true, force: true }); });
  await initializeLibrary({ root, createdAt: at });
  const project = await createProject(root, { occurredAt: at, externalKey: "CLAUSE-BINDING-PROJECT", name: "Transport rules" });
  const projectId = project.projects[0].id;
  const sources = [101, 202].map((number) => {
    const key = `CLAUSE-BINDING-MIN-${number}`;
    return { key, id: deriveStableId("minutes", key), decisions: Array.from({ length: 9 }, (_, index) => `Transport ${number} retains frame ${index + 1}.`) };
  });
  for (const [index, source] of sources.entries()) {
    const coexists = sources.slice(0, index).flatMap((other) => other.decisions.map((_, index) => `${other.id}#D${index + 1}`));
    await recordMinutes(root, { occurredAt: at, projectId, externalKey: source.key, title: `Transport ${source.key}`, summary: "Frame retention rules", decisions: source.decisions, decidedBy: [], linkedWorkIds: [], coexists });
  }
  const [a, b] = sources;
  const read = async (query, agent = true) => {
    let raw = "";
    await runCli(["recall", "--workspace", root, "--at", at, "--query", query, ...(agent ? ["--view", "agent"] : [])], { write(value) { raw += value; } });
    return JSON.parse(raw);
  };
  for (const [query, expected] of [
    [`${a.key}#D2`, [[a, 2]]],
    [`${b.key}#D8`, [[b, 8]]],
    [`Please report ref=${b.key}#D8.`, [[b, 8]]],
    [`Please report ref:${b.key}#D8.`, [[b, 8]]],
    ["Please report ref:MIN-202#D8.", [[b, 8]]],
    [`Please report ref:${b.key}#D8 and ${a.id}#D2.`, [[b, 8], [a, 2]]],
    [`${b.key} and ref:MIN-202#D8 then ${b.id}#D8`, [[b, 8]]],
    [`Please report ${a.key}#D2 and ${b.key}#D8.`, [[a, 2], [b, 8]]],
    [`Please report ${b.key}#D8 and ${a.key}#D2.`, [[b, 8], [a, 2]]],
    ["MIN-202#D8", [[b, 8]]],
    [`min-202#d8 and ${a.key}#D2`, [[b, 8], [a, 2]]],
    [`${a.id}#D2 and ${b.key}#D8`, [[a, 2], [b, 8]]],
    [`${b.key}#D8 and ${a.id}#D2`, [[b, 8], [a, 2]]],
    [`${b.id}#D8`, [[b, 8]]],
    [`${a.key}#D2 and MIN-101#D2`, [[a, 2]]],
    [`${a.key} and ${b.key}#D8 then MIN-101#D2`, [[a, 2], [b, 8]]],
  ]) {
    await t.test(query, async () => {
      const answer = await read(query);
      const full = await read(query, false);
      assert.deepEqual(full.records.map((record) => record.id), expected.map(([source]) => source.id));
      assert.equal(answer.context.length, expected.length);
      for (const [index, [source, number]] of expected.entries()) {
        const line = answer.context[index];
        assert.ok(line.includes(`D${number} 现行有效`), line);
        assert.ok(line.includes(source.decisions[number - 1]), line);
        assert.ok(line.includes(`minutes-show --id ${source.id}#D${number}`), line);
      }
      assert.ok(Buffer.byteLength(answer.context.join("\n")) <= 1600);
    });
  }
  for (const [query, label] of [
    [`当前 ${b.key}#D8 的有效决定是什么？`, "现行有效"],
    [`当前 ${b.key}#D8 的有效决定是什么？请勿把历史原因当作现行动作。`, "现行有效"],
    [`当前 ${b.key}#D8 的有效决定是什么？不要把旧版当作现行动作。`, "现行有效"],
    [`历史问题 ${b.key}#D8 当初为什么这样选择？`, "历史问题；非现行行动"],
    [`${b.key}#D8 的历史原因是什么？当前查询的是原因。`, "历史问题；非现行行动"],
    [`请勿执行旧版。历史问题 ${b.key}#D8 当初为什么这样选择？`, "历史问题；非现行行动"],
  ]) {
    await t.test(query, async () => {
      const answer = await read(query);
      assert.equal(answer.context.length, 1);
      assert.ok(answer.context[0].includes(`D8 ${label}`), answer.context[0]);
      assert.ok(answer.context[0].includes(`minutes-show --id ${b.id}#D8`));
    });
  }
  await t.test("a current question still labels a withdrawn clause as obsolete", () => {
    const inputs = { minutes: [{ id: b.id, externalKey: b.key, conferenceTitle: "Transport rules", conferenceType: "", summary: "Frame retention rules", projectId, outcomeClass: "recorded", decisions: b.decisions, decisionStatuses: b.decisions.map((_, index) => index === 7 ? "obsolete" : "valid") }] };
    const hits = search(inputs, `当前 ${b.key}#D8 的有效决定是什么？请勿把历史原因当作现行动作。`);
    const lines = recallContextLines(hits, 1600);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("D8 历史已失效→撤回"), lines[0]);
    assert.ok(!lines[0].includes("D8 现行有效"));
  });
});

test("agent CLI delivers the applicable release, historical review and file budget first", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "recall-scope-cues-"));
  t.after(async () => { resetRecallCache(); await rm(root, { recursive: true, force: true }); });
  await initializeLibrary({ root, createdAt: at });
  let state = await createProject(root, { occurredAt: at, externalKey: "SCOPE-CUES-EM", name: "E and M release evidence" });
  const emProjectId = state.projects.find((project) => project.externalKey === "SCOPE-CUES-EM").id;
  state = await createProject(root, { occurredAt: at, externalKey: "SCOPE-CUES-DSH-JOI", name: "dsh-joi-channel-theme release" });
  const dshProjectId = state.projects.find((project) => project.externalKey === "SCOPE-CUES-DSH-JOI").id;
  const addMinutes = (projectId, externalKey, title, decisions) => recordMinutes(root, {
    occurredAt: at, projectId, externalKey, title, summary: title, decisions, decidedBy: [], linkedWorkIds: [],
  });
  await addMinutes(emProjectId, "TCRN-CROSS-MIN-20261116-EM-500-RELEASED", "v5.0.0 release evidence", [
    "Einzbern and Mana Orchestrate officially released v5.0.0; this records the release basis for both repositories.",
  ]);
  await addMinutes(emProjectId, "TCRN-CROSS-MIN-20261117-EM-500-LOCAL-UPDATE", "Local E and M update", [
    "By the Owner's one-time instruction to update the local versions, update the local Einzbern engine and four host Skill copies from 4.6.0 to the latest formal version 5.0.0.",
  ]);
  await addMinutes(emProjectId, "TCRN-CROSS-MIN-282", "Einzbern PR #17 independent code review and merge recommendation", [
    "Codex independent technical review recommended merging Einzbern PR #17 at head 3a7cfc6b7013f30d0703df8ad5e6aaf572129d53; this historical reviewer opinion is not Owner merge authorization.",
  ]);
  await addMinutes(emProjectId, "TCRN-CROSS-MIN-20261113-EM-PHASED-PLAN", "E and M phased evolution plan", [
    "Keep the released interfaces stable.",
    "Record the cross project work boundary.",
    "Put host specific guidance in host reference documents.",
    "Mana Orchestrate SKILL.md has a long term capacity budget of 6000 字节 and carries only general navigation and high frequency one line command templates; before implementing STORY-667, read the latest STORY-652 closeout baseline.",
  ]);
  await addMinutes(dshProjectId, "DSH-JOI-MIN-20261116-RELEASE021", "0.2.1 visual acceptance and release authorization", [
    "Keep the channel theme reproducible.",
    "Owner explicitly authorized publishing dsh-joi-channel-theme 0.2.1.",
  ]);

  const read = async (query, projectId) => {
    let raw = "";
    const args = ["recall", "--workspace", root, "--at", at, "--query", query, "--view", "agent"];
    if (projectId !== undefined) args.push("--project-id", projectId);
    await runCli(args, { write(value) { raw += value; } });
    return JSON.parse(raw);
  };
  const release = await read("E 和 M 5.0.0 有哪些发布依据？", emProjectId);
  assert.ok(release.context[0].includes("TCRN-CROSS-MIN-20261116-EM-500-RELEASED"), release.context[0]);
  assert.ok(release.context[0].includes("D1 现行有效"), release.context[0]);
  assert.ok(release.context[0].includes(`minutes-show --id ${deriveStableId("minutes", "TCRN-CROSS-MIN-20261116-EM-500-RELEASED")}#D1`), release.context[0]);
  const localAction = release.context.findIndex((line) => line.includes("TCRN-CROSS-MIN-20261117-EM-500-LOCAL-UPDATE"));
  if (localAction >= 0) assert.ok(localAction > 0, "the one-time local update is not the first release basis");

  const historical = await read("Einzbern PR #17 当时为什么建议合并？", emProjectId);
  assert.ok(historical.context[0].includes("TCRN-CROSS-MIN-282"), historical.context[0]);
  assert.ok(historical.context[0].includes("D1 历史问题；非现行行动"), historical.context[0]);
  assert.ok(historical.context[0].includes(`${deriveStableId("minutes", "TCRN-CROSS-MIN-282")}#D1`), historical.context[0]);

  const synonym = await read("Einzbern PR #17 当初为何获得合并建议？", emProjectId);
  assert.ok(synonym.context[0].includes("TCRN-CROSS-MIN-282"), synonym.context[0]);
  assert.ok(synonym.context[0].includes("D1 历史问题；非现行行动"), synonym.context[0]);

  const budget = await read("Mana Orchestrate 的 SKILL.md 字节预算是多少？", emProjectId);
  assert.ok(budget.context[0].includes("TCRN-CROSS-MIN-20261113-EM-PHASED-PLAN"), budget.context[0]);
  assert.ok(budget.context[0].includes("D4 现行有效"), budget.context[0]);
  assert.ok(budget.context[0].includes("6000 字节"), budget.context[0]);
  assert.ok(budget.context[0].includes(`${deriveStableId("minutes", "TCRN-CROSS-MIN-20261113-EM-PHASED-PLAN")}#D4`), budget.context[0]);

  const negativeQuery = "DSH-JOI-MIN-20261116-RELEASE021#D2 的发布授权是什么？";
  const scopedNegative = await read(negativeQuery, emProjectId);
  assert.equal(scopedNegative.context.length, 0);
  const unscopedNegative = await read(negativeQuery);
  assert.ok(unscopedNegative.context[0].includes("DSH-JOI-MIN-20261116-RELEASE021"), unscopedNegative.context[0]);
  assert.ok(unscopedNegative.context[0].includes(`${deriveStableId("minutes", "DSH-JOI-MIN-20261116-RELEASE021")}#D2`), unscopedNegative.context[0]);
  assert.ok(Buffer.byteLength([...release.context, ...historical.context, ...budget.context].join("\n")) <= 4800);
});
