// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-483 R2, R3, AC1-AC4 (MIN-228 D3, MIN-229 D6; TCRN-CROSS-SUB-336): the Command
// Spell rules a project switches on. Every rule is off until it is enabled. Enabling one records it
// at the version the engine ships and writes its text, in the project's artifact language, into
// AGENTS.md as the managed section rule:<id> (AC1). A section the user changed reads user-modified
// (AC2), a newer version in the catalog reads update-available and leaves the file as it is (AC3),
// and a write refused because of the user's change waits (pending) until rule-resolve settles it;
// after keep the engine never writes that section again (AC4). Disabling a rule the user changed
// needs force. Everything here is temporary: a project, its library and a device directory.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { asPinnedDevice } from "./helpers/device-home.mjs";
import { dotEnabledRuleSources, renderDotAgents } from "../dist/build/packages/core/src/dot-agents.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { createProject, initializeLibrary, materializeWorkspace, scopedWorkspaceState } from "../dist/build/packages/core/src/index.js";
import { renderAgentsSections, resolveAgentsSection } from "../dist/build/packages/core/src/agents-sections.js";
import { configRecord, setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import { managedSectionRecordsFor, parseManagedFile, renderSection, sectionDigest } from "../dist/build/packages/core/src/managed-sections.js";
import { BUILT_IN_RULES, builtInRule } from "../dist/build/packages/core/src/rules-catalog.js";
import { RULE_STATES, checkRuleRecordValue, createCustomRule, deactivateCustomRule, disableRule, enableRule, listRules, ruleState, setCustomRuleEnabled, updateCustomRule } from "../dist/build/packages/core/src/rules.js";
import { NAVIGATION_LINES } from "../dist/build/packages/core/src/agents-sections.js";
import { navigationPointerAnswer } from "../dist/build/packages/core/src/hook-recall.js";
import { setWorkspaceSetting } from "../dist/build/packages/core/src/workspace.js";
import { registerLibrary } from "../dist/build/packages/core/src/registry.js";

const fixtures = resolve(import.meta.dirname, "fixtures", "rules");
const USER_TEXT = "# My project\n\nMy own notes, which the engine never rewrites.\n";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 27, 10, 0, second)).toISOString().replace(".000Z", "Z");
};

/** A project whose AGENTS.md holds the user's text, its library, and the device's backup directory. */
async function scratch(context, language = "zh-CN") {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-rules-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  const agents = join(project, "AGENTS.md");
  await writeFile(agents, USER_TEXT);
  const library = join(base, ".ether");
  await initializeLibrary({ root: library, createdAt: at() });
  const created = await createProject(library, { externalKey: "RULES-EXPLICIT-PROJECT", name: "Rules fixture", occurredAt: at() });
  const projectId = created.projects.find((project) => project.externalKey === "RULES-EXPLICIT-PROJECT").id;
  await setWorkspaceSetting(library, { key: "agents.sharedNavigation", value: "declined", occurredAt: at() });
  if (language !== null) await setWorkspaceSetting(library, { configurationProjectId: projectId, key: "artifact.language", value: language, occurredAt: at() });
  return { base, project, projectId, library, agents, backups: join(base, "device", "backups") };
}

const enable = (paths, id, extra = {}) => enableRule({ libraryRoot: paths.library, projectRoot: paths.project, configurationProjectId: paths.projectId, id, backupRoot: paths.backups, occurredAt: at(), ...extra });
const disable = (paths, id, extra = {}) => disableRule({ libraryRoot: paths.library, projectRoot: paths.project, configurationProjectId: paths.projectId, id, backupRoot: paths.backups, occurredAt: at(), ...extra });
const list = (paths, extra = {}) => listRules({ libraryRoot: paths.library, projectRoot: paths.project, configurationProjectId: paths.projectId, ...extra });

async function ruleOf(paths, id, extra = {}) {
  return (await list(paths, extra)).find((rule) => rule.id === id);
}

function sectionOf(text, id) {
  return parseManagedFile(text).sections.find((section) => section.id === id) ?? null;
}

async function sectionRecord(paths, id) {
  return managedSectionRecordsFor(scopedWorkspaceState(await materializeWorkspace(paths.library), paths.projectId), "AGENTS.md").find((record) => record.id === "agents") ?? null;
}

async function ruleRecord(paths, id) {
  return configRecord(scopedWorkspaceState(await materializeWorkspace(paths.library), paths.projectId), "rule", id)?.value ?? null;
}

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("the operation was expected to refuse");
}

