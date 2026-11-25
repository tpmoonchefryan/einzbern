// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planPrinciples } from "../dist/build/packages/core/src/agents-principles.js";
import { applyManagedWrite, parseManagedFile, renderSection, sectionDigest } from "../dist/build/packages/core/src/managed-sections.js";
import { NAVIGATION_LINES } from "../dist/build/packages/core/src/navigation-lines.js";
import { BUILT_IN_RULES } from "../dist/build/packages/core/src/rules-catalog.js";

const enabled = BUILT_IN_RULES.slice(0, 8);
const rules = enabled.map(({ id, version }) => ({ collection: "rule", key: id, value: { enabled: true, version } }));
const settings = [{ key: "artifact.language", value: "zh-CN" }];
const navigation = NAVIGATION_LINES.join("\n");
const at = "2026-11-21T00:00:00Z";
const record = (id, body, state = "managed") => ({ collection: "managed-section", key: "AGENTS.md#" + id,
  value: { file: "AGENTS.md", id, digest: sectionDigest(body), rev: 1, state } });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-principles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  return { root, project, file: join(project, "AGENTS.md") };
}

test("a bilingual catalog renders the approved eight one-line principles with one digest, preserving legacy notes and CRLF", async t => {
  const { root, project, file } = await fixture(t);
  const legacy = [["navigation", "Old skill navigation."], ...enabled.slice(0, 4).map(r => ["rule:" + r.id, r.body.zh])];
  const notes = ["# Title\r\n\r\n", "\r\n", "\r\nKeep this note.\r\n", "\r\n", "\r\n", "End of file."];
  const before = legacy.map(([id, body], i) => notes[i] + renderSection({ id, rev: 1, body }, "\r\n")).join("") + notes.at(-1);
  await writeFile(file, before);
  const state = { settings, configRecords: [...rules, ...legacy.map(([id, body]) => record(id, body))] };
  const plan = await planPrinciples(project, state);
  const applied = await applyManagedWrite(plan, { now: at, backupRoot: root });
  assert.equal(await readFile(applied.backupPath, "utf8"), before);
  const actual = await readFile(file, "utf8");
  const parsed = parseManagedFile(actual);
  assert.deepEqual(parsed.sections.map(s => s.id), ["agents"]);
  const [section] = parsed.sections;
  assert.equal(section.body.replaceAll("\r\n", "\n"), [navigation, "", ...enabled.map(r => r.principle.zh), ""].join("\n"));
  assert.equal(section.digest, section.bodyDigest);
  assert.equal(section.digest, "f23f5d70145dd4e7223c2d3164c1a2f1639451344609923f47afaac878a2552e");
  assert.equal(parsed.outside.join(""), "# Title\r\n\r\n\r\nKeep this note.\r\nEnd of file.");
  const next = await planPrinciples(project, { settings, configRecords: [...rules, record("agents", section.body)] });
  assert.equal(next.write, false);
  assert.ok(next.sections.every(d => !d.recordChanged));
});

test("edited, missing and user-owned legacy principles remain protected without a second copy", async t => {
  const { project, file } = await fixture(t);
  const [first, second, third] = enabled;
  const legacy = rule => renderSection({ id: "rule:" + rule.id, rev: 1, body: rule.body.en });
  const edited = legacy(first).replace("## ", "## Owner ");
  const kept = legacy(second);
  await writeFile(file, edited + kept);
  const state = { settings, configRecords: [...rules, record("rule:" + first.id, first.body.en),
    record("rule:" + second.id, second.body.en, "user-owned"), record("rule:" + third.id, third.body.en)] };
  const plan = await planPrinciples(project, state);
  assert.deepEqual(plan.pending, ["rule:autonomy"]);
  assert.ok(plan.after.startsWith(edited + kept));
  const group = parseManagedFile(plan.after).sections.find(s => s.id === "agents");
  for (const rule of [first, second, third]) assert.ok(!group.body.includes(rule.principle.zh));
  assert.ok(group.body.includes(enabled[4].principle.zh));
  await writeFile(file, plan.after.replace(enabled[4].principle.zh, "I rewrote this."));
  const next = await planPrinciples(project, { settings, configRecords: [...state.configRecords, record("agents", group.body)] });
  assert.ok(next.pending.includes("agents"));
  assert.equal(next.write, false);
});

test("a missing entire file restores managed legacy rules while respecting explicit removals", async t => {
  const { project } = await fixture(t);
  const state = { settings, configRecords: [...rules, record("rule:batch", "Older"), record("rule:autonomy", "Owner removed", "removed")] };
  const plan = await planPrinciples(project, state);
  assert.ok(plan.desiredBody.includes(enabled[1].principle.zh));
  assert.ok(!plan.desiredBody.includes(enabled[0].principle.zh));
  assert.equal(plan.sections.find(d => d.id === "rule:batch").forgetRecord, true);
});

test("a second device migrating legacy markers uses the existing compact revision without rolling it back", async t => {
  const { project, file } = await fixture(t);
  await writeFile(file, renderSection({ id: "navigation", rev: 2, body: "Old navigation." }));
  const expected = [navigation, "", ...enabled.map(rule => rule.principle.zh)].join("\n");
  const stored = record("agents", expected);
  stored.value.rev = 7;
  const plan = await planPrinciples(project, { settings, configRecords: [...rules, stored] });
  const [block] = parseManagedFile(plan.after).sections;
  assert.equal(block.rev, 7);
  assert.equal(block.digest, stored.value.digest);
  assert.equal(plan.sections.find(d => d.id === "agents").recordChanged, false);
});
