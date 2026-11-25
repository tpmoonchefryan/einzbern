// SPDX-License-Identifier: Apache-2.0
// Synthetic hook payloads and temporary device configuration only; no Codex host is called.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexPeerHook } from "../dist/build/packages/core/src/codex-peer-hooks.js";
import { applyMachineSettingSet, CODEX_DUAL_CONVERSATION_SETTING } from "../dist/build/packages/core/src/machine-settings.js";

const at = "2026-11-25T00:00:00Z";
async function deviceFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-codex-peer-guard-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const ongoing = (session, target, use) => ({
  session_id: session,
  turn_id: "fixture-turn",
  tool_use_id: use,
  tool_name: "mcp__codex_app__read_thread",
  tool_input: { threadId: target },
});
const result = target => ({ thread: { id: target, hostId: "local" }, turns: [{ status: "inProgress" }], page: { order: "newest_first" } });

test("the installed peer hook reads dual mode at the normal query boundary", async t => {
  const device = await deviceFixture(t);
  await runCodexPeerHook("UserPromptSubmit", { session_id: "fixture-main", turn_id: "prompt", prompt: "Synthetic check" }, device);
  const query = ongoing("fixture-main", "fixture-other-conversation", "first");
  assert.equal((await runCodexPeerHook("PreToolUse", query, device)).reasonCode, "HOOK_QUERY_STARTED");
  assert.equal((await runCodexPeerHook("PostToolUse", { ...query, tool_response: result("fixture-other-conversation") }, device)).reasonCode, "HOOK_QUERY_LOOP_ENDED");
  assert.equal((await runCodexPeerHook("PreToolUse", ongoing("fixture-main", "fixture-other-conversation", "second"), device)).reasonCode, "HOOK_QUERY_LOOP_DENIED");

  await applyMachineSettingSet({ path: join(device, "machine-settings.json"), key: CODEX_DUAL_CONVERSATION_SETTING, value: "false", occurredAt: at });
  await runCodexPeerHook("UserPromptSubmit", { session_id: "fixture-single", turn_id: "prompt", prompt: "Synthetic local worker check" }, device);
  await runCodexPeerHook("SubagentStart", { session_id: "fixture-single", agent_id: "fixture-native-child" }, device);
  const child = ongoing("fixture-single", "fixture-native-child", "first");
  assert.equal((await runCodexPeerHook("PreToolUse", child, device)).reasonCode, "HOOK_QUERY_STARTED");
  assert.equal((await runCodexPeerHook("PostToolUse", { ...child, tool_response: result("fixture-native-child") }, device)).reasonCode, "HOOK_QUERY_CHILD_IN_PROGRESS");
  assert.equal((await runCodexPeerHook("PreToolUse", ongoing("fixture-single", "fixture-native-child", "second"), device)).reasonCode, "HOOK_QUERY_STARTED");
  assert.equal((await runCodexPeerHook("PreToolUse", ongoing("fixture-single", "fixture-remote-thread", "third"), device)).reasonCode, "HOOK_QUERY_LOOP_DENIED");
});