async function cli(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

/** The built-in catalog with batch processing at its first version, as the engine shipped it before MIN-229 D6. */
async function catalogWithBatchV1() {
  const text = await readFile(join(fixtures, "batch-v1.zh.md"), "utf8");
  return BUILT_IN_RULES.map((rule) => rule.id !== "batch" ? rule : { ...rule, version: 1, body: { zh: text, en: text }, principle: { zh: "- **批量处理** 旧稿。", en: "- **Batch processing** Earlier version." } });
}

test("483-R2: every rule is off until it is enabled, and listing the rules writes nothing", async (context) => {
  const paths = await scratch(context);
  assert.deepEqual([...RULE_STATES], ["disabled", "enabled", "user-modified", "removed-from-file", "update-available", "pending", "output-unconfigured"]);
  const rules = await list(paths);
  assert.deepEqual(rules, BUILT_IN_RULES.map((rule) => ({
    id: rule.id,
    version: rule.version,
    recordedVersion: null,
    fileVersion: null,
    section: "agents",
    state: "disabled",
  })));
  assert.equal(await readFile(paths.agents, "utf8"), USER_TEXT);
  assert.deepEqual((await materializeWorkspace(paths.library)).configRecords, [], "the library holds no record of any rule");
});

test("483-AC1: enabling batch processing writes its v3 text into AGENTS.md as a managed section, and the rule reads enabled", async (context) => {
  const paths = await scratch(context);
  const v3 = builtInRule("batch").principle.zh + "\n";
  assert.match(v3, /^- \*\*批量处理\*\* /u);

  const change = await enable(paths, "batch");
  assert.deepEqual([change.action, change.section, change.file, change.result, change.written, change.recorded], ["enable", "agents", "AGENTS.md", "create", true, 2]);
  assert.equal(await readFile(change.backupPath, "utf8"), USER_TEXT, "the original is backed up before it is replaced");
  const text = await readFile(paths.agents, "utf8");
  assert.equal(text.startsWith(`${USER_TEXT}\n`), true, "the user's text stays where it was");
  const section = sectionOf(text, "agents");
  assert.deepEqual([section.body, section.rev, section.digest], [v3, 1, sectionDigest(v3)], "the section holds the v3 text");
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 3 });
  assert.deepEqual(await sectionRecord(paths, "batch"), { file: "AGENTS.md", id: "agents", rev: 1, digest: sectionDigest(v3), state: "managed" });

  const rules = await list(paths);
  const batch = rules.find((rule) => rule.id === "batch");
  assert.deepEqual(batch, { id: "batch", version: 3, recordedVersion: 3, fileVersion: 1, section: "agents", state: "enabled" });
  assert.deepEqual(change.status, batch, "the change reports the state listRules reads");
  assert.deepEqual(rules.filter((rule) => rule.id !== "batch").map((rule) => rule.state), BUILT_IN_RULES.filter((rule) => rule.id !== "batch").map(() => "disabled"));

  const again = await enable(paths, "batch");
  assert.deepEqual([again.result, again.written, again.recorded, again.backupPath, again.status.state], ["unchanged", false, 0, null, "enabled"]);
  assert.equal(await readFile(paths.agents, "utf8"), text);
});

test("483-R2: each rule's text follows artifact.language, Chinese for zh-CN and English otherwise", async (context) => {
  for (const language of ["zh-CN", "en", null]) {
    const paths = await scratch(context, language);
    for (const rule of BUILT_IN_RULES) assert.equal((await enable(paths, rule.id)).status.state, "enabled", `${rule.id} ${language}`);
    const text = await readFile(paths.agents, "utf8");
    for (const rule of BUILT_IN_RULES) {
      assert.ok(sectionOf(text, "agents").body.split("\n").includes(language === "zh-CN" ? rule.principle.zh : rule.principle.en), `${rule.id} ${language}`);
    }
    assert.deepEqual(parseManagedFile(text).outside[0], `${USER_TEXT}\n`);
  }
});

test("483-AC2: a section changed by one character reads user-modified; an editor's line endings and trailing blanks do not", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "batch");
  const written = await readFile(paths.agents, "utf8");

  // An editor that saves with CRLF line endings and leaves blanks at the ends of lines changes nothing.
  const resaved = written.replace(/\n/gu, "\r\n").replace("证据。\r\n", "证据。 \t \r\n");
  assert.notEqual(resaved, written.replace(/\n/gu, "\r\n"));
  await writeFile(paths.agents, resaved);
  assert.equal((await ruleOf(paths, "batch")).state, "enabled");

  const edited = resaved.replace("按依赖分包", "按目标分包");
  assert.equal(edited.length, resaved.length);
  await writeFile(paths.agents, edited);
  const batch = await ruleOf(paths, "batch");
  assert.deepEqual([batch.state, batch.fileVersion, batch.recordedVersion], ["user-modified", 1, 3]);
  assert.equal(await readFile(paths.agents, "utf8"), edited, "reading the state writes nothing");
  assert.deepEqual((await sectionRecord(paths, "batch")).state, "managed", "nor does it record anything");
});

test("an older compact principle reads update-available and refreshes without changing its activation", async context => {
  const paths = await scratch(context);
  const catalog = BUILT_IN_RULES.map(rule => rule.id === "batch"
    ? { ...rule, version: 1, principle: { zh: "- **批量处理** 旧稿。", en: "- **Batch processing** Earlier version." } } : rule);
  await enable(paths, "batch", { catalog });
  const before = await readFile(paths.agents, "utf8");
  assert.equal((await ruleOf(paths, "batch", { catalog })).state, "enabled");
  assert.equal((await ruleOf(paths, "batch")).state, "update-available");
  assert.equal(await readFile(paths.agents, "utf8"), before);
  const refreshed = await render(paths);
  assert.equal(await readFile(refreshed.files[0].backupPath, "utf8"), before);
  assert.equal(sectionOf(await readFile(paths.agents, "utf8"), "agents").body, builtInRule("batch").principle.zh + "\n");
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 1 });
  assert.equal((await ruleOf(paths, "batch")).state, "enabled");
  assert.equal((await render(paths)).recorded, 0);
  await enable(paths, "batch");
  assert.equal((await refusal(() => enable(paths, "batch", { catalog }))).reasonCode, "RULE_VERSION_NEWER");
});

test("T15: rule-resolve overwrite refuses to replace a newer recorded rule with older engine text", async (context) => {
  const paths = await scratch(context);
  const futureCatalog = BUILT_IN_RULES.map((rule) => rule.id === "batch"
    ? { ...rule, version: 4, body: { zh: "## 批量规则 v4\n", en: "## Batch rule v4\n" } }
    : rule);
  await enable(paths, "batch", { catalog: futureCatalog });
  await registerLibrary({ projectPath: paths.project, projectId: paths.projectId, libraryPath: paths.library, registeredAt: at() });
  const before = await readFile(paths.agents, "utf8");

  const error = await refusal(() => runCli(["rule-resolve", "--project", paths.project, "--section", "rule:batch", "--action", "overwrite", "--at", at()], { write() {} }));
  assert.deepEqual([error.reasonCode, error.details.recordedVersion, error.details.version], ["RULE_VERSION_NEWER", "4", "3"]);
  assert.equal(await readFile(paths.agents, "utf8"), before, "the older engine leaves the newer section byte for byte");
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 4 });
});


