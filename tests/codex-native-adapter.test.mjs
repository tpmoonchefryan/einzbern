// SPDX-License-Identifier: Apache-2.0
// Source/API retirement checks, not native host acceptance or a transport simulation.
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";
import * as core from "../dist/build/packages/core/src/index.js";

const source = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
test("the collector controller and its cap exemption are absent from the public API", async () => {
  for (const name of ["codexNativeDynamicToolSpecs", "createCodexNativeController", "handleCodexSubagentStop", "evaluateCodexCollectorStop", "validateCodexCollectorCapacity", "CODEX_COLLECTOR_INITIAL_PROGRESS"]) {
    assert.equal(Object.hasOwn(core, name), false, name);
  }
  await assert.rejects(access(new URL("../packages/core/src/codex-subagent-stop.ts", import.meta.url)), { code: "ENOENT" });
  assert.doesNotMatch(await source("packages/core/src/index.ts"), /codex-subagent-stop/u);
});

test("the installed hook has no collector controller, wait command or IPC fallback", async () => {
  const hook = await source("scripts/einzbern-hook.mjs");
  for (const marker of ["collector-wait", "nativeController", "requestCodexNativeHookDecision", "waitCodexNativeCollector", "EINZBERN_CODEX_NATIVE_HOOK_SOCKET", "codex-native-hook-ipc"]) assert.equal(hook.includes(marker), false, marker);
});

test("STORY-711 AC01/AC02: Economy startup binds effective Full Access to its new conversation before handoff or dispatch", async () => {
  const controller = await source("docs/codex-native-controller.md");
  const section = controller.split("## Economy startup and effective permission gate\n")[1]?.split("\n## ")[0];
  assert.ok(section, "the native startup gate is documented");
  const contractText = section.replace(/\s+/gu, " ");
  for (const contract of [
    "requesting Full Access on that new conversation",
    "Retain the exact creation arguments and raw host response",
    "A request for Full Access alone is not evidence",
    '`thread/start` accepts `sandbox: "danger-full-access"`',
    "`thread.id` and sibling `sandbox.type`",
    "`dangerFullAccess` is the effective",
    "`workspaceWrite` is restricted",
    "`thread/read` at this version returns thread metadata but no sandbox",
    "record the effective permission as unknown",
    "first worker dispatch are ready only after the new Economy ID is correlated with effective `dangerFullAccess`",
    "A host refusal remains denied with its raw response",
    "an explicit restricted result is blocked",
    "missing, mismatched, or unrecognized permission evidence is unknown",
    "stop this candidate's initial handoff and dispatch before either native operation",
    "`execution-host-prepare --codex-peer-worker true --codex-startup-evidence <file>`",
    "`/result/thread/id` with permission at `/result/sandbox/type`",
    "first worker preparation, complete worker receipt, role enrollment, then first handoff readiness",
    "Preparation itself invokes neither a native handoff nor a worker dispatch",
    "Never change the current Main conversation's permission",
    "Do not add a `sandboxPolicy` override to the first `turn/start` handoff",
  ]) assert.ok(contractText.includes(contract), `startup contract includes: ${contract}`);
});
