// SPDX-License-Identifier: Apache-2.0
// EINZBERN-STORY-011: shared category catalog, device generic defaults, and host-local overrides.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ENGINE_MODEL_POLICY_SHARED_VERSION,
  ENGINE_MODEL_POLICY_TRANSACTION_VERSION,
  applyEngineModelPolicySet,
  readEngineModelPolicyFile,
  resolveEngineExecutionPolicy,
  validateEngineModelPolicy,
} from "../dist/build/packages/core/src/engine-model-policy.js";
import { DEFAULT_ENGINE_QUOTA_POLICY, resolveExecutionConcurrency } from "../dist/build/packages/core/src/execution-policy.js";
import { defaultModelsCategory } from "../dist/build/packages/core/src/models-category.js";
import {
  MACHINE_SETTINGS_LAYER_KIND,
  MACHINE_SETTINGS_VERSION,
  applyMachineSettingSet,
  readMachineSettings,
} from "../dist/build/packages/core/src/machine-settings.js";
import { resolveExecutionAdmission } from "../dist/build/packages/core/src/execution-admission.js";

const at = "2026-11-01T00:00:00Z";
const decision = Object.freeze({
  target: "models.engine-policy",
  decidedIn: `minutes:${"a".repeat(24)}#D1`,
  libraryId: `library:${"b".repeat(24)}`,
});

async function fixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-model-unification-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function categoryTable(host, customId) {
  return [
    ...defaultModelsCategory().map(row => row.id === "flagship" ? { ...row, name: `${host} legacy flagship` } : row),
    { id: customId, name: `${host} custom`, description: `Custom category for ${host}`, order: 40 },
  ];
}

function policy(host, categories = defaultModelsCategory(), extra = {}) {
  return {
    categories,
    tiers: [
      { order: 10, category: "main", runner: host, model: `${host}-main-v1`, effort: "high", note: "main tier" },
      { order: 20, category: categories.at(-1).id, runner: host, model: `${host}-custom-v1`, effort: "max", note: "custom tier" },
    ],
    escalation: { enabled: true, threshold: 3, ceiling: "main" },
    ...extra,
  };
}

function legacyEntry(entry) {
  return {
    actor: entry.actor,
    categories: entry.categories,
    decidedIn: entry.decidedIn,
    decidedInLibraryId: entry.decidedInLibraryId,
    digest: entry.digest,
    escalation: entry.escalation,
    ...(entry.quota === undefined ? {} : { quota: entry.quota }),
    revision: entry.revision,
    tiers: entry.tiers,
    updatedAt: entry.updatedAt,
  };
}