test("483-AC4: a write refused over the user's change waits; after keep the section is the user's and enabling never writes it again", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "batch");
  const edited = (await readFile(paths.agents, "utf8")).replace("按依赖分包", "按目标分包");
  await writeFile(paths.agents, edited);
  assert.equal((await ruleOf(paths, "batch")).state, "user-modified");

  const refused = await enable(paths, "batch");
  assert.deepEqual([refused.result, refused.written, refused.backupPath, refused.recorded, refused.status.state], ["refused-user-modified", false, null, 1, "pending"]);
  assert.equal(await readFile(paths.agents, "utf8"), edited, "the user's change stays");
  assert.equal((await sectionRecord(paths, "batch")).state, "pending");
  assert.equal((await ruleOf(paths, "batch")).state, "pending");

  const { change } = await resolveAgentsSection(paths.library, { projectRoot: paths.project, configurationProjectId: paths.projectId, id: "agents", action: "keep", backupRoot: paths.backups, occurredAt: at() });
  assert.deepEqual([change.result, change.record.state], ["kept", "user-owned"]);
  assert.equal((await ruleOf(paths, "batch")).state, "user-modified", "the kept text is the user's");

  const again = await enable(paths, "batch");
  assert.deepEqual([again.result, again.written, again.recorded, again.status.state], ["unchanged", false, 0, "user-modified"]);
  assert.equal(await readFile(paths.agents, "utf8"), edited, "enabling the rule never writes the kept section");
  assert.equal((await sectionRecord(paths, "batch")).state, "user-owned");
});

test("483-R2: disabling a rule the user changed needs force; an unchanged one goes with its markers and the rule reads disabled", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "autonomy");
  await enable(paths, "batch");
  const both = await readFile(paths.agents, "utf8");

  const off = await disable(paths, "autonomy");
  assert.deepEqual([off.action, off.result, off.written, off.recorded], ["disable", "disabled", true, 2]);
  assert.deepEqual(off.status, { id: "autonomy", version: 1, recordedVersion: 1, fileVersion: null, section: "agents", state: "disabled" });
  assert.deepEqual(await ruleRecord(paths, "autonomy"), { enabled: false, version: 1 });
  assert.equal((await sectionRecord(paths, "autonomy")).state, "managed", "the shared block stays recorded");
  const text = await readFile(paths.agents, "utf8");
  assert.ok(!sectionOf(text, "agents").body.includes(builtInRule("autonomy").principle.zh));
  assert.equal(text.startsWith(USER_TEXT), true);
  assert.notEqual(sectionOf(text, "agents"), null, "the other rule's section stays");
  assert.equal(await readFile(off.backupPath, "utf8"), both, "the file is backed up as it was just before");

  const edited = text.replace("按依赖分包", "按目标分包");
  await writeFile(paths.agents, edited);
  const refused = await refusal(() => disable(paths, "batch"));
  assert.deepEqual([refused.reasonCode, refused.details.section, refused.details.state], ["MANAGED_SECTION_FORCE_REQUIRED", "agents", "user-modified"]);
  assert.equal(await readFile(paths.agents, "utf8"), edited, "a refused disable writes nothing");
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 3 }, "nor records anything");

  const forced = await disable(paths, "batch", { force: true });
  assert.deepEqual([forced.result, forced.written, forced.status.state], ["disabled", true, "disabled"]);
  assert.equal(await readFile(forced.backupPath, "utf8"), edited, "the user's version is backed up first");
  assert.equal(sectionOf(await readFile(paths.agents, "utf8"), "agents"), null);
  assert.equal(await readFile(paths.agents, "utf8"), USER_TEXT, "the file is as it was before any rule was enabled");

  const nothing = await disable(paths, "batch");
  assert.deepEqual([nothing.result, nothing.written, nothing.recorded], ["unchanged", false, 0]);
  const back = await enable(paths, "batch");
  assert.deepEqual([back.result, back.status.state, back.status.fileVersion], ["create", "enabled", 1]);
});

test("483-R3: a rule whose markers the user removed reads removed-from-file, and enabling it does not put them back", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "silent-reporting");
  const text = await readFile(paths.agents, "utf8");
  const removed = text.replace(sectionOf(text, "agents").raw, "");
  await writeFile(paths.agents, removed);
  assert.deepEqual(await ruleOf(paths, "silent-reporting"), { id: "silent-reporting", version: 1, recordedVersion: 1, fileVersion: null, section: "agents", state: "removed-from-file" });

  const again = await enable(paths, "silent-reporting");
  assert.deepEqual([again.result, again.written, again.status.state], ["removed", false, "removed-from-file"]);
  assert.equal(await readFile(paths.agents, "utf8"), removed, "the removed section is not put back");
  assert.equal((await sectionRecord(paths, "silent-reporting")).state, "removed");

  // The Owner removed the whole block; toggling a single rule preserves that decision.
  const off = await disable(paths, "silent-reporting");
  assert.deepEqual([off.result, off.written, off.status.state], ["disabled", false, "disabled"]);
  const on = await enable(paths, "silent-reporting");
  assert.deepEqual([on.result, on.written, on.status.state], ["removed", false, "removed-from-file"]);
});

