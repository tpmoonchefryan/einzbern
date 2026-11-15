// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { serialize } from "node:v8";
import { deflateSync } from "node:zlib";
import { initializeLibrary, createProject, cachePath } from "../dist/build/packages/core/src/index.js";
import { RecallIndex, recallPersistent, resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { withRecallObservation } from "../dist/build/packages/core/src/recall-observation.js";

const at = "2026-11-14T18:00:00Z";
const columns = "title, body, tags, expansions, externalKey, proseTitle, proseBody, proseTags, proseExpansions";
const doc = (id, fields = {}) => ({ id, kind: "card", key: `FTS095-${id}`, status: "active", title: "Alloy calibration", body: "alloy sensor", tags: "", expansions: "", summary: "Public summary", recordKind: "card", parentChain: [], lead: "", ...fields });
const documents = [
  doc("1", { title: "Café 合金传感器 🧪", body: "calibrate AlloySensor_v2 alloy alloy", tags: "合金", expansions: "sensor calibration" }),
  doc("2", { title: "", body: "alloy", tags: "", expansions: "" }),
  doc("3", { kind: "minutes", key: "FTS095-MIN-3", title: "Calibration decisions", body: "alloy sensor decisions", decisions: [
    { number: 1, text: "Keep obsolete alloy setting", reference: "minutes:3#D1", scope: "sensor", status: "obsolete", supersededBy: "minutes:3#D2" },
    { number: 2, text: "Use current alloy calibration", reference: "minutes:3#D2", scope: "sensor", status: "valid" },
  ] }),
];

async function directory(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "fts095-")));
  t.after(async () => { resetRecallCache(); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

// Observe actual production connections without exporting a decoder or test API.
function connections(t) {
  const seen = [];
  const exec = DatabaseSync.prototype.exec;
  const register = DatabaseSync.prototype.function;
  t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
    if (sql.includes("CREATE TABLE recall_fts_content")) seen.push(this);
    return exec.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "function", function (...args) {
    if (args[0] === "recall_fts_text") seen.push(this);
    return register.apply(this, args);
  });
  return seen;
}

function integrity(database) {
  for (const table of ["recall_index", "recall_prose"]) database.exec(`INSERT INTO ${table}(${table}, rank) VALUES('integrity-check', 1)`);
}

test("095 FTS storage: real external-content text, BM25, Unicode, clauses and same-head delta equal the plain index", async t => {
  const root = await directory(t), seen = connections(t);
  const plain = new RecallIndex(documents, "fixed-head");
  const packed = new RecallIndex(documents, "fixed-head", join(root, "index.sqlite"));
  t.after(() => { plain.close(); packed.close(); });
  const [original, compressed] = seen;
  assert.deepEqual(compressed.prepare(`SELECT rowId, ${columns} FROM recall_fts_content`).all(), original.prepare(`SELECT rowId, ${columns} FROM recall_fts_content`).all());
  for (const query of ["alloy", "café", "合金", "AlloySensor_v2", "FTS095-MIN-3#D2", "FTS095-MIN", ""]) assert.deepEqual(packed.search(query), plain.search(query), query);
  for (const table of ["recall_index", "recall_prose"]) {
    const sql = `SELECT rowid, title, body, tags, expansions, bm25(${table}) AS score FROM ${table} WHERE ${table} MATCH ? ORDER BY score, rowid`;
    for (const query of ["alloy", "café", "合金", "alloy*"]) assert.deepEqual(compressed.prepare(sql).all(query), original.prepare(sql).all(query));
  }
  integrity(compressed);
  const before = compressed.prepare("SELECT rowId, payload FROM recall_fts_payload ORDER BY rowId").all();
  const added = doc("4", { body: "extra alloy" });
  for (const index of [plain, packed]) assert.deepEqual(index.update([...documents, added], "fixed-head"), { inserted: 1, removed: 0 });
  assert.deepEqual(compressed.prepare("SELECT rowId, payload FROM recall_fts_payload WHERE rowId <= 3 ORDER BY rowId").all(), before);
  for (const index of [plain, packed]) assert.deepEqual(index.update(documents, "fixed-head"), { inserted: 0, removed: 1 });
  assert.deepEqual(compressed.prepare("SELECT rowId, payload FROM recall_fts_payload ORDER BY rowId").all(), before);
  assert.deepEqual(packed.update(documents, "fixed-head"), { inserted: 0, removed: 0 });
  assert.deepEqual(packed.search("alloy"), plain.search("alloy"));
  integrity(compressed);
});

function frame(fields) {
  const data = serialize(fields), header = Buffer.alloc(12);
  header.write("EFT1"); header.writeDoubleLE(data.length, 4);
  return Buffer.concat([header, deflateSync(data)]);
}

test("095 FTS storage: NULL versus empty prose and a legal large row round trip through SQLite", async t => {
  const root = await directory(t), seen = connections(t);
  const large = doc("large", { body: "alloy " + "🧪".repeat(300000) });
  const index = new RecallIndex([large], "head", join(root, "large.sqlite"));
  t.after(() => index.close());
  const database = seen[0];
  assert.equal(database.prepare("SELECT body FROM recall_fts_content").get().body, large.body);
  integrity(database);
  const fields = ["base", "body", "tags", "expansions", "external key", null, "", null, ""];
  database.prepare("UPDATE recall_fts_payload SET payload = ?").run(frame(fields));
  const row = database.prepare(`SELECT ${columns} FROM recall_fts_content`).get();
  assert.deepEqual(Object.values(row), fields);
  assert.deepEqual(Object.values(database.prepare("SELECT title, body, tags, expansions FROM recall_prose_view").get()), ["base", "", "tags", ""]);
});

test("095 FTS storage: malformed frames fail the complete external-content query and FTS integrity check", async t => {
  const root = await directory(t), seen = connections(t);
  const index = new RecallIndex(documents, "head", join(root, "malformed.sqlite"));
  t.after(() => index.close());
  const database = seen[0], good = Buffer.from(database.prepare("SELECT payload FROM recall_fts_payload WHERE rowId = 1").get().payload);
  const header = Buffer.from(good); header[0] |= 0x80;
  const length = Buffer.from(good); length.writeDoubleLE(length.readDoubleLE(4) + 1, 4);
  const shortLength = Buffer.from(good); shortLength.writeDoubleLE(1, 4);
  const hugeLength = Buffer.from(good); hugeLength.writeDoubleLE(Infinity, 4);
  const corrupt = Buffer.from(good); corrupt[corrupt.length - 1] ^= 1;
  const malformed = ["not a blob", 7, Buffer.alloc(0), header, length, shortLength, hugeLength, good.subarray(0, -1), corrupt, Buffer.concat([good, Buffer.from([0])]), frame({ title: "object" }), frame(["missing"]), frame(["a", 3, "", "", "", null, null, null, null]), frame(["a", "", "", "", "", false, null, null, null])];
  for (const payload of malformed) {
    database.prepare("UPDATE recall_fts_payload SET payload = ? WHERE rowId = 1").run(payload);
    assert.throws(() => database.prepare("SELECT title, body FROM recall_index WHERE recall_index MATCH 'alloy'").all());
    assert.throws(() => integrity(database));
  }
  database.prepare("UPDATE recall_fts_payload SET payload = ? WHERE rowId = 1").run(good);
  integrity(database);
});

test("095 FTS storage: close and fresh-process reopen, unchanged bytes, old format and engine/schema/binding invalidation", async t => {
  const base = await directory(t), home = join(base, "device"), root = join(base, "library"), previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = home;
  t.after(() => { process.env.EINZBERN_HOME = previous; });
  await initializeLibrary({ root, createdAt: at, libraryId: "library:000000000000000000095018" });
  const state = await createProject(root, { externalKey: "FTS095-PROJECT", name: "FTS storage", occurredAt: at });
  const request = { cacheKey: "fts095-storage", checkpoint: "fixed-head", query: "alloy", documents: () => documents, tau: 0 };
  const cold = await recallPersistent(request, root);
  resetRecallCache();
  const dir = cachePath(state.metadata.workspaceId), file = join(dir, (await fs.readdir(dir)).find(p => p.endsWith(".sqlite")));
  const bytes = await fs.readFile(file);
  const script = `import {recallPersistent,resetRecallCache} from ${JSON.stringify(new URL("../dist/build/packages/core/src/recall.js", import.meta.url).href)};import {withRecallObservation} from ${JSON.stringify(new URL("../dist/build/packages/core/src/recall-observation.js", import.meta.url).href)};const docs=${JSON.stringify(documents)};console.log(JSON.stringify(await withRecallObservation(()=>recallPersistent({cacheKey:"fts095-storage",checkpoint:"fixed-head",query:"alloy",documents:()=>docs,tau:0},${JSON.stringify(root)}))));resetRecallCache();`;
  for (let n = 0; n < 2; n++) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, EINZBERN_HOME: home } });
    assert.equal(child.status, 0, child.stderr);
    const reopened = JSON.parse(child.stdout);
    assert.deepEqual(reopened.value.records, cold.records);
    assert.ok(reopened.observation.cacheReasons.includes("fts-persistent-hit"));
    assert.deepEqual(await fs.readFile(file), bytes);
  }
  const proofs = join(home, "derived-projections", state.metadata.workspaceId.replace(":", "-"));
  for (const [field, value] of [["binding", "record-clause-fts-v17"], ["engine", "old-engine"], ["schemaVersion", "old-schema"], ["binding", "old-binding"]]) {
    for (const name of (await fs.readdir(proofs)).filter(p => p.startsWith("recall-") && p.endsWith(".json"))) {
      const path = join(proofs, name), proof = JSON.parse(await fs.readFile(path, "utf8"));
      proof[field] = value;
      await fs.writeFile(path, JSON.stringify(proof));
    }
    const rebuilt = await withRecallObservation(() => recallPersistent(request, root));
    assert.deepEqual(rebuilt.value.records, cold.records);
    assert.ok(rebuilt.observation.cacheReasons.some(p => p.startsWith("fts-persistent-build:")));
    resetRecallCache();
  }
  // Authenticated full-file SHA rejects a damaged compressed row before reuse.
  const database = new DatabaseSync(file);
  database.prepare("UPDATE recall_fts_payload SET payload = ? WHERE rowId = 1").run(Buffer.from("broken compressed payload"));
  database.close();
  const repaired = await withRecallObservation(() => recallPersistent(request, root));
  assert.deepEqual(repaired.value.records, cold.records);
  assert.ok(repaired.observation.cacheReasons.includes("fts-persistent-invalid-or-busy"));
  resetRecallCache();
  // Lack of SQL UDF support must still reach the complete plain-memory fallback.
  t.mock.method(DatabaseSync.prototype, "function", () => { throw new Error("unsupported UDF"); });
  const fallback = await withRecallObservation(() => recallPersistent(request, root));
  assert.deepEqual(fallback.value.records, cold.records);
  assert.ok(fallback.observation.cacheReasons.includes("fts-persistent-fallback-memory"));
  assert.equal(createHash("sha256").update(await fs.readFile(file)).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
});
