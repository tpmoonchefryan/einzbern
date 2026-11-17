#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Clause delivery is measured through runCli's normal agent view. Ranking is diagnostic only.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { appendEvents, buildEventPayload, createProject, createWork, initializeLibrary, materializeWorkspaceFromGenesis, recordMinutes, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import { resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { declarationsFromInput, decisionTopicConflicts } from "../dist/build/packages/core/src/minutes.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { scanPrivacyEntries } from "./lib/privacy.mjs";
import { recordCorpus } from "./retrieval-eval-record.mjs";

const root = resolve(import.meta.dirname, "..");
const fixtures = resolve(root, "tests/fixtures/retrieval-eval");
const at = "2026-11-13T10:00:00Z";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sourceId = (key) => deriveStableId("minutes", key);

export async function readDeliveryFreeze(directory = fixtures, declared) {
  declared ??= (await readJson(resolve(root, "scripts/policy/retrieval-eval-thresholds.json"))).decisionDelivery;
  const manifestBytes = await readFile(join(directory, declared.manifest));
  if (sha(manifestBytes) !== declared.manifestDigest) throw new Error("RETRIEVAL_EVAL_DELIVERY_MANIFEST_CHANGED");
  const manifest = JSON.parse(manifestBytes);
  const bytes = await readFile(join(directory, manifest.fixture));
  if (sha(bytes) !== manifest.sha256) throw new Error("RETRIEVAL_EVAL_DELIVERY_CORPUS_CHANGED");
  const cases = JSON.parse(bytes);
  if (JSON.stringify(cases.floors) !== JSON.stringify(declared.floors)) throw new Error("RETRIEVAL_EVAL_DELIVERY_FLOORS_CHANGED");
  const owners = new Map();
  for (const source of cases.sources) {
    for (const identity of source.identityDigests) {
      if (owners.has(identity) && owners.get(identity) !== source.split) throw new Error("RETRIEVAL_EVAL_DELIVERY_SOURCE_OVERLAP");
      owners.set(identity, source.split);
    }
  }
  const ids = new Set();
  for (const entry of cases.cases) {
    if (ids.has(entry.id)) throw new Error("RETRIEVAL_EVAL_DELIVERY_CASE_DUPLICATE");
    ids.add(entry.id);
    if (entry.source && !cases.sources.some((source) => source.key === entry.source && source.split === entry.split)) throw new Error("RETRIEVAL_EVAL_DELIVERY_SPLIT_INVALID");
  }
  if (ids.size !== manifest.cases) throw new Error("RETRIEVAL_EVAL_DELIVERY_COUNT_CHANGED");
  for (const [split, frozen] of Object.entries(manifest.splits)) {
    const entries = cases.cases.filter((entry) => entry.split === split);
    if (entries.length !== frozen.cases || sha(JSON.stringify(entries)) !== frozen.digest) throw new Error("RETRIEVAL_EVAL_DELIVERY_SPLIT_CHANGED");
    const sources = cases.sources.filter((source) => source.split === split).map(({ key, identityDigests, contentDigest }) => ({ key, identityDigests, contentDigest }));
    if (JSON.stringify(sources) !== JSON.stringify(frozen.sources)) throw new Error("RETRIEVAL_EVAL_DELIVERY_SOURCE_CHANGED");
  }
  const findings = scanPrivacyEntries([{ label: "decision-delivery-cases.json", kind: "source", content: bytes.toString("utf8") }], { owner: "evaluation-fixture" });
  if (findings.length) throw new Error(`RETRIEVAL_EVAL_DELIVERY_PRIVATE: ${findings.join(", ")}`);
  return { manifest, cases };
}

async function treeDigest(directory) {
  const hash = createHash("sha256");
  async function visit(path, prefix) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(path, entry.name), `${name}/`);
      else if (entry.isFile()) hash.update(name).update(await readFile(join(path, entry.name)));
      else throw new Error("RETRIEVAL_EVAL_DELIVERY_SOURCE_NOT_REGULAR");
    }
  }
  await visit(directory, "");
  return hash.digest("hex");
}

async function makeLibrary(path, sources) {
  await initializeLibrary({ root: path, createdAt: at });
  const projectId = (await createProject(path, { occurredAt: at, externalKey: "EVAL-PROJECT", name: "Decision delivery" })).projects[0].id;
  const init = await createWork(path, { occurredAt: at, projectId, externalKey: "EVAL-INIT-1", kind: "Initiative", parentId: null, title: "Evaluation fixture", goal: "Observe clause delivery" });
  const parentId = init.work.find((record) => record.externalKey === "EVAL-INIT-1").id;
  const epic = await createWork(path, { occurredAt: at, projectId, externalKey: "EVAL-EPIC-1", kind: "Epic", parentId, title: "Source snapshot", goal: "Retain the frozen source corpus" });
  for (const source of sources) await importSnapshotMinutes(path, { ...source, title: source.title }, projectId);
  return { projectId, initiativeId: parentId, parentId: epic.work.find((record) => record.externalKey === "EVAL-EPIC-1").id };
}