test("STORY-011 migrates old per-host category tables into one catalog without changing tier or escalation references", async context => {
  const root = await fixture(context);
  const home = join(root, "old-device");
  const codexHome = join(root, "codex-source");
  const claudeHome = join(root, "claude-source");
  const codexPolicy = policy("codex", categoryTable("Codex", "codex-fast"), { quota: { fiveHourWaitPercent: 82 } });
  const claudePolicy = policy("claude-code", categoryTable("Claude", "claude-long"));
  const codexSource = await applyEngineModelPolicySet({ home: codexHome, host: "codex", policy: codexPolicy, occurredAt: at, actor: "agent:fixture", authorization: decision });
  const claudeSource = await applyEngineModelPolicySet({ home: claudeHome, host: "claude-code", policy: claudePolicy, occurredAt: at, actor: "agent:fixture", authorization: decision });
  await mkdir(home, { recursive: true });
  const legacyPath = join(home, "engine-model-policy.json");
  const legacyBytes = `${JSON.stringify({
    schemaVersion: ENGINE_MODEL_POLICY_TRANSACTION_VERSION,
    revision: 2,
    hosts: {
      codex: legacyEntry(codexSource.hosts.codex),
      "claude-code": legacyEntry(claudeSource.hosts["claude-code"]),
    },
    operations: {},
  })}\n`;
  await writeFile(legacyPath, legacyBytes, "utf8");

  const migrated = await readEngineModelPolicyFile(home);
  assert.equal(migrated.schemaVersion, ENGINE_MODEL_POLICY_SHARED_VERSION);
  assert.equal(migrated.revision, 2);
  assert.deepEqual(migrated.categoryCatalog.map(row => row.id), ["flagship", "main", "economy", "claude-long", "codex-fast"]);
  assert.equal(migrated.categoryCatalog[0].name, defaultModelsCategory()[0].name, "built-in names canonicalize across legacy hosts");
  assert.deepEqual(migrated.hosts.codex.categories, migrated.categoryCatalog);
  assert.equal(migrated.hosts.codex.tiers[1].category, "codex-fast");
  assert.equal(migrated.hosts.codex.tiers[1].model, "codex-custom-v1");
  assert.deepEqual(migrated.hosts.codex.escalation, { enabled: true, threshold: 3, ceiling: "main" });
  assert.equal(migrated.hosts.codex.quota.fiveHourWaitPercent, 82);
  assert.equal(migrated.hosts["claude-code"].tiers[1].category, "claude-long");
  assert.equal(migrated.hosts["claude-code"].tiers[1].model, "claude-code-custom-v1");
  assert.deepEqual(migrated.hosts["claude-code"].escalation, { enabled: true, threshold: 3, ceiling: "main" });
  assert.equal(await readFile(legacyPath, "utf8"), legacyBytes, "reading an old device fixture promotes only in memory");

  await applyEngineModelPolicySet({
    home,
    host: "codex",
    policy: {
      categories: migrated.categoryCatalog,
      tiers: migrated.hosts.codex.tiers,
      escalation: migrated.hosts.codex.escalation,
      ...(migrated.hosts.codex.quota === undefined ? {} : { quota: migrated.hosts.codex.quota }),
    },
    expectedStoreRevision: migrated.revision,
    occurredAt: "2026-11-01T00:00:01Z",
    actor: "agent:fixture",
    authorization: decision,
  });
  const persisted = JSON.parse(await readFile(legacyPath, "utf8"));
  assert.equal(persisted.schemaVersion, ENGINE_MODEL_POLICY_SHARED_VERSION);
  assert.deepEqual(persisted.categoryCatalog, migrated.categoryCatalog);
  assert.equal(Object.hasOwn(persisted.hosts.codex, "categories"), false, "categories are stored once at the root");
  assert.equal(Object.hasOwn(persisted.hosts["claude-code"], "categories"), false);
  const reread = await readEngineModelPolicyFile(home);
  assert.equal(reread.hosts["claude-code"].tiers[1].category, "claude-long");
  assert.equal(reread.hosts["claude-code"].tiers[1].model, "claude-code-custom-v1");
  assert.deepEqual(reread.hosts["claude-code"].escalation, { enabled: true, threshold: 3, ceiling: "main" });
});

