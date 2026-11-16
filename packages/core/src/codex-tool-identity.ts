// SPDX-License-Identifier: Apache-2.0

/** Tool identities only; never inspect JavaScript, prompts or shell text. */
export function isCodexNativeSpawn(tool: unknown): boolean {
  return ["collaboration.spawn_agent", "collaboration__spawn_agent", "multi_agent_v1.spawn_agent", "spawn_agent"].includes(String(tool));
}
export function isCodexIndependentCreate(tool: unknown): boolean {
  return typeof tool === "string" && /(?:^|__|\.)(?:create_thread|fork_thread)$/u.test(tool);
}
