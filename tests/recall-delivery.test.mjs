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
  const current = await read("DELIVERY-MIN-1#D8 SubagentStop");
  assert.equal(current.schemaVersion, "tcrn.recall-agent.v1");
  assert.ok(current.context.some((line) => line.includes("D8 现行有效") && line.includes("retires the collector slot")));
  assert.ok(current.context.every((line) => !line.includes("must retain the amber audit log")));
  const predecessor = state.minutes.find((r) => r.externalKey === minutes.externalKey);
  const historical = await read("历史 DELIVERY-MIN-1#D2", ["--status", "all"]);
  assert.ok(historical.context.some((line) => line.includes("D2 历史已失效") && line.includes(`${predecessor.id}#D2`) && line.includes("must retain")));
});
