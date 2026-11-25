// SPDX-License-Identifier: Apache-2.0
// INIT-027 S239 checks the device orchestration limits and the historical workspace declarations.

import "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeLibrary } from "../dist/build/packages/core/src/index.js";

// TCRN-CROSS-STORY-484 R4: these tests write settings through the CLI, as Atelier does.
standInForAtelier();

const instant = (second) => new Date(Date.UTC(2026, 0, 2) + second * 1000).toISOString().replace(/\.\d+Z$/u, "Z");

async function json(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(args) {
  try {
    await runCli(args, { write() {} });
  } catch (error) {
    return error;
  }
  assert.fail(`expected ${args[0]} to refuse`);
}

async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s239-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant(0) });
  const workspace = join(base, "workspace");
  const version = async () => (await json(["status", "--workspace", workspace])).version;
  return { workspace, version };
}

test("S239: defaults, closed enum, and bounded numeric strings are catalog-backed", async (t) => {
  const { workspace, version } = await fixture(t);
  const catalog = await json(["settings-catalog", "--workspace", workspace]);
  const entries = new Map(catalog.settings.map((entry) => [entry.key, entry]));
  assert.deepEqual(entries.get("execution.maxConcurrentSubagents"), {
    key: "execution.maxConcurrentSubagents", type: "string", controlType: "number", layer: "project", defaultValue: "8", currentValue: "8", modelWritable: false, scope: "project", source: { kind: "default", projectId: null, projectName: null, inherited: false }, inheritedValue: "8", inheritedSource: { kind: "default", projectId: null, projectName: null, inherited: false }, declaredValue: null, min: 1, shape: "scalar", group: "models", order: 6,
  });
  assert.equal(entries.has("execution.maxDispatchDepth"), false);
  assert.equal(entries.has("execution.personalessDispatch"), false);

  const key = "models.maxConcurrentSubagents";
  const read = async () => (await json(["machine-settings-catalog"])).settings.find(entry => entry.key === key);
  const defaultRow = await read();
  assert.deepEqual([defaultRow.layer, defaultRow.group, defaultRow.min, defaultRow.max], ["device", "models", 1, Number.MAX_SAFE_INTEGER]);
  for (const [index, value] of ["1", "65", String(Number.MAX_SAFE_INTEGER)].entries()) {
    const before = await version();
    const written = await json(["machine-settings-set", "--at", instant(index + 1), "--key", key, "--value", value]);
    assert.equal(written.values[key], value);
    assert.equal(await version(), before);
    assert.equal((await read()).currentValue, value, "the device catalog retains every permitted safe value");
  }
});

test("S239: semantic refusals identify the setting and leave the head unchanged", async (t) => {
  const { workspace, version } = await fixture(t);
  const cases = [
    ["execution.maxConcurrentSubagents", "3", /historical compatibility/u, "SETTINGS_KEY_DEVICE_LEVEL"],
    ["execution.maxDispatchDepth", "4", /maxDispatchDepth/u, "SETTINGS_KEY_UNREGISTERED"],
    ["execution.personalessDispatch", "unknown", /personalessDispatch/u, "SETTINGS_KEY_UNREGISTERED"],
  ];
  for (const [key, value, message, reasonCode] of cases) {
    const stable = await version();
    const error = await refusal(["settings-set", "--workspace", workspace, "--at", instant(10),
      "--key", key, "--value", value, "--actor", "agent:test"]);
    assert.equal(error.reasonCode, reasonCode, `${key}=${value}`);
    assert.match(error.message, message);
    assert.equal(await version(), stable);
  }
  for (const [value, message] of [["0", /at least 1/u], ["9007199254740992", /safe integer/u], ["1.0", /whole number/u]]) {
    const error = await refusal(["machine-settings-set", "--at", instant(10), "--key", "models.maxConcurrentSubagents", "--value", value]);
    assert.equal(error.reasonCode, "MACHINE_SETTING_VALUE_INVALID");
    assert.match(error.message, message);
  }
});

test("configuration migration: shared generation choices have closed enums and stable layout", async (t) => {
  const { workspace, version } = await fixture(t);
  const entries = new Map((await json(["settings-catalog", "--workspace", workspace])).settings.map((entry) => [entry.key, entry]));
  for (const [key, defaultValue, alternative, order] of [
    ["agents.generation", "managed", "none", 20],
    ["agents.sharedNavigation", "written", "declined", 21],
  ]) {
    const entry = entries.get(key);
    assert.deepEqual([entry.layer, entry.group, entry.order, entry.defaultValue, entry.currentValue], ["library", "general", order, defaultValue, defaultValue]);
    assert.deepEqual(entry.allowedValues, [defaultValue, alternative]);
    const before = await version();
    const rejected = await refusal(["settings-set", "--workspace", workspace, "--at", instant(1), "--key", key, "--value", "automatic"]);
    assert.equal(rejected.reasonCode, "SETTINGS_VALUE_INVALID");
    assert.equal(await version(), before, "invalid enum writes append no event");
    const written = await json(["settings-set", "--workspace", workspace, "--at", instant(2), "--key", key, "--value", alternative]);
    assert.equal(written.setting.value, alternative);
    assert.equal(await version(), before + 1);
    const readback = (await json(["settings-catalog", "--workspace", workspace])).settings.find((row) => row.key === key);
    assert.equal(readback.currentValue, alternative);
  }
});
