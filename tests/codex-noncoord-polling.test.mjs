// SPDX-License-Identifier: Apache-2.0
// Isolated synthetic device settings and hook payloads only; no Codex host is called.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMachineSettingSet,
  CODEX_DUAL_CONVERSATION_SETTING,
  CODEX_NON_COORDINATOR_POLLING_SETTING,
  MACHINE_SETTINGS_FILE_NAME,
  readCodexConversationSettings,
  readMachineSettingsCatalog,
} from "../dist/build/packages/core/src/machine-settings.js";
import { resolveCodexPollingPolicy } from "../dist/build/packages/core/src/codex-peer-hooks.js";
import { runCodexQueryGuard } from "../dist/build/packages/core/src/codex-query-guard.js";

const at = "2026-11-25T00:00:00Z";
async function deviceFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-codex-polling-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, MACHINE_SETTINGS_FILE_NAME) };
}
const set = (path, key, value) => applyMachineSettingSet({ path, key, value, occurredAt: at });
const readThread = (sessionId, target, toolUseId) => ({
  session_id: sessionId,
  turn_id: "fixture-turn",
  tool_use_id: toolUseId,
  tool_name: "mcp__codex_app__read_thread",
  tool_input: { threadId: target },
});
const inProgress = { thread: { id: "fixture-target", hostId: "local" }, turns: [{ id: "fixture-turn", status: "inProgress" }], page: { order: "newest_first" } };

test("dual-conversation and polling settings use Owner defaults and hide polling when dual mode is off", async t => {
  const device = await deviceFixture(t);
  assert.deepEqual(await readCodexConversationSettings(device.root), { dualConversation: true, allowNonCoordinatorPolling: false });
  const initial = await readMachineSettingsCatalog(device.path);
  const dual = initial.settings.find(entry => entry.key === CODEX_DUAL_CONVERSATION_SETTING);
  const polling = initial.settings.find(entry => entry.key === CODEX_NON_COORDINATOR_POLLING_SETTING);
  assert.equal(dual.defaultValue, "true");
  assert.equal(dual.type, "boolean");
  assert.equal(polling.defaultValue, "false");
  assert.equal(polling.type, "boolean");

  await set(device.path, CODEX_DUAL_CONVERSATION_SETTING, "false");
  await set(device.path, CODEX_NON_COORDINATOR_POLLING_SETTING, "true");
  assert.deepEqual(await readCodexConversationSettings(device.root), { dualConversation: false, allowNonCoordinatorPolling: false });
  assert.equal((await readMachineSettingsCatalog(device.path)).settings.some(entry => entry.key === CODEX_NON_COORDINATOR_POLLING_SETTING), false);

  await set(device.path, CODEX_DUAL_CONVERSATION_SETTING, "true");
  assert.deepEqual(await readCodexConversationSettings(device.root), { dualConversation: true, allowNonCoordinatorPolling: true });
  const enabled = await readMachineSettingsCatalog(device.path);
  assert.equal(enabled.settings.find(entry => entry.key === CODEX_NON_COORDINATOR_POLLING_SETTING).currentValue, "true");
});

test("normal execution policy follows the selected Codex work mode and polling consent", async t => {
  const device = await deviceFixture(t);
  assert.deepEqual(await resolveCodexPollingPolicy(device.root, "fixture-main"), {
    mode: "dual-conversation", scope: "none", reasonCode: "CODEX_POLLING_DISABLED",
  });
  await set(device.path, CODEX_NON_COORDINATOR_POLLING_SETTING, "true");
  assert.deepEqual(await resolveCodexPollingPolicy(device.root, "fixture-main"), {
    mode: "dual-conversation", scope: "authorized-conversations", reasonCode: "CODEX_POLLING_ENABLED",
  });
  await set(device.path, CODEX_DUAL_CONVERSATION_SETTING, "false");
  assert.deepEqual(await resolveCodexPollingPolicy(device.root, "fixture-main"), {
    mode: "single-conversation", scope: "native-children", reasonCode: "CODEX_POLLING_SINGLE_CONVERSATION",
  });
  assert.deepEqual(await resolveCodexPollingPolicy(device.root, "fixture-main", "fixture-worker"), {
    mode: "single-conversation", scope: "none", reasonCode: "CODEX_POLLING_WORKER",
  });
});