async function importSnapshotMinutes(path, source, projectId) {
  // Snapshot records are independent public regression sources. Coexistence here admits
  // their overlapping prose into this disposable fixture; it makes no live-chain claim.
  const { materializeWorkspace } = await import("../dist/build/packages/core/src/workspace.js");
  const state = await materializeWorkspace(path);
  const id = sourceId(source.key);
  const declarations = declarationsFromInput({ supersedes: source.supersedes ?? [] }, id);
  const coexists = [...new Set(decisionTopicConflicts(state, { id, projectId, decisions: source.decisions,
    ...(declarations ? { declarations } : {}) }).map((conflict) => conflict.decision))];
  return recordMinutes(path, { occurredAt: at, externalKey: source.key, projectId, title: source.title, summary: source.summary,
    decisions: source.decisions, decidedBy: [], linkedWorkIds: [], coexists, ...(source.supersedes ? { supersedes: source.supersedes } : {}) });
}

async function addBackground(path, binding, from, to, background) {
  const work = background.work.slice(from, to);
  if (work.length) {
    // As the repository's historical-work fixture does, import the known projection
    // through append/replay. Modern completion admission cannot certify old evidence.
    await appendEvents(path, work.map((entry, offset) => (state) => {
      const externalKey = `EVAL-BACKGROUND-${from + offset + 1}`;
      const extensions = Object.fromEntries([["scope", entry.scope], ["goal", entry.goal], ["body", entry.body]]
        .filter(([, value]) => typeof value === "string" && value.length > 0).map(([key, value]) => [`advisory:${key}`, { required: false, value }]));
      const record = {
        schemaVersion: "tcrn.work.v1", id: deriveStableId("work", externalKey), externalKey, projectId: binding.projectId,
        kind: entry.kind, parentId: entry.kind === "Epic" ? binding.initiativeId : entry.kind === "Story" ? binding.parentId : null,
        status: entry.status, revision: 1, updatedAt: at, tombstone: false, extensions, scopeDigest: canonicalSha256(extensions),
        title: entry.title, summary: entry.summary, createdAt: at, labels: entry.labels,
      };
      return { payload: buildEventPayload("work.created", record), projects: state.projects, work: [...state.work, record] };
    }), { occurredAt: at });
  }
  for (let index = Math.max(from, background.work.length); index < to; index += 1) {
    const entry = background.minutes[index - background.work.length];
    if (!entry) throw new Error("RETRIEVAL_EVAL_DELIVERY_BACKGROUND_EXHAUSTED");
    await importSnapshotMinutes(path, { key: `EVAL-BACKGROUND-MIN-${index}`, title: entry.conferenceTitle, summary: entry.summary, decisions: entry.decisions }, binding.projectId);
  }
}

export function deliveryObservation(entry, full, agent, sources) {
  const context = agent.context ?? [];
  const id = entry.source ? sourceId(entry.source) : null;
  const reference = id === null ? null : `${id}#D${entry.decision}`;
  const positive = entry.source !== undefined && !entry.allowEmpty;
  const rank = full.records.findIndex((record) => record.id === id);
  const expectedLine = full.records.find((record) => record.id === id)?.line ?? "";
  const validLabel = entry.obsolete ? "历史已失效" : entry.category === "historical" ? "历史问题" : "现行有效";
  const delivered = positive && context.some((line) => line.includes(entry.source) && line.includes(`D${entry.decision} ${validLabel}`)
    && line.includes(reference) && line.includes(`minutes-show --id ${reference}`) && line.includes(entry.excerpt) && line.includes("范围 "));
  const obsolete = [...sources.flatMap((source) => source.supersedes ?? []).map((item) => item.decision), ...(entry.forbiddenCurrent ?? [])];
  const obsoleteCurrent = context.some((line) => obsolete.some((key) => {
    const [record, clause] = key.split("#");
    return line.includes(`minutes-show --id ${sourceId(record)}#${clause}`) && line.includes(`${clause} 现行有效`);
  }));
  const completeClause = reference !== null && expectedLine.includes(`minutes-show --id ${reference}`) && expectedLine.includes(entry.excerpt);
  return {
    caseId: entry.id, category: entry.category, split: entry.split, positive,
    recordTop3: positive && rank >= 0 && rank < 3, delivered,
    budgetUndelivered: positive && rank >= 0 && completeClause && !delivered && !context.includes(expectedLine),
    rankedWithoutClause: positive && rank >= 0 && !completeClause,
    obsoleteCurrent, historical: entry.category === "historical", historyCorrect: entry.category === "historical" && delivered,
    legalEmpty: Boolean(entry.allowEmpty) && context.length === 0,
    invalidVacuum: positive && context.length === 0,
    negative: entry.category.startsWith("negative"), negativeInjected: entry.category.startsWith("negative") && context.length > 0,
    bytes: Buffer.byteLength(context.join("\n"), "utf8"), budget: full.perPromptBytes,
    context, ranked: full.records.slice(0, 3).map(({ id: recordId, key, line }) => ({ id: recordId, key, line })),
  };
}

