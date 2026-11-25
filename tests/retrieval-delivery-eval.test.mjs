// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { deliveryObservation, readDeliveryFreeze } from "../scripts/retrieval-delivery-eval.mjs";
const fixtureRoot = new URL("./fixtures/retrieval-eval/", import.meta.url);
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function copyFreeze(t) {
  const directory = await mkdtemp(join(tmpdir(), "delivery-freeze-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policy = JSON.parse(await readFile(new URL("../scripts/policy/retrieval-eval-thresholds.json", import.meta.url))).decisionDelivery;
  const manifest = JSON.parse(await readFile(new URL(policy.manifest, fixtureRoot)));
  for (const name of [policy.manifest, manifest.fixture]) await writeFile(join(directory, name), await readFile(new URL(name, fixtureRoot)));
  return { directory, policy, manifest };
}

test("delivery freeze binds source-disjoint splits, bytes and independently pinned floors", async (t) => {
  const f = await copyFreeze(t);
  const result = await readDeliveryFreeze(f.directory, f.policy);
  assert.equal(result.manifest.cases, 62);
  assert.deepEqual(Object.keys(result.manifest.splits), ["development", "tuning", "holdout"]);
  await writeFile(join(f.directory, f.manifest.fixture), (await readFile(join(f.directory, f.manifest.fixture), "utf8")) + "\n");
  await assert.rejects(readDeliveryFreeze(f.directory, f.policy), /RETRIEVAL_EVAL_DELIVERY_CORPUS_CHANGED/u);
});

test("a reserialized manifest cannot silently rebind an existing freeze", async (t) => {
  const f = await copyFreeze(t);
  await writeFile(join(f.directory, f.policy.manifest), JSON.stringify(f.manifest));
  await assert.rejects(readDeliveryFreeze(f.directory, f.policy), /RETRIEVAL_EVAL_DELIVERY_MANIFEST_CHANGED/u);
});

test("privacy remains a separate refusal even when a malicious fixture is rehashed", async (t) => {
  const f = await copyFreeze(t);
  const fixture = JSON.parse(await readFile(join(f.directory, f.manifest.fixture), "utf8"));
  const entry = fixture.cases.find((item) => item.category === "negative");
  entry.query = join(homedir(), "private-fixture");
  const bytes = `${JSON.stringify(fixture, null, 2)}\n`;
  f.manifest.sha256 = sha(bytes);
  f.manifest.splits[entry.split].digest = sha(JSON.stringify(fixture.cases.filter((item) => item.split === entry.split)));
  const manifest = `${JSON.stringify(f.manifest, null, 2)}\n`;
  await writeFile(join(f.directory, f.manifest.fixture), bytes);
  await writeFile(join(f.directory, f.policy.manifest), manifest);
  await assert.rejects(readDeliveryFreeze(f.directory, { ...f.policy, manifestDigest: sha(manifest) }), /RETRIEVAL_EVAL_DELIVERY_PRIVATE/u);
});

test("ranked records, delivered clauses, budget misses and obsolete instructions are distinct", () => {
  const source = "EVAL-MIN-42";
  const id = deriveStableId("minutes", source);
  const reference = `${id}#D8`;
  const entry = { id: "component", source, split: "development", category: "D8", decision: 8, excerpt: "Keep the amber audit" };
  const line = `[纪要 ${source}] Contract · D8 现行有效 · 范围 fixture · Keep the amber audit · ${reference}（minutes-show --id ${reference}）`;
  const full = { records: [{ id, key: source, line }], perPromptBytes: 1600 };
  const missing = deliveryObservation(entry, full, { context: [] }, []);
  assert.equal(missing.recordTop3, true);
  assert.equal(missing.delivered, false);
  assert.equal(missing.budgetUndelivered, true);
  assert.equal(missing.invalidVacuum, true);
  assert.equal(deliveryObservation(entry, full, { context: [line] }, []).delivered, true);
  const longer = { ...full, records: [{ id, key: source, line: line.replace("Keep the amber audit", "Keep the amber audit and all of this optional detail") }] };
  const abbreviated = deliveryObservation(entry, longer, { context: [line] }, []);
  assert.equal(abbreviated.delivered, true);
  assert.equal(abbreviated.budgetUndelivered, false, "a valid shortened delivery is delivered");
  const wrong = { ...full, records: [{ id, key: source, line: line.replaceAll("#D8", "#D1").replace("D8 现行", "D1 现行") }] };
  assert.equal(deliveryObservation(entry, wrong, { context: [wrong.records[0].line] }, []).rankedWithoutClause, true);
  const sources = [{ supersedes: [{ decision: `${source}#D8`, by: "D1" }] }];
  assert.equal(deliveryObservation(entry, full, { context: [line] }, sources).obsoleteCurrent, true);
  assert.equal(deliveryObservation({ ...entry, category: "historical", obsolete: true }, full, { context: [line.replace("现行有效", "历史已失效→successor")] }, sources).obsoleteCurrent, false);
  const legal = deliveryObservation({ id: "empty", category: "negative", split: "development", allowEmpty: true }, { records: [], perPromptBytes: 1600 }, { context: [] }, []);
  assert.equal(legal.legalEmpty, true);
  assert.equal(legal.invalidVacuum, false);
});

test("actual first-delivery position comes from the ordered agent context", () => {
  const source = "EVAL-MIN-42";
  const id = deriveStableId("minutes", source);
  const reference = `${id}#D8`;
  const entry = { id: "component", source, split: "development", category: "D8", decision: 8, excerpt: "Keep the amber audit" };
  const line = `[纪要 ${source}] Contract · D8 现行有效 · 范围 fixture · Keep the amber audit · ${reference}（minutes-show --id ${reference}）`;
  const first = { context: [line] };
  const second = { context: ["[纪要 OTHER-MIN-1] Unrelated · D1 现行有效 · D1 · minutes-show --id minutes:111111111111111111111111#D1", line] };
  const position = (answer) => answer.context.findIndex((item) => item.includes(`${reference}（minutes-show --id ${reference}）`)) + 1;
  assert.equal(deliveryObservation(entry, { records: [{ id, key: source, line }], perPromptBytes: 1600 }, first, []).delivered, true);
  assert.equal(position(first), 1);
  assert.equal(deliveryObservation(entry, { records: [{ id, key: source, line }], perPromptBytes: 1600 }, second, []).delivered, true);
  assert.equal(position(second), 2, "a candidate in the context is not automatically the first delivered item");
});