test("structured polling stops after a one-time conversation check unless its scope allows continuation", async t => {
  const device = await deviceFixture(t);
  const none = async () => "none";
  const authorized = async () => "authorized-conversations";
  const nativeChildren = async () => "native-children";

  await runCodexQueryGuard("UserPromptSubmit", { session_id: "fixture-default", turn_id: "prompt", prompt: "Synthetic status check" }, device.root, none);
  const first = readThread("fixture-default", "fixture-target", "first");
  assert.equal((await runCodexQueryGuard("PreToolUse", first, device.root, none)).reasonCode, "HOOK_QUERY_STARTED");
  assert.equal((await runCodexQueryGuard("PostToolUse", { ...first, tool_response: inProgress }, device.root, none)).reasonCode, "HOOK_QUERY_LOOP_ENDED");
  assert.equal((await runCodexQueryGuard("PreToolUse", readThread("fixture-default", "fixture-target", "second"), device.root, none)).reasonCode, "HOOK_QUERY_LOOP_DENIED");
  await runCodexQueryGuard("SubagentStart", { session_id: "fixture-default", agent_id: "fixture-new-child" }, device.root, none);
  assert.equal((await runCodexQueryGuard("PreToolUse", readThread("fixture-default", "fixture-target", "after-event"), device.root, none)).reasonCode, "HOOK_QUERY_STARTED", "a newly observed native worker event opens one fresh check");

  const waiting = { session_id: "fixture-wait", turn_id: "fixture-turn", tool_use_id: "wait", tool_name: "mcp__codex_app__wait_threads", tool_input: { targets: [{ threadId: "fixture-target" }], timeoutMs: 5000 } };
  assert.equal((await runCodexQueryGuard("PreToolUse", waiting, device.root, none)).reasonCode, "HOOK_QUERY_STARTED", "the first bounded wait retains its one-time-check behavior");
  const waitingResult = { polls: [{ thread: { id: "fixture-target", hostId: "local" }, latestTurn: { status: "inProgress" } }] };
  assert.equal((await runCodexQueryGuard("PostToolUse", { ...waiting, tool_response: waitingResult }, device.root, none)).reasonCode, "HOOK_QUERY_LOOP_ENDED");
  assert.equal((await runCodexQueryGuard("PreToolUse", { ...waiting, tool_use_id: "wait-again" }, device.root, none)).reasonCode, "HOOK_QUERY_LOOP_DENIED", "a repeated wait needs the selected polling scope");

  const history = { session_id: "fixture-history", turn_id: "fixture-turn", tool_use_id: "history-1", tool_name: "mcp__codex_app__list_threads", tool_input: { mode: "history", cursor: "fixture-cursor", archived: true } };
  assert.equal((await runCodexQueryGuard("PreToolUse", history, device.root, none)).reasonCode, "HOOK_QUERY_ROSTER_READ");
  assert.equal((await runCodexQueryGuard("PreToolUse", { ...history, tool_use_id: "history-2" }, device.root, none)).reasonCode, "HOOK_QUERY_LOOP_DENIED", "history cursors cannot bypass the repeat guard");

  const ongoing = readThread("fixture-opt-in", "fixture-target", "first");
  assert.equal((await runCodexQueryGuard("PreToolUse", ongoing, device.root, authorized)).reasonCode, "HOOK_QUERY_STARTED");
  assert.equal((await runCodexQueryGuard("PostToolUse", { ...ongoing, tool_response: inProgress }, device.root, authorized)).reasonCode, "HOOK_QUERY_CONVERSATION_IN_PROGRESS");
  assert.equal((await runCodexQueryGuard("PreToolUse", readThread("fixture-opt-in", "fixture-target", "second"), device.root, authorized)).reasonCode, "HOOK_QUERY_STARTED");

  await runCodexQueryGuard("SubagentStart", { session_id: "fixture-child", agent_id: "fixture-child-id" }, device.root, nativeChildren);
  const child = readThread("fixture-child", "fixture-child-id", "first");
  assert.equal((await runCodexQueryGuard("PreToolUse", child, device.root, nativeChildren)).reasonCode, "HOOK_QUERY_STARTED");
  assert.equal((await runCodexQueryGuard("PostToolUse", { ...child, tool_response: { ...inProgress, thread: { id: "fixture-child-id" } } }, device.root, nativeChildren)).reasonCode, "HOOK_QUERY_CHILD_IN_PROGRESS");
  assert.equal((await runCodexQueryGuard("PreToolUse", readThread("fixture-child", "fixture-child-id", "second"), device.root, nativeChildren)).reasonCode, "HOOK_QUERY_STARTED");
  assert.equal((await runCodexQueryGuard("PreToolUse", readThread("fixture-child", "other-thread", "third"), device.root, nativeChildren)).reasonCode, "HOOK_QUERY_LOOP_DENIED");
});
