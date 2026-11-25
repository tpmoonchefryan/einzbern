// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { captureKnowledgeUnit, createProject, createWork, initializeKnowledgeStore, initializeLibrary, recordMinutes, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import { RecallIndex, recall, recallDocuments, recallQueryTokens, recallScoreUnit, resetRecallCache, segmentForIndex } from "../dist/build/packages/core/src/recall.js";
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

test("the recall preview explains the same scored selection and shows a near miss", () => {
  const titles = ["Violet violet violet habitat", "Violet habitat", ...Array.from({ length: 16 }, (_, index) => `Unrelated fossil ${index}`)];
  const documents = titles.map((title, index) => ({
    kind: "work", id: `work:${String(index).padStart(24, "0")}`, key: `EVAL-STORY-${index}`, status: "active",
    title, body: "", tags: "", expansions: "", summary: "Field notes", recordKind: "Story", parentChain: [], lead: "",
  }));
  try {
    const request = { cacheKey: "preview", checkpoint: "preview", query: "violet unmatchedneedle", documents: () => documents };
    const unfiltered = recall({ ...request, tau: 0 });
    assert.deepEqual(unfiltered.records.map((hit) => hit.key), ["EVAL-STORY-0", "EVAL-STORY-1"]);
    const [first, second] = unfiltered.records;
    const tau = (first.score + second.score) / (2 * recallScoreUnit(documents.length));
    const normal = recall({ ...request, tau });
    const preview = recall({ ...request, tau, explain: true });
    assert.equal(normal.explanation, undefined);
    assert.deepEqual(preview.records, normal.records);
    assert.deepEqual(preview.explanation.nearMisses.map((hit) => hit.id), [second.id]);
    assert.ok(second.score < preview.explanation.threshold && preview.explanation.threshold < first.score);
    assert.deepEqual([...preview.explanation.matchedTerms], [[first.id, ["violet"]], [second.id, ["violet"]]]);
    const empty = recall({ ...request, query: "unmatchedneedle", tau, explain: true });
    assert.equal(empty.reasonCode, "RECALL_NO_STRONG_HIT");
    assert.deepEqual([empty.records, empty.explanation.nearMisses], [[], []]);
    const named = recall({ ...request, query: first.key, tau: 100, explain: true });
    assert.deepEqual(named.explanation.matchedTerms.get(first.id), [first.key]);
  } finally {
    resetRecallCache();
  }
});

test("candidate references batch-read their own content and expand only on request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "recall-candidate-read-"));
  t.after(async () => { resetRecallCache(); await rm(root, { recursive: true, force: true }); });
  await initializeLibrary({ root, createdAt: at });
  const project = (await createProject(root, { occurredAt: at, externalKey: "READ-PROJECT", name: "Reference reading" })).projects[0];
  const common = { occurredAt: at, projectId: project.id };
  const parentKey = "READ-INIT-001";
  const parent = (await createWork(root, { ...common, externalKey: parentKey, kind: "Initiative", parentId: null, title: "Routing governance", goal: "Keep the parent rule" })).work[0];
  const epicKey = "READ-EPIC-001";
  const epic = (await createWork(root, { ...common, externalKey: epicKey, kind: "Epic", parentId: parent.id, title: "Public endpoint work" })).work.find((item) => item.externalKey === epicKey);
  const storyKey = "READ-STORY-001";
  const body = "Convergence retains the original checkpoint. ".repeat(220);
  const story = (await createWork(root, { ...common, externalKey: storyKey, kind: "Story", parentId: epic.id, title: "Convergence validation",
    goal: "Validate the replay", acceptance: "A resumed reader sees the same result", body })).work.find((item) => item.externalKey === storyKey);
  const recorded = await recordMinutes(root, { ...common, externalKey: "READ-MIN-501", title: "Public API decisions", summary: "Review of two independent endpoints",
    decisions: ["Use a stable routing address.", "Review read policy on project scope."], decidedBy: [], linkedWorkIds: [] });
  const minutesId = recorded.minutes.find((item) => item.externalKey === "READ-MIN-501").id;
  await initializeKnowledgeStore(root, { disposableAcknowledged: true });
  const card = await captureKnowledgeUnit(root, { occurredAt: at, externalKey: "READ-CARD-001", subject: "Ledger notice",
    summary: "Retain a notice", snippet: "Ledger notice", tags: ["ledger"], accountableOwnerId: "owner:test",
    scope: "project", projectId: project.id, body: "A ledger notice should preserve the original record." });
  const user = await captureKnowledgeUnit(root, { occurredAt: at, externalKey: "READ-CARD-USER-001", subject: "Personal rehearsal",
    summary: "Personal reading note", snippet: "Rehearsal", tags: ["rehearsal"], accountableOwnerId: "owner:test",
    scope: "user", body: "A rehearsal reminder from the personal crest." });

  const call = async (verb, args) => {
    let output = "";
    await runCli([verb, "--workspace", root, "--at", at, ...args], { write(chunk) { output += chunk; } });
    return JSON.parse(output);
  };
  const query = ["--query", `${storyKey} READ-MIN-501#D2`, "--view", "candidates"];
  const candidates = await call("recall", query);
  assert.equal(candidates.schemaVersion, "tcrn.recall-candidates.v1");
  assert.deepEqual(candidates.context, [
    `Story · ${storyKey} · Convergence validation · ${story.id}`,
    `minutes · READ-MIN-501 · Public API decisions · ${minutesId}#D2`,
  ]);
  assert.deepEqual((await call("recall", query)).context, candidates.context);

  const missing = "work:000000000000000000000000";
  const chosen = [`${minutesId}#D2`, story.id, card.id, `user/${user.id}`, missing];
  const flags = ["--refs", chosen.join(",")];
  const direct = await call("recall-read", flags);
  assert.deepEqual(direct.records.map((row) => row.ref), chosen);
  assert.deepEqual(direct.records[0].record.decisions.map((row) => row.number), [2]);
  assert.equal(direct.records[1].record.fields.body, body);
  assert.ok(Buffer.byteLength(direct.records[1].record.fields.body) > candidates.perPromptBytes);
  assert.equal(direct.records[1].context, undefined);
  assert.equal(direct.records[2].record.body, "A ledger notice should preserve the original record.");
  assert.equal(direct.records[3].record.body, "A rehearsal reminder from the personal crest.");
  assert.deepEqual([direct.records[4].ok, direct.records[4].reasonCode], [false, "WORKSPACE_INPUT_INVALID"]);
  const full = await call("recall-read", [...flags, "--full", "true"]);
  assert.deepEqual(full.records[0].record.decisions.map((row) => row.number), [1, 2]);
  assert.deepEqual(full.records[1].context.records.map((row) => row.workId), [story.id, epic.id, parent.id]);
  assert.equal(full.headEventHash, direct.headEventHash);
});