function metrics(rows) {
  const count = (field) => rows.filter((row) => row[field]).length;
  const positives = count("positive");
  return { cases: rows.length, positives, recordTop3: count("recordTop3"), delivered: count("delivered"),
    budgetUndelivered: count("budgetUndelivered"), rankedWithoutClause: count("rankedWithoutClause"), obsoleteCurrent: count("obsoleteCurrent"),
    historical: count("historical"), historyCorrect: count("historyCorrect"), legalEmpty: count("legalEmpty"),
    invalidVacuum: count("invalidVacuum"), negatives: count("negative"), negativeInjected: count("negativeInjected"),
    deliveryRate: positives ? count("delivered") / positives : null };
}

async function scoreLibrary(path, split, size, out) {
  const { cases: fixture } = await readDeliveryFreeze();
  const cases = fixture.cases.filter((entry) => entry.split === split);
  const sources = fixture.sources.filter((source) => source.split === split);
  const rows = [];
  const state = await materializeWorkspaceFromGenesis(path);
  if (state.library?.rejectedEvents.length) throw new Error("RETRIEVAL_EVAL_DELIVERY_REJECTED_SOURCE_EVENTS");
  const expectedWork = 2 + Math.min(fixture.sizes[size], (await readJson(join(fixtures, "work-compact.json"))).records.length);
  if (state.work.length !== expectedWork) throw new Error("RETRIEVAL_EVAL_DELIVERY_SOURCE_COUNT_MISMATCH");
  // Read-only recording and normal CLI reads happen in a process guarded by fs-write-tripwire.
  const recording = await recordCorpus({ layout: "library", source: path, out: join(out, "recorded"), at, sample: 1, privateNames: [] });
  for (const entry of cases) {
    const args = ["recall", "--workspace", path, "--at", at, "--query", entry.query, ...(entry.status ? ["--status", entry.status] : [])];
    // An explicit small budget is a separate fixture library; scoring never changes its chain.
    if (entry.budget !== undefined) continue;
    let fullRaw;
    let agentRaw;
    await runCli(args, { write(value) { fullRaw = value; } });
    await runCli([...args, "--view", "agent"], { write(value) { agentRaw = value; } });
    rows.push(deliveryObservation(entry, JSON.parse(fullRaw), JSON.parse(agentRaw), sources));
    await writeFile(join(out, `${entry.id}.json`), json({ argv: [...args.slice(0, 1), "--workspace", "<fixture>", ...args.slice(3), "--view", "agent"], full: JSON.parse(fullRaw), agent: JSON.parse(agentRaw) }));
  }
  resetRecallCache();
  return { size, split, sourceRecords: state.work.length + state.minutes.length, rejectedSourceEvents: 0,
    recording: { counts: recording.counts, source: recording.source }, metrics: metrics(rows),
    categories: Object.fromEntries([...new Set(rows.map((row) => row.category))].map((category) => [category, metrics(rows.filter((row) => row.category === category))])), rows };
}

