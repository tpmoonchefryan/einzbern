// SPDX-License-Identifier: Apache-2.0
import { HostExecutionError, validateHostSelection, validateHostTuple } from "./host-capabilities.js";
import type { HostCapabilities, HostSelection } from "./host-capabilities.js";
import type { HostExecutionRequest } from "./execution-fallback.js";
import type { CodexHookObservation } from "./codex-native-health.js";
import { parseStrictInstant } from "../../protocol/src/index.js";

function requireFresh(observedAt: string, now: string, source: string): void {
  const age = parseStrictInstant(now) - parseStrictInstant(observedAt);
  if (age < 0n || age > 300_000_000_000n) throw new HostExecutionError("refresh the " + source + " observation");
}

export function observedCodexCapacity(value: unknown, now = new Date().toISOString()): NonNullable<HostCapabilities["platformCapacity"]> {
  if (!value || typeof value !== "object" || !("sourceTool" in value) || value.sourceTool !== "collaboration.list_agents") throw new HostExecutionError("expected a native agent roster");
  const at = Reflect.get(value, "observedAtUpperBound");
  if (typeof at !== "string") throw new HostExecutionError("capacity capture requires its observation time");
  requireFresh(at, now, "capacity");
  const counts = Reflect.get(value, "counts");
  const agents = Reflect.get(value, "actualResult")?.agents;
  if (!counts || !Number.isSafeInteger(counts.limit) || counts.limit < 1 || counts.includesCoordinator !== true || !Array.isArray(agents)) throw new HostExecutionError("capacity limit or roster is missing");
  const occupied = ["running", "pending_init", "waiting", "pending"];
  const terminal = ["completed", "failed", "shutdown"];
  const names = new Set<string>();
  let active = 0;
  let parentActive = false;
  for (const agent of agents) {
    if (!agent || typeof agent.agent_name !== "string" || names.has(agent.agent_name) || ![...occupied, ...terminal].includes(agent.agent_status)) throw new HostExecutionError("reconcile the unknown or duplicate roster member");
    names.add(agent.agent_name);
    if (occupied.includes(agent.agent_status)) {
      active++;
      if (agent.agent_name === "/root") parentActive = true;
    }
  }
  if (!parentActive || counts.active !== active || active > counts.limit) throw new HostExecutionError("capacity totals differ from the native roster");
  return { limit: counts.limit, active, includesParent: true, parentActive };
}

export function observedHooks(value: unknown): CodexHookObservation | undefined {
  if (!value || typeof value !== "object" || !("native" in value)) return undefined;
  // A bare native observation still undergoes the normal per-hook, trust, cwd, byte and age checks.
  for (const [field, expected] of [["state", "supported"], ["trust", "permitted"], ["preToolUse", true]] as const) {
    if (field in value && Reflect.get(value, field) !== expected) return undefined;
  }
  return value.native as CodexHookObservation;
}

/** Map the capture time and windows of one actual rate-limit read into the host request. */
export function observedCodexUsage(capture: unknown, now = new Date().toISOString()): NonNullable<HostCapabilities["usage"]> {
  if (!capture || typeof capture !== "object" || !("observedAt" in capture) || typeof capture.observedAt !== "string") throw new HostExecutionError("rate-limit capture requires its original observedAt");
  requireFresh(capture.observedAt, now, "quota");
  if (Reflect.get(capture, "ordinaryUsageAllowed") === false || Reflect.get(capture, "spendControlReached") === true || Reflect.get(capture, "rateLimitReachedType")) throw new HostExecutionError("rate-limit capture reports unavailable capacity");
  const usage: { observedAt: string; fiveHourUsedPercent?: number; weeklyUsedPercent?: number } = { observedAt: capture.observedAt };
  for (const key of ["primary", "secondary"] as const) {
    const window = Reflect.get(capture, key);
    if (window == null) continue;
    if (typeof window !== "object" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) throw new HostExecutionError("invalid rate-limit window");
    const field = window.windowDurationMins === 300 ? "fiveHourUsedPercent" : window.windowDurationMins === 10080 ? "weeklyUsedPercent" : null;
    if (field) {
      if (usage[field] !== undefined) throw new HostExecutionError("duplicate rate-limit window");
      usage[field] = window.usedPercent;
    }
  }
  if (usage.weeklyUsedPercent === undefined && usage.fiveHourUsedPercent === undefined) throw new HostExecutionError("rate-limit capture contains no supported observed window");
  return usage;
}

export function codexWorkerArguments(request: HostExecutionRequest, supplied: { readonly selection?: unknown; readonly argumentsValue: unknown }): { selection: HostSelection; argumentsValue: unknown } {
  const raw = supplied.selection ?? request.selection;
  const selection = raw && typeof raw === "object" && "runner" in raw
    ? { kind: "explicit" as const, tuple: validateHostTuple(raw) } : validateHostSelection(raw);
  if (selection.kind !== "explicit") return { selection, argumentsValue: supplied.argumentsValue };
  const args = supplied.argumentsValue;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new HostExecutionError("Codex worker arguments must be an object");
  const { model, effort } = selection.tuple;
  const values = args as Record<string, unknown>;
  if ((values.model !== undefined && values.model !== model) || (values.reasoning_effort !== undefined && values.reasoning_effort !== effort)) throw new HostExecutionError("worker arguments conflict with the selected model or effort");
  if (values.fork_turns === "all") throw new HostExecutionError("explicit worker selection cannot override a full-history fork");
  return { selection, argumentsValue: { ...values, model, reasoning_effort: effort, fork_turns: values.fork_turns ?? "none" } };
}