test("483-R2: an unknown rule is refused, a rule record holds exactly enabled and version, and a recorded rule the engine does not ship is listed", async (context) => {
  const paths = await scratch(context);
  const unknown = await refusal(() => enable(paths, "nothing"));
  assert.deepEqual([unknown.reasonCode, unknown.details.id, unknown.details.known], ["RULE_UNKNOWN", "nothing", BUILT_IN_RULES.map((rule) => rule.id).join(",")]);
  assert.equal((await refusal(() => disable(paths, "nothing"))).reasonCode, "RULE_UNKNOWN");
  assert.equal(await readFile(paths.agents, "utf8"), USER_TEXT);

  assert.doesNotThrow(() => checkRuleRecordValue({ enabled: true, version: 3 }, "batch"));
  for (const [value, key] of [
    [{ enabled: true, version: 3 }, "Batch"],
    [{ enabled: true, version: 3 }, "rule:batch"],
    [{ enabled: true }, "batch"],
    [{ enabled: true, version: 3, state: "enabled" }, "batch"],
    [{ enabled: "yes", version: 3 }, "batch"],
    [{ enabled: true, version: 0 }, "batch"],
    [{ enabled: true, version: 1.5 }, "batch"],
  ]) {
    assert.throws(() => checkRuleRecordValue(value, key), (error) => error?.reasonCode === "RULE_RECORD_INVALID", JSON.stringify([value, key]));
  }
  const invalid = await refusal(() => setConfigRecord(paths.library, { projectId: paths.projectId, collection: "rule", key: "batch", value: { state: "enabled" }, occurredAt: at() }));
  assert.deepEqual([invalid.reasonCode, invalid.details.refusedBy], ["CONFIG_RECORD_VALUE_INVALID", "RULE_RECORD_INVALID"]);

  // A newer engine elsewhere enabled a rule this one does not ship: it is listed after the built-in
  // rules, and it can be disabled; it cannot be enabled here.
  await setConfigRecord(paths.library, { projectId: paths.projectId, collection: "rule", key: "future-rule", value: { enabled: true, version: 3 }, occurredAt: at() });
  const rules = await list(paths);
  assert.deepEqual(rules.map((rule) => rule.id), [...BUILT_IN_RULES.map((rule) => rule.id), "future-rule"]);
  assert.deepEqual(rules.at(-1), { id: "future-rule", version: null, recordedVersion: 3, fileVersion: null, section: "rule:future-rule", state: "removed-from-file" });
  assert.equal(builtInRule("future-rule"), null);
  assert.equal((await refusal(() => enable(paths, "future-rule"))).reasonCode, "RULE_UNKNOWN");
  const off = await disable(paths, "future-rule");
  assert.deepEqual([off.result, off.status.state, off.status.recordedVersion], ["disabled", "disabled", 3]);
  assert.deepEqual(await ruleRecord(paths, "future-rule"), { enabled: false, version: 3 });
});


// TCRN-CROSS-STORY-508 R7 (MIN-236 D7; TCRN-CROSS-SUB-408): a rule's record may hold an order, which
// places its section among the rule sections of AGENTS.md.
const render = (paths) => renderAgentsSections(paths.library, { projectRoot: paths.project, configurationProjectId: paths.projectId, navigation: null, backupRoot: paths.backups, occurredAt: at() });

test("an explicit order moves a row, survives disabling and cannot overwrite an edited block", async context => {
  const p = await scratch(context);
  for (const id of ["batch", "autonomy", "silent-reporting"]) await enable(p, id);
  const rows = async () => sectionOf(await readFile(p.agents, "utf8"), "agents").body.trimEnd().split("\n");
  const [autonomy, batch, silent] = ["autonomy", "batch", "silent-reporting"].map(id => builtInRule(id).principle.zh);
  assert.deepEqual(await rows(), [autonomy, batch, silent]);
  await enable(p, "silent-reporting", { order: 1 });
  assert.deepEqual(await rows(), [silent, autonomy, batch]);
  await disable(p, "silent-reporting");
  assert.deepEqual(await rows(), [autonomy, batch]);
  await enable(p, "silent-reporting");
  assert.deepEqual(await rows(), [silent, autonomy, batch]);
  const edited = (await readFile(p.agents, "utf8")).replace("按依赖分包", "按目标分包");
  await writeFile(p.agents, edited);
  const changed = await enable(p, "batch", { order: 1 });
  assert.equal(changed.status.state, "pending");
  assert.equal(await readFile(p.agents, "utf8"), edited);
});

test("508-R7: a rule record's order is checked on every write and replay, and a refused order writes nothing", async (context) => {
  const paths = await scratch(context);
  assert.doesNotThrow(() => checkRuleRecordValue({ enabled: true, version: 3, order: 3 }, "batch"));
  assert.doesNotThrow(() => checkRuleRecordValue({ enabled: false, version: 1, order: 1 }, "autonomy"));
  for (const order of [0, -2, 1.5, "2", null]) {
    assert.throws(() => checkRuleRecordValue({ enabled: true, version: 3, order }, "batch"), (error) => error?.reasonCode === "RULE_RECORD_INVALID" && error.details.field === "order", JSON.stringify(order));
  }
  const replayed = await refusal(() => setConfigRecord(paths.library, { projectId: paths.projectId, collection: "rule", key: "batch", value: { enabled: true, version: 3, order: 0 }, occurredAt: at() }));
  assert.deepEqual([replayed.reasonCode, replayed.details.refusedBy], ["CONFIG_RECORD_VALUE_INVALID", "RULE_RECORD_INVALID"]);
  const version = (await materializeWorkspace(paths.library)).version;
  const refused = await refusal(() => enable(paths, "batch", { order: 0 }));
  assert.deepEqual([refused.reasonCode, refused.details.id, refused.details.field], ["RULE_RECORD_INVALID", "batch", "order"]);
  assert.equal(await readFile(paths.agents, "utf8"), USER_TEXT, "the file is not written");
  assert.equal((await materializeWorkspace(paths.library)).version, version, "and nothing is recorded");
});