test("STORY-011 keeps generic concurrency and quota device-local, permits nullable host overrides, and never host-overrides heavy-run slots", async context => {
  const root = await fixture(context);
  const homeA = join(root, "device-a");
  const homeB = join(root, "device-b");
  const machineA = join(homeA, "machine-settings.json");
  const machineB = join(homeB, "machine-settings.json");
  const setMachine = (path, key, value, suffix = "") => applyMachineSettingSet({ key, value, path, occurredAt: `${at.slice(0, -1)}${suffix || "Z"}` });

  for (const [key, value] of [
    ["models.maxConcurrentSubagents", "12"],
    ["models.quota.fiveHourParallelOffPercent", "65"],
    ["models.quota.fiveHourWaitPercent", "85"],
    ["models.quota.weeklyParallelOffPercent", "91"],
    ["models.quota.weeklyWaitPercent", "98"],
    ["execution.maxConcurrentHeavyRuns", "16"],
  ]) await setMachine(machineA, key, value);
  for (const [key, value] of [
    ["models.maxConcurrentSubagents", "5"],
    ["models.quota.fiveHourParallelOffPercent", "70"],
    ["models.quota.fiveHourWaitPercent", "88"],
    ["execution.maxConcurrentHeavyRuns", "1"],
  ]) await setMachine(machineB, key, value);

  await applyEngineModelPolicySet({ home: homeA, host: "codex", policy: policy("codex", defaultModelsCategory(), {
    maxConcurrentSubagents: 3,
    quota: { fiveHourWaitPercent: 80, weeklyWaitPercent: null },
  }), occurredAt: at, actor: "agent:fixture", authorization: decision });
  await applyEngineModelPolicySet({ home: homeB, host: "codex", policy: policy("codex"), occurredAt: at, actor: "agent:fixture", authorization: decision });

  const selectedA = await resolveEngineExecutionPolicy({ home: homeA, host: "codex", category: "main", rejections: 0 });
  const selectedB = await resolveEngineExecutionPolicy({ home: homeB, host: "codex", category: "main", rejections: 0 });
  assert.equal(selectedA.hostConcurrencyLimit, 3);
  assert.equal(selectedA.quotaOrigin, "device-host-policy");
  assert.deepEqual(selectedA.quota, { fiveHourParallelOffPercent: 65, fiveHourWaitPercent: 80, weeklyParallelOffPercent: 91, weeklyWaitPercent: null });
  assert.equal(selectedB.hostConcurrencyLimit, null, "null/omitted host concurrency inherits the local generic value");
  assert.equal(selectedB.quotaOrigin, "device-generic");
  assert.deepEqual(selectedB.quota, { fiveHourParallelOffPercent: 70, fiveHourWaitPercent: 88, weeklyParallelOffPercent: DEFAULT_ENGINE_QUOTA_POLICY.weeklyParallelOffPercent, weeklyWaitPercent: null });
  await assert.rejects(setMachine(machineA, "models.quota.fiveHourParallelOffPercent", "85"), { reasonCode: "MACHINE_SETTING_VALUE_INVALID" },
    "a generic quota update cannot make an existing host override internally inconsistent");
  assert.equal((await readMachineSettings(machineA)).values["models.quota.fiveHourParallelOffPercent"], "65");
  await assert.rejects(applyEngineModelPolicySet({ home: homeB, host: "codex", policy: policy("codex", defaultModelsCategory(), {
    quota: { fiveHourParallelOffPercent: 90 },
  }), occurredAt: "2026-11-01T00:00:02Z", actor: "agent:fixture", authorization: decision }), { reasonCode: "ENGINE_MODEL_POLICY_INVALID" },
  "a host override is checked against its device generic values before it is saved");
  assert.equal((await readEngineModelPolicyFile(homeB)).revision, 1, "a refused host override leaves the policy unchanged");

  const request = home => resolveExecutionAdmission({
    host: "codex", category: "main", rejections: 0, requestedAgents: 2,
    availableCombinations: [{ runner: "codex", model: "codex-main-v1", effort: "high" }],
    usage: { observedAt: at, source: "fixture", fiveHourUsedPercent: 40, weeklyUsedPercent: 40 },
  }, { home, now: at });
  const [admissionA, admissionB] = await Promise.all([request(homeA), request(homeB)]);
  assert.deepEqual([admissionA.concurrency.genericLimit, admissionA.concurrency.hostLimit, admissionA.concurrency.effectiveLimit, admissionA.concurrency.origin], [12, 3, 3, "host-policy"]);
  assert.deepEqual([admissionB.concurrency.genericLimit, admissionB.concurrency.hostLimit, admissionB.concurrency.effectiveLimit, admissionB.concurrency.origin], [5, null, 5, "generic"]);
  assert.equal(admissionA.selection.quota.weeklyWaitPercent, null, "an explicit nullable host value disables weekly waiting");
  assert.equal(admissionB.selection.quota.fiveHourWaitPercent, 88, "the other device resolves its own generic quota");
  assert.deepEqual(resolveExecutionConcurrency(8, undefined, 12, 3).effectiveLimit, 3);

  const policyA = JSON.parse(await readFile(join(homeA, "engine-model-policy.json"), "utf8"));
  assert.equal(Object.hasOwn(policyA.hosts.codex, "maxConcurrentHeavyRuns"), false);
  assert.throws(() => validateEngineModelPolicy("codex", { ...policy("codex"), maxConcurrentHeavyRuns: 2 }), /exactly/u, "heavy-run concurrency has no host override field");
  assert.equal((await readMachineSettings(machineA)).values["execution.maxConcurrentHeavyRuns"], "16");
  assert.equal((await readMachineSettings(machineB)).values["execution.maxConcurrentHeavyRuns"], "1");

  const oldHome = join(root, "old-device");
  const oldPath = join(oldHome, "machine-settings.json");
  await mkdir(oldHome, { recursive: true });
  const oldBytes = `${JSON.stringify({ schemaVersion: "tcrn.machine-settings.v2", layerKind: MACHINE_SETTINGS_LAYER_KIND,
    values: { "execution.maxConcurrentAgents": "2", "execution.maxConcurrentHeavyRuns": "4" }, updatedAt: at })}\n`;
  await writeFile(oldPath, oldBytes, "utf8");
  const oldRead = await readMachineSettings(oldPath);
  assert.equal(oldRead.schemaVersion, MACHINE_SETTINGS_VERSION);
  assert.deepEqual(oldRead.values, { "execution.maxConcurrentAgents": "2", "execution.maxConcurrentHeavyRuns": "4" });
  assert.equal(await readFile(oldPath, "utf8"), oldBytes, "reading an old machine settings file does not rewrite the device");
});