export async function evaluateDelivery({ splits = ["development", "tuning", "holdout"], out } = {}) {
  const { manifest, cases: fixture } = await readDeliveryFreeze();
  const temporary = out === undefined;
  const output = out === undefined ? await mkdtemp(join(tmpdir(), "einzbern-delivery-eval-")) : resolve(out);
  await mkdir(output, { recursive: true });
  const previousHome = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(output, "device");
  const reports = [];
  try {
    const background = { work: (await readJson(join(fixtures, "work-compact.json"))).records,
      minutes: (await readJson(join(fixtures, "minutes-compact.json"))).records.filter((record) => !fixture.sources.some((source) => source.identityDigests.includes(sha(record.id)))) };
    for (const split of splits) {
      if (!manifest.splits[split]) throw new Error("RETRIEVAL_EVAL_DELIVERY_SPLIT_INVALID");
      const sources = fixture.sources.filter((source) => source.split === split);
      const path = join(output, `${split}-library`);
      const binding = await makeLibrary(path, sources);
      let count = 0;
      for (const [size, target] of Object.entries(fixture.sizes)) {
        if (target > count) await addBackground(path, binding, count, target, background);
        count = target;
        const directory = join(output, `${split}-${size}`);
        await mkdir(directory);
        const before = await treeDigest(path);
        const child = spawnSync(process.execPath, ["--import", new URL("../tests/helpers/fs-write-tripwire.mjs", import.meta.url).href, fileURLToPath(import.meta.url), "--read", path, "--split", split, "--size", size, "--out", directory], {
          encoding: "utf8", env: { ...process.env, EINZBERN_TRIPWIRE_ROOT: path }, maxBuffer: 32 * 1024 * 1024,
        });
        await writeFile(join(directory, "stdout.json"), child.stdout ?? "");
        await writeFile(join(directory, "stderr.log"), child.stderr ?? "");
        const after = await treeDigest(path);
        if (child.status !== 0 || child.error) throw new Error(`RETRIEVAL_EVAL_DELIVERY_CHILD_FAILED: ${child.status}: ${child.stderr ?? child.error}`);
        const report = JSON.parse(child.stdout);
        report.zeroChainWrite = before === after;
        report.chainDigest = before;
        if (!report.zeroChainWrite) throw new Error("RETRIEVAL_EVAL_DELIVERY_CHAIN_CHANGED");
        reports.push(report);
      }
      // The tiny-budget fixture verifies a legitimate empty result through the real setting/CLI.
      const entry = fixture.cases.find((item) => item.split === split && item.budget !== undefined);
      if (entry) {
        await setWorkspaceSetting(path, { occurredAt: at, key: "injection.perPromptBytes", value: String(entry.budget) });
        let raw;
        await runCli(["recall", "--workspace", path, "--at", at, "--query", entry.query, "--view", "agent"], { write(value) { raw = value; } });
        reports.push({ split, size: "tiny-budget", metrics: { legalEmpty: JSON.parse(raw).context.length === 0 ? 1 : 0, cases: 1 }, rows: [{ caseId: entry.id, agent: JSON.parse(raw) }] });
      }
    }
  } finally {
    resetRecallCache();
    if (previousHome === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previousHome;
    if (temporary) await rm(output, { recursive: true, force: true });
  }
  const failures = [];
  for (const report of reports.filter((item) => item.size !== "tiny-budget")) {
    const m = report.metrics;
    const label = `${report.split}/${report.size}`;
    if (m.deliveryRate < fixture.floors.deliveryRate) failures.push(`${label}: delivery ${m.delivered}/${m.positives}`);
    if (m.invalidVacuum > 0) failures.push(`${label}: invalid-empty ${m.invalidVacuum}/${m.positives}`);
    if (m.historical && m.historyCorrect / m.historical < fixture.floors.historyRate) failures.push(`${label}: history ${m.historyCorrect}/${m.historical}`);
    if (m.obsoleteCurrent > fixture.floors.obsoleteCurrent) failures.push(`${label}: obsolete-current ${m.obsoleteCurrent}/${m.cases}`);
    if (m.negatives && m.negativeInjected / m.negatives >= fixture.floors.negativeRateBelow) failures.push(`${label}: negative ${m.negativeInjected}/${m.negatives}`);
    const exact = report.categories["exact-key"];
    if (exact && exact.deliveryRate < fixture.floors.exactRate) failures.push(`${label}: exact ${exact.delivered}/${exact.positives}`);
  }
  for (const report of reports.filter((item) => item.size === "tiny-budget")) if (!report.metrics.legalEmpty) failures.push(`${report.split}: legal-empty failed`);
  return { ok: failures.length === 0, reasonCode: failures.length ? "RETRIEVAL_EVAL_DELIVERY_FAILED" : "RETRIEVAL_EVAL_DELIVERY_VERIFIED", primaryMetric: "actual-agent-clause-delivery", manifestSha256: (await readJson(resolve(root, "scripts/policy/retrieval-eval-thresholds.json"))).decisionDelivery.manifestDigest,
    fixtureSha256: manifest.sha256, sourcePolicy: fixture.sourcePolicy, reports, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = (name) => process.argv[process.argv.indexOf(name) + 1];
  try {
    const result = process.argv.includes("--read")
      ? await scoreLibrary(resolve(value("--read")), value("--split"), value("--size"), resolve(value("--out")))
      : await evaluateDelivery({ ...(process.argv.includes("--splits") ? { splits: value("--splits").split(",") } : {}), ...(process.argv.includes("--out") ? { out: value("--out") } : {}) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: String(error.message) })}\n`);
    process.exitCode = 1;
  }
}