// TCRN-CROSS-STORY-489 (TCRN-CROSS-SUB-366, R18 continuation revision): rule-enable and rule-disable
// write AGENTS.md before they commit the records of what they wrote. When that commit fails, the file
// goes back to what it held byte for byte, a file the enable created is taken away, the backup the
// write made stays, the library holds no new event, and the error that stopped the commit is the one
// thrown. The commit is refused the way tests/agents-sections.test.mjs refuses it: viewBudgetBytes
// narrows the view budget, a refusal that comes after the file was written. A crash after the event
// commit (crashAt) leaves the records in the library, and the file stays as it was written.
const OVER_BUDGET = Object.freeze({ viewBudgetBytes: 1 });
const AFTER_COMMIT = Object.freeze({ crashAt: "after-event-commit" });

async function libraryHead(paths) {
  const { version, headEventHash } = await materializeWorkspace(paths.library);
  return { version, headEventHash };
}

async function ruleRecords(paths, id) {
  return [await ruleRecord(paths, id), await sectionRecord(paths, id), await libraryHead(paths)];
}

async function bytesOrNull(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// Whether a file under the device's backups holds `bytes`: the copy a write makes before it replaces a file.
async function backedUp(paths, bytes) {
  const entries = await readdir(paths.backups, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && (await readFile(join(entry.parentPath, entry.name))).equals(bytes)) return true;
  }
  return false;
}

test("489: a rule-enable whose records cannot be committed leaves AGENTS.md byte for byte, and takes away one it created", async (context) => {
  const paths = await scratch(context);
  const original = await readFile(paths.agents);
  const head = await libraryHead(paths);
  const refused = await refusal(() => enable(paths, "batch", OVER_BUDGET));
  assert.equal(refused.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED", "the error that stopped the commit is the one thrown");
  assert.deepEqual(await readFile(paths.agents), original, "AGENTS.md holds what it held, byte for byte");
  assert.deepEqual(await libraryHead(paths), head, "the library holds no new event");
  assert.equal(await backedUp(paths, original), true, "the backup the write made stays");

  // A project without AGENTS.md: the file the enable created is not there afterwards.
  const bare = join(paths.base, "bare");
  await mkdir(bare);
  const created = await refusal(() => enable({ ...paths, project: bare }, "batch", OVER_BUDGET));
  assert.equal(created.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.equal(await bytesOrNull(join(bare, "AGENTS.md")), null, "the AGENTS.md the enable created is taken away");
  assert.deepEqual(await libraryHead(paths), head, "the library holds no new event");

  // A replace that cannot be recorded leaves the section as its record says, so the rule does not read as the user's change.
  await enable(paths, "batch", { catalog: await catalogWithBatchV1() });
  const v1 = await readFile(paths.agents);
  const recorded = await ruleRecords(paths, "batch");
  const upgrade = await refusal(() => enable(paths, "batch", OVER_BUDGET));
  assert.equal(upgrade.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.deepEqual(await readFile(paths.agents), v1, "AGENTS.md holds the version the library records");
  assert.deepEqual(await ruleRecords(paths, "batch"), recorded, "the records are as they were, and the library holds no new event");
  assert.equal((await ruleOf(paths, "batch")).state, "update-available", "the rule reads as it did before the enable");

  // The normal path is as it was: the same enable, committed, replaces the section and records it.
  const upgraded = await enable(paths, "batch");
  assert.deepEqual([upgraded.result, upgraded.written, upgraded.recorded, upgraded.status.state], ["replace", true, 2, "enabled"]);
});

test("489: a rule-enable whose records went in before the failure (a crash after the event commit) keeps AGENTS.md as written", async (context) => {
  const paths = await scratch(context);
  const head = await libraryHead(paths);
  const error = await refusal(() => enable(paths, "batch", AFTER_COMMIT));
  assert.equal(error.reasonCode, "WORKSPACE_FAULT_INJECTED");
  assert.notDeepEqual(await libraryHead(paths), head, "the records went in");
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 3 });
  const text = await readFile(paths.agents, "utf8");
  assert.equal(sectionOf(text, "agents")?.body, builtInRule("batch").principle.zh + "\n", "so the section stays where it was written");
  assert.equal(text.startsWith(`${USER_TEXT}\n`), true, "and the user's text where it was");
  const again = await enable(paths, "batch");
  assert.deepEqual([again.result, again.written, again.recorded, again.status.state], ["unchanged", false, 0, "enabled"], "the file and the records agree");
});

test("489: a rule-disable whose records cannot be committed puts the section back, the user's change with it", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "autonomy");
  await enable(paths, "batch");
  const both = await readFile(paths.agents);
  const recorded = await ruleRecords(paths, "batch");
  const refused = await refusal(() => disable(paths, "batch", OVER_BUDGET));
  assert.equal(refused.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED", "the error that stopped the commit is the one thrown");
  assert.deepEqual(await readFile(paths.agents), both, "the section is back in the file, markers and all, byte for byte");
  assert.deepEqual(await ruleRecords(paths, "batch"), recorded, "the rule stays enabled with its section recorded, and the library holds no new event");
  assert.equal(await backedUp(paths, both), true, "the backup the write made stays");

  // A section the user changed, disabled with force: the user's text comes back as the user left it.
  const edited = Buffer.from((await readFile(paths.agents, "utf8")).replace("按依赖分包", "按目标分包"));
  await writeFile(paths.agents, edited);
  const forced = await refusal(() => disable(paths, "batch", { force: true, ...OVER_BUDGET }));
  assert.equal(forced.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.deepEqual(await readFile(paths.agents), edited, "the user's text is where the user left it");
  assert.deepEqual(await ruleRecords(paths, "batch"), recorded);
  assert.equal((await ruleOf(paths, "batch")).state, "user-modified");

  // The normal path is as it was: the same disable, committed, takes the section out.
  const off = await disable(paths, "batch", { force: true });
  assert.deepEqual([off.result, off.written, off.recorded, off.status.state], ["disabled", true, 2, "disabled"]);
  assert.ok(!sectionOf(await readFile(paths.agents, "utf8"), "agents").body.includes(builtInRule("batch").principle.zh));
});

test("489: a rule-disable whose records went in before the failure (a crash after the event commit) keeps the section out", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "batch");
  const head = await libraryHead(paths);
  const error = await refusal(() => disable(paths, "batch", AFTER_COMMIT));
  assert.equal(error.reasonCode, "WORKSPACE_FAULT_INJECTED");
  assert.notDeepEqual(await libraryHead(paths), head, "the records went in");
  assert.deepEqual([await ruleRecord(paths, "batch"), await sectionRecord(paths, "batch")], [{ enabled: false, version: 3 }, null]);
  assert.equal(await readFile(paths.agents, "utf8"), USER_TEXT, "so the section stays out of the file");
  const again = await disable(paths, "batch");
  assert.deepEqual([again.result, again.written, again.recorded, again.status.state], ["unchanged", false, 0, "disabled"], "the file and the records agree");
});

