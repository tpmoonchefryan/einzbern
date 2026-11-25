// SPDX-License-Identifier: Apache-2.0
// Synthetic roster/quota evidence and isolated work fixtures only; never call a host.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { prepareCodexBatch } from "../dist/build/packages/core/src/codex-batch-prepare.js";
import { NATIVE_TOOL_COMMAND_CATALOG, runNativeToolCommand } from "../dist/build/packages/cli/src/native-tool-commands.js";
import { nativeFixture } from "./helpers/host-native-fixture.mjs";

const roster = active => ({
  sourceTool: "collaboration.list_agents",
  observedAtUpperBound: new Date().toISOString(),
  counts: { limit: 3, active: 1, includesCoordinator: true },
  actualResult: { agents: [{ agent_name: "/root", agent_status: "running" }, ...active] },
});
function input(f, toolName = "collaboration.spawn_agent") {
  return {
    defaults: { capabilities: { hostKind: "codex", toolName } },
    plan: {
      freeSlots: 2,
      availableCandidates: ["fixture:authorized"],
      occupiedWrites: [],
      packages: [{ id: f.work.id, authorized: true, requires: ["fixture:authorized"], writes: ["Einzbern:packages/core/src/codex-query-guard.ts"] }],
    },
    members: [{ id: f.work.id, request: {}, arguments: { task_name: "fixture-worker", message: "Synthetic worker only" } }],
  };
}

test("legacy batch preparation uses observed capacity and refuses non-spawn tool identities before worker preparation", async t => {
  const f = await nativeFixture(t);
  let calls = 0;
  const prepareWorker = async () => { calls++; throw new Error("synthetic dispatcher must not run"); };
  const deniedInput = input(f, "mcp__codex_app__create_thread");
  await assert.rejects(prepareCodexBatch(f.state, deniedInput, roster([]), {}, {}, f.home, prepareWorker), /actual native Codex worker tool/);
  assert.equal(calls, 0);

  const capacityInput = input(f);
  capacityInput.plan.freeSlots = 0;
  const prepared = await prepareCodexBatch(f.state, capacityInput, roster([]), {}, {}, f.home, prepareWorker);
  assert.deepEqual(prepared.selected, []);
  assert.match(prepared.waiting[f.work.id], /capacity/u);
  assert.equal(calls, 0, "zero observed free slots never prepare or dispatch a native worker");
});

test("legacy batch CLI entry points are registered and preparation writes only an isolated candidate", async t => {
  const f = await nativeFixture(t);
  const names = new Set(NATIVE_TOOL_COMMAND_CATALOG.map(entry => entry.name));
  for (const name of ["execution-codex-batch-arm", "execution-codex-batch-status", "execution-codex-batch-adopt", "execution-codex-batch-observe", "execution-codex-batch-prepare"]) {
    assert.equal(names.has(name), true, name);
  }
  const source = join(f.root, "codex-batch-input.json");
  const capacity = join(f.root, "codex-batch-capacity.json");
  const admission = join(f.root, "codex-batch-admission.json");
  const quota = join(f.root, "codex-batch-quota.json");
  const output = join(f.root, "codex-batch-prepared.json");
  const candidate = input(f);
  candidate.plan.freeSlots = 0;
  await writeFile(source, JSON.stringify(candidate));
  await writeFile(capacity, JSON.stringify(roster([])));
  await writeFile(admission, "{}");
  await writeFile(quota, "{}");
  const context = { home: f.home, resolveWorkspace: async () => ({ root: f.workspace, state: f.state }) };
  const prepared = await runNativeToolCommand("execution-codex-batch-prepare", {
    workspace: f.workspace, "from-file": source, "codex-admission": admission, "codex-capacity": capacity,
    "codex-usage": quota, output,
  }, context);
  assert.equal(prepared.selected.length, 0);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")).selected, []);
  const status = await runNativeToolCommand("execution-codex-batch-status", { coordinator: "fixture-coordinator" }, context);
  assert.deepEqual(status.campaigns, []);
});