test("minutes search shares recall matching and preserves original text through the metadata switch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "recall-minutes-search-"));
  t.after(async () => { resetRecallCache(); await rm(root, { recursive: true, force: true }); });
  await initializeLibrary({ root, createdAt: at });
  const project = (await createProject(root, { occurredAt: at, externalKey: "MINUTES-SEARCH-PROJECT", name: "Minutes search" })).projects[0];
  const common = { occurredAt: at, projectId: project.id };
  await setWorkspaceSetting(root, { occurredAt: at, key: "retrieval.tau", value: "0" });
  const text = "Keep the plexitarian original passage.";
  const record = (await recordMinutes(root, {
    ...common, externalKey: "SEARCH-MIN-601", title: "Relay inventory", summary: "Review the inventory",
    decisions: [text], decisionMetadata: [{ title: "Auroral retention", tags: ["lumencompat"] }], decidedBy: [], linkedWorkIds: [],
  })).minutes[0];
  const call = async (verb, args) => {
    let output = "";
    await runCli([verb, "--workspace", root, ...args], { write(chunk) { output += chunk; } });
    return JSON.parse(output);
  };
  const minuteIds = async query => (await call("minutes-list", ["--query", query, "--project-id", project.id])).records.map(row => row.id);
  const recallRefs = async query => (await call("recall", ["--query", query, "--project-id", project.id, "--view", "candidates", "--at", at])).context;
  const expected = `minutes · SEARCH-MIN-601 · Auroral retention · ${record.id}#D1`;
  for (const query of ["lumencompat", "SEARCH-MIN-601#D1", "Auroral retention", "Relay inventory", "plexitarian"]) {
    assert.deepEqual(await minuteIds(query), [record.id]);
    assert.deepEqual(await recallRefs(query), [expected]);
  }

  await setWorkspaceSetting(root, { occurredAt: at, key: "retrieval.minutesMetadataOnly", value: "true", authorization: { surface: "atelier" } });
  assert.deepEqual(await minuteIds("plexitarian"), []);
  assert.deepEqual(await recallRefs("plexitarian"), []);
  for (const query of ["lumencompat", "SEARCH-MIN-601#D1", "Auroral retention", "Relay inventory"]) {
    assert.deepEqual(await minuteIds(query), [record.id]);
    assert.deepEqual(await recallRefs(query), [expected]);
  }
  const read = await call("recall-read", ["--refs", `${record.id}#D1`, "--at", at]);
  assert.equal(read.records[0].record.decisions[0].text, text);
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