test("489: rule-resolve's two calls each put back only what they wrote, and the resolve that was recorded stays", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "autonomy");
  await enable(paths, "batch");
  await writeFile(paths.agents, (await readFile(paths.agents, "utf8")).replace("按依赖分包", "按目标分包"));
  assert.equal((await enable(paths, "batch")).status.state, "pending");
  // rule-resolve's first call, resolveAgentsSection, writes the engine's text and records it.
  const { change } = await resolveAgentsSection(paths.library, { projectRoot: paths.project, configurationProjectId: paths.projectId, id: "agents", action: "overwrite", backupRoot: paths.backups, occurredAt: at() });
  assert.deepEqual([change.result, change.written, change.record.state], ["overwritten", true, "managed"]);
  const resolved = await readFile(paths.agents);
  const recorded = await ruleRecords(paths, "batch");
  // Its second, enableRule, writes the file again (an order moves the section here) and cannot record it.
  const refused = await refusal(() => enable(paths, "batch", { order: 1, ...OVER_BUDGET }));
  assert.equal(refused.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.deepEqual(await readFile(paths.agents), resolved, "the file is as the first call wrote it, not as it was before that call");
  assert.deepEqual(await ruleRecords(paths, "batch"), recorded, "the first call's record stays, and the library holds no new event");
  assert.equal((await ruleOf(paths, "batch")).state, "enabled");
});

async function legacyBatch(paths, body, version) {
  const id = "rule:batch";
  await setConfigRecord(paths.library, { projectId: paths.projectId, collection: "rule", key: "batch", value: { enabled: true, version }, occurredAt: at() });
  await setConfigRecord(paths.library, { projectId: paths.projectId, collection: "managed-section", key: "AGENTS.md#" + id,
    value: { file: "AGENTS.md", id, rev: 1, state: "managed", digest: sectionDigest(body) }, occurredAt: at() });
  await writeFile(paths.agents, USER_TEXT + renderSection({ id, body, rev: 1 }));
}

test("historical v2 and same-version v3 revisions migrate in both languages and protect local edits", async context => {
  for (const [language, suffix] of [["zh-CN", "zh"], ["en", "en"]]) {
    for (const [name, version] of [["batch-v2", 2], ["batch-v3-rev1", 3], ["batch-v3-rev2", 3]]) {
      const old = await readFile(join(fixtures, name + "." + suffix + ".md"), "utf8");
      const paths = await scratch(context, language);
      await legacyBatch(paths, old, version);
      assert.equal((await ruleOf(paths, "batch")).state, "update-available");
      const edited = (await readFile(paths.agents, "utf8")).replace(old, old + "User addition.\n");
      await writeFile(paths.agents, edited);
      assert.deepEqual((await render(paths)).pending, [{ id: "rule:batch", file: "AGENTS.md" }]);
      assert.equal(await readFile(paths.agents, "utf8"), edited);
      await resolveAgentsSection(paths.library, { configurationProjectId: paths.projectId, projectRoot: paths.project, id: "rule:batch",
        action: "keep", occurredAt: at() });
      assert.equal((await render(paths)).files[0].written, false);
      await resolveAgentsSection(paths.library, { configurationProjectId: paths.projectId, projectRoot: paths.project, id: "rule:batch",
        action: "overwrite", force: true, occurredAt: at() });
      await render(paths);
      const text = await readFile(paths.agents, "utf8");
      assert.deepEqual(parseManagedFile(text).sections.map(s => s.id), ["agents"]);
      assert.equal(sectionOf(text, "agents").body, builtInRule("batch").principle[suffix] + "\n");
      assert.equal((await ruleRecord(paths, "batch")).version, version);
      assert.equal((await render(paths)).recorded, 0);
    }
  }
});

test("INIT003 custom rules create, edit, order, disable and re-enable inside the protected library-managed section", async context => {
  const paths = await scratch(context);
  const input = { libraryRoot: paths.library, projectRoot: paths.project, configurationProjectId: paths.projectId,
    backupRoot: paths.backups, occurredAt: at() };
  const created = await createCustomRule({ ...input, id: "custom-privacy", title: "Protect private values",
    body: "Keep credentials out of logs.\nAsk before sharing private data.", order: 2 });
  assert.deepEqual([created.action, created.status.id, created.status.state, created.status.section, created.status.order],
    ["create", "custom-privacy", "enabled", "agents", 2]);
  const initialText = await readFile(paths.agents, "utf8");
  assert.ok(sectionOf(initialText, "agents").body.includes("- **Protect private values**\n  Keep credentials out of logs.\n  Ask before sharing private data."));
  assert.deepEqual((await ruleRecord(paths, "custom-privacy")), {
    custom: true, enabled: true, version: 1, title: "Protect private values", body: "Keep credentials out of logs.\nAsk before sharing private data.", order: 2,
  });
  assert.deepEqual((await materializeWorkspace(paths.library)).configRecords.filter(record => record.collection === "rule"), [
    { collection: "rule", key: "custom-privacy", value: { custom: true, enabled: true, version: 1,
      title: "Protect private values", body: "Keep credentials out of logs.\nAsk before sharing private data.", order: 2 } },
  ], "the custom rule is stored once without a projectId");

  const updated = await updateCustomRule({ ...input, id: "custom-privacy", title: "Protect secrets",
    body: "Never copy secrets into logs.", order: 4 });
  assert.deepEqual([updated.action, updated.status.state, updated.status.title, updated.status.order], ["update", "enabled", "Protect secrets", 4]);
  const updatedText = await readFile(paths.agents, "utf8");
  assert.ok(sectionOf(updatedText, "agents").body.includes("- **Protect secrets**\n  Never copy secrets into logs."));
  assert.ok(!updatedText.includes("Protect private values"));

  const disabled = await deactivateCustomRule({ ...input, id: "custom-privacy" });
  assert.deepEqual([disabled.action, disabled.status.state, (await ruleRecord(paths, "custom-privacy")).enabled], ["disable", "disabled", false]);
  assert.ok(!sectionOf(await readFile(paths.agents, "utf8"), "agents"), "disabled custom text is removed from managed output");

  const enabled = await setCustomRuleEnabled({ ...input, id: "custom-privacy", enabled: true });
  assert.deepEqual([enabled.action, enabled.status.state, enabled.status.order], ["enable", "enabled", 4]);
});

test("INIT003 rule records consolidate across project roots and remain isolated by library", async context => {
  const paths = await scratch(context);
  const otherRoot = join(paths.base, "other-project");
  await mkdir(otherRoot);
  await writeFile(join(otherRoot, "AGENTS.md"), USER_TEXT);
  const secondProject = await createProject(paths.library, { externalKey: "RULES-SECOND-PROJECT", name: "Second rules fixture", occurredAt: at() });
  const secondProjectId = secondProject.projects.find(project => project.externalKey === "RULES-SECOND-PROJECT").id;
  await setWorkspaceSetting(paths.library, { configurationProjectId: secondProjectId, key: "artifact.language", value: "zh-CN", occurredAt: at() });
  await setConfigRecord(paths.library, { projectId: paths.projectId, collection: "rule", key: "batch", value: { enabled: false, version: 3, order: 7 }, occurredAt: at() });
  await setConfigRecord(paths.library, { projectId: secondProjectId, collection: "rule", key: "batch", value: { enabled: true, version: 3, order: 3 }, occurredAt: at() });

  const firstEnable = await enable(paths, "batch", { order: 5 });
  assert.deepEqual([firstEnable.status.state, firstEnable.status.order], ["enabled", 5]);
  let rules = (await materializeWorkspace(paths.library)).configRecords.filter(record => record.collection === "rule" && record.key === "batch");
  assert.deepEqual(rules, [{ collection: "rule", key: "batch", value: { enabled: true, version: 3, order: 5 } }],
    "the first rule write replaces all old project values with one library value");

  const secondEnable = await enableRule({ libraryRoot: paths.library, projectRoot: otherRoot, configurationProjectId: secondProjectId,
    id: "batch", backupRoot: paths.backups, occurredAt: at() });
  assert.deepEqual([secondEnable.status.state, secondEnable.status.order], ["enabled", 5]);
  const firstView = await listRules({ libraryRoot: paths.library, projectRoot: paths.project, configurationProjectId: paths.projectId });
  const secondView = await listRules({ libraryRoot: paths.library, projectRoot: otherRoot, configurationProjectId: secondProjectId });
  assert.deepEqual(firstView.find(rule => rule.id === "batch"), secondView.find(rule => rule.id === "batch"));
  assert.equal(sectionOf(await readFile(paths.project + "/AGENTS.md", "utf8"), "agents").body.includes(builtInRule("batch").principle.zh), true);
  assert.equal(sectionOf(await readFile(join(otherRoot, "AGENTS.md"), "utf8"), "agents").body.includes(builtInRule("batch").principle.zh), true);

  const otherLibrary = join(paths.base, "other-library");
  await initializeLibrary({ root: otherLibrary, createdAt: at() });
  const isolatedProject = join(paths.base, "isolated-project");
  await mkdir(isolatedProject);
  await writeFile(join(isolatedProject, "AGENTS.md"), USER_TEXT);
  const isolated = await createProject(otherLibrary, { externalKey: "ISOLATED-RULES", name: "Isolated rules fixture", occurredAt: at() });
  const isolatedId = isolated.projects.find(project => project.externalKey === "ISOLATED-RULES").id;
  assert.equal((await listRules({ libraryRoot: otherLibrary, projectRoot: isolatedProject, configurationProjectId: isolatedId })).some(rule => rule.id === "custom-privacy"), false);
});

test("INIT003 a second device reads the library custom rule and renders the same selected rule locally", async context => {
  const firstDeviceId = "c".repeat(32);
  const secondDeviceId = "e".repeat(32);
  await asPinnedDevice(async () => {
    const paths = await scratch(context);
    const secondLibrary = join(paths.base, "device-two-library");
    await cp(paths.library, secondLibrary, { recursive: true });
    const secondProject = join(paths.base, "device-two-project");
    await mkdir(secondProject);
    await writeFile(join(secondProject, "AGENTS.md"), USER_TEXT);

    await createCustomRule({ libraryRoot: paths.library, projectRoot: paths.project, configurationProjectId: paths.projectId,
      id: "custom-portable", title: "Portable custom rule", body: "Keep this definition in the shared library.", order: 6, occurredAt: at() });
    await writeFile(join(secondProject, "AGENTS.md"), await readFile(paths.agents, "utf8"));

    // A sync client copies this device's append-only stream into the other device's library copy.
    const sourceStream = join(paths.library, "akasha", firstDeviceId);
    await cp(sourceStream, join(secondLibrary, "akasha", firstDeviceId), { recursive: true });

    await asPinnedDevice(async home => {
      await registerLibrary({ projectPath: secondProject, projectId: paths.projectId, libraryPath: secondLibrary, agentsProjectRoot: secondProject, registeredAt: at(), gitRemote: null }, home);
      const readback = await listRules({ libraryRoot: secondLibrary, projectRoot: secondProject, configurationProjectId: paths.projectId });
      const shared = readback.find(rule => rule.id === "custom-portable");
      assert.deepEqual([shared?.custom, shared?.title, shared?.body, shared?.order, shared?.state], [true, "Portable custom rule", "Keep this definition in the shared library.", 6, "enabled"]);
      const rendered = await setCustomRuleEnabled({ libraryRoot: secondLibrary, projectRoot: secondProject, configurationProjectId: paths.projectId,
        id: "custom-portable", enabled: true, occurredAt: at() });
      assert.deepEqual([rendered.status.state, rendered.status.order, rendered.written], ["enabled", 6, false]);
      assert.match(await readFile(join(secondProject, "AGENTS.md"), "utf8"), /Portable custom rule/u);

      const edited = await updateCustomRule({ libraryRoot: secondLibrary, projectRoot: secondProject, configurationProjectId: paths.projectId,
        id: "custom-portable", title: "Edited on device two", body: "The edit syncs back with the library record.", order: 8, occurredAt: at() });
      assert.deepEqual([edited.status.title, edited.status.order, edited.status.state], ["Edited on device two", 8, "enabled"]);
      const disabled = await setCustomRuleEnabled({ libraryRoot: secondLibrary, projectRoot: secondProject, configurationProjectId: paths.projectId,
        id: "custom-portable", enabled: false, occurredAt: at() });
      assert.equal(disabled.status.state, "disabled");
    }, secondDeviceId);

    await cp(join(secondLibrary, "akasha", secondDeviceId), join(paths.library, "akasha", secondDeviceId), { recursive: true });
    await writeFile(paths.agents, await readFile(join(secondProject, "AGENTS.md"), "utf8"));
    const backOnFirst = await listRules({ libraryRoot: paths.library, projectRoot: paths.project, configurationProjectId: paths.projectId });
    const syncedBack = backOnFirst.find(rule => rule.id === "custom-portable");
    assert.deepEqual([syncedBack?.custom, syncedBack?.title, syncedBack?.body, syncedBack?.order, syncedBack?.state],
      [true, "Edited on device two", "The edit syncs back with the library record.", 8, "disabled"]);
    assert.doesNotMatch(await readFile(paths.agents, "utf8"), /Edited on device two/u);
  }, firstDeviceId);
});

test("INIT003 migration refuses conflicting custom definitions and leaves the managed file unchanged", async context => {
  const paths = await scratch(context);
  const secondProject = await createProject(paths.library, { externalKey: "RULES-CONFLICT-PROJECT", name: "Conflict rules fixture", occurredAt: at() });
  const secondProjectId = secondProject.projects.find(project => project.externalKey === "RULES-CONFLICT-PROJECT").id;
  await setConfigRecord(paths.library, { projectId: paths.projectId, collection: "rule", key: "custom-conflict",
    value: { custom: true, enabled: true, version: 1, title: "First definition", body: "First body" }, occurredAt: at() });
  await setConfigRecord(paths.library, { projectId: secondProjectId, collection: "rule", key: "custom-conflict",
    value: { custom: true, enabled: true, version: 1, title: "Other definition", body: "Other body" }, occurredAt: at() });
  const before = await readFile(paths.agents, "utf8");
  await assert.rejects(setCustomRuleEnabled({ libraryRoot: paths.library, projectRoot: paths.project, configurationProjectId: paths.projectId,
    id: "custom-conflict", enabled: false, occurredAt: at() }), error => error.reasonCode === "RULE_SCOPE_CONFLICT");
  assert.equal(await readFile(paths.agents, "utf8"), before);
  assert.equal((await materializeWorkspace(paths.library)).configRecords.filter(record => record.collection === "rule" && record.key === "custom-conflict").length, 2);
});

test("INIT003 navigation pointer uses the shared lines only when the library setting selects hook fallback", () => {
  assert.deepEqual(navigationPointerAnswer("codex", "SessionStart").lines, NAVIGATION_LINES, "the legacy default includes navigation");
  assert.deepEqual(navigationPointerAnswer("codex", "SessionStart", true).lines, NAVIGATION_LINES);
  assert.deepEqual(navigationPointerAnswer("codex", "SessionStart", false).lines, []);
  assert.match(navigationPointerAnswer("codex", "SessionStart", false).output, /"additionalContext":""/u);
});
