// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalSha256 } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { withFileLock } from "./file-lock.js";
import { isCodexNativeSpawn } from "./codex-tool-identity.js";

type ObjectValue = Record<string, unknown>;
function appQueryName(tool: unknown): string | undefined {
  if (tool === "read_thread" || tool === "wait_threads" || tool === "list_threads") return tool;
  return typeof tool === "string" ? /^(?:mcp__codex_app__|codex_app__|codex_app\.)(read_thread|wait_threads|list_threads)$/u.exec(tool)?.[1] : undefined;
}
const reason = "End this waiting loop. Wait for a delivered result or a new request. Only the enrolled coordinator or a caller with execution.codexAllowNonCoordinatorPolling enabled may poll within its authorized scope. Terminal, unknown and outstanding queries cannot be repeated.";
export type CodexPollingScope = "none" | "native-children" | "authorized-conversations";
type Continuation = "native-child" | "conversation";
const denied = () => ({ reasonCode: "HOOK_QUERY_LOOP_DENIED", output: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n" });
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Parse the actual structured result, never JavaScript, shell text or a transcript. */
export function codexToolResult(value: unknown): ObjectValue | null {
  const result = object(value);
  if (result === null || result.isError === true || (typeof result.exit_code === "number" && result.exit_code !== 0)) return null;
  let output = result.stdout ?? result.output;
  if (Array.isArray(result.content)) {
    const parts = result.content.filter(part => object(part)?.type === "text");
    if (parts.length !== 1) return null;
    output = object(parts[0])?.text;
  }
  if (typeof output === "string") {
    try { return object(JSON.parse(output)); } catch { return null; }
  }
  return result;
}

interface QueryState {
  readonly schemaVersion: "einzbern.codex-query-guard.v1";
  readonly sessionId: string;
  readonly agentId: string | null;
  promptDigest: string | null;
  blocked: boolean;
  continuation?: Continuation;
  rosterRead?: boolean;
  threadsListed?: boolean;
  pending: { readonly key: string; readonly turnId: string | null } | null;
}
function actor(body: ObjectValue): { sessionId: string; agentId: string | null } {
  return { sessionId: String(body.session_id), agentId: text(body.agent_id) ? body.agent_id : null };
}
function directory(device: string, owner: ReturnType<typeof actor>): string {
  return join(device, "codex-query-guards", hash(JSON.stringify(owner)));
}
async function readState(file: string, owner: ReturnType<typeof actor>): Promise<QueryState> {
  let row: ObjectValue | null;
  try { row = object(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: "einzbern.codex-query-guard.v1", ...owner, promptDigest: null, blocked: false, pending: null };
    throw error;
  }
  const pending = object(row?.pending);
  const validPending = row?.pending === null || (text(pending?.key) && (pending?.turnId === null || text(pending?.turnId)));
  if (row?.schemaVersion !== "einzbern.codex-query-guard.v1" || row.sessionId !== owner.sessionId ||
      row.agentId !== owner.agentId || typeof row.blocked !== "boolean" ||
      (row.continuation !== undefined && row.continuation !== "native-child" && row.continuation !== "conversation") ||
      (row.rosterRead !== undefined && typeof row.rosterRead !== "boolean") ||
      (row.threadsListed !== undefined && typeof row.threadsListed !== "boolean") ||
      (row.promptDigest !== null && !text(row.promptDigest)) || !validPending) {
    throw new Error("known query guard cannot be recovered");
  }
  return row as unknown as QueryState;
}
async function saveState(file: string, state: QueryState): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(state) + "\n");
}
function queryKey(body: ObjectValue): string {
  return canonicalSha256({ tool: body.tool_name, input: body.tool_input ?? null, toolUseId: body.tool_use_id ?? null });
}
interface Target { readonly threadId: string; readonly hostId: string }
function targets(tool: unknown, input: ObjectValue): Target[] {
  const name = appQueryName(tool);
  const rows = name === "read_thread" ? [input] : name === "wait_threads" && Array.isArray(input.targets) ? input.targets : [];
  const parsed = rows.map(object);
  if (parsed.length === 0 || parsed.some(row => !text(row?.threadId) || (row?.hostId !== undefined && !text(row.hostId)))) return [];
  return parsed.map(row => ({ threadId: String(row!.threadId), hostId: String(row!.hostId ?? "local") }));
}
async function observeChild(device: string, owner: ReturnType<typeof actor>, childId: string, source: unknown): Promise<boolean> {
  const dir = join(directory(device, owner), "children");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, hash(childId) + ".json");
  try {
    const previous = object(JSON.parse(await readFile(file, "utf8")));
    if (previous === null) throw new Error("native child observation cannot be recovered");
    const { digest, ...payload } = previous;
    if (digest !== canonicalSha256(payload) || previous.schemaVersion !== "einzbern.codex-native-child.v1" || previous.sessionId !== owner.sessionId || previous.agentId !== owner.agentId || previous.childId !== childId) throw new Error("native child observation cannot be recovered");
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const payload = { schemaVersion: "einzbern.codex-native-child.v1", ...owner, childId, sourceDigest: canonicalSha256(source) };
  await writeFileAtomic(file, JSON.stringify({ ...payload, digest: canonicalSha256(payload) }) + "\n");
  return true;
}
async function resetForNativeEvent(device: string, owner: ReturnType<typeof actor>): Promise<void> {
  const dir = directory(device, owner);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await withFileLock(join(dir, "write.lock"), async () => {
    const file = join(dir, "state.json");
    const state = await readState(file, owner);
    if (state.pending !== null) return;
    state.blocked = false;
    delete state.continuation;
    delete state.rosterRead;
    delete state.threadsListed;
    await saveState(file, state);
  }, { command: "einzbern codex query guard event reset" });
}
async function nativeChild(device: string, owner: ReturnType<typeof actor>, target: Target): Promise<boolean> {
  if (target.hostId !== "local") return false;
  try {
    const value = object(JSON.parse(await readFile(join(directory(device, owner), "children", hash(target.threadId) + ".json"), "utf8")));
    if (!value) return false;
    const { digest, ...payload } = value;
    if (digest !== canonicalSha256(payload) || value.schemaVersion !== "einzbern.codex-native-child.v1" || value.sessionId !== owner.sessionId || value.agentId !== owner.agentId || value.childId !== target.threadId) throw new Error("native child observation cannot be recovered");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function inProgress(tool: unknown, result: ObjectValue | null, target: Target): boolean {
  if (!result || (Array.isArray(result.errors) && result.errors.length > 0)) return false;
  if (appQueryName(tool) === "read_thread") {
    const thread = object(result.thread);
    const turns = result.turns;
    return thread?.id === target.threadId && String(thread.hostId ?? "local") === target.hostId && Array.isArray(turns) && object(turns[0])?.status === "inProgress" && object(result.page)?.order !== "oldest_first";
  }
  if (!Array.isArray(result.polls)) return false;
  const matches = result.polls.map(object).filter(row => object(row?.thread)?.id === target.threadId && String(object(row?.thread)?.hostId ?? "local") === target.hostId);
  return matches.length === 1 && object(matches[0]?.latestTurn)?.status === "inProgress";
}

export async function runCodexQueryGuard(event: string, body: ObjectValue, device: string, pollingScope: () => Promise<CodexPollingScope>): Promise<{ reasonCode: string; output: string | null }> {
  const unchanged = { reasonCode: "HOOK_PEER_NOT_APPLICABLE", output: null };
  if (!text(body.session_id)) return unchanged;
  if (event === "SubagentStart" && text(body.agent_id)) {
    // The supported event names the parent session and the native subagent id.
    const owner = { sessionId: body.session_id, agentId: null };
    if (await observeChild(device, owner, body.agent_id, body)) await resetForNativeEvent(device, owner);
    return { reasonCode: "HOOK_QUERY_NATIVE_CHILD_OBSERVED", output: null };
  }
  const owner = actor(body);
  if (event === "PostToolUse" && isCodexNativeSpawn(body.tool_name)) {
    const result = codexToolResult(body.tool_response);
    const childId = result?.agent_id ?? result?.task_name;
    if (text(childId) && await observeChild(device, owner, childId, { tool: body.tool_name, result })) await resetForNativeEvent(device, owner);
    return unchanged;
  }
  const tool = appQueryName(body.tool_name);
  const input = object(body.tool_input) ?? {};
  const roster = ["collaboration.list_agents", "collaboration__list_agents", "multi_agent_v1.list_agents", "list_agents"].includes(String(body.tool_name));
  const threadList = tool === "list_threads";
  const query = tool === "read_thread" || tool === "wait_threads" || roster || threadList;
  if (event !== "UserPromptSubmit" && !query) return unchanged;
  const dir = directory(device, owner);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return withFileLock(join(dir, "write.lock"), async () => {
    const file = join(dir, "state.json");
    let state: QueryState;
    try { state = await readState(file, owner); }
    catch (error) {
      if (event === "PreToolUse") return { reasonCode: "HOOK_QUERY_RECOVERY_FAILED", output: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: String(error) } }) + "\n" };
      throw error;
    }
    if (event === "UserPromptSubmit") {
      // Reset from the supported prompt event, never from a changed model turn or
      // summary. Identical text can still be a new actual user request.
      if (text(body.prompt)) {
        state = { schemaVersion: state.schemaVersion, ...owner, promptDigest: canonicalSha256({ turnId: body.turn_id ?? null, prompt: body.prompt }), blocked: false, pending: null };
        await saveState(file, state);
      }
      return unchanged;
    }
    if (roster || threadList) {
      if (event !== "PreToolUse") return unchanged;
      const key = roster ? "rosterRead" : "threadsListed";
      if (state[key]) {
        const scope = await pollingScope();
        if (scope === "none" || (threadList && scope === "native-children")) return denied();
      } else {
        state[key] = true;
        await saveState(file, state);
      }
      return { reasonCode: "HOOK_QUERY_ROSTER_READ", output: null };
    }
    const queried = targets(tool, input);
    const allNativeChildren = async () => queried.length > 0 &&
      (await Promise.all(queried.map(target => nativeChild(device, owner, target)))).every(Boolean);
    if (event === "PreToolUse") {
      if (state.blocked || state.pending !== null) return denied();
      if (state.continuation) {
        const scope = await pollingScope();
        if (scope === "none" || (scope === "native-children" &&
            (state.continuation === "conversation" || !await allNativeChildren()))) return denied();
      }
      state.pending = { key: queryKey(body), turnId: text(body.turn_id) ? body.turn_id : null };
      await saveState(file, state);
      return { reasonCode: "HOOK_QUERY_STARTED", output: null };
    }
    if (event !== "PostToolUse" || state.pending?.key !== queryKey(body) || state.pending.turnId !== (text(body.turn_id) ? body.turn_id : null)) return unchanged;
    const result = codexToolResult(body.tool_response);
    const running = queried.length > 0 && queried.every(target => inProgress(tool, result, target));
    state.pending = null;
    state.blocked = !running;
    delete state.continuation;
    if (running) state.continuation = await allNativeChildren() ? "native-child" : "conversation";
    await saveState(file, state);
    if (running) {
      const scope = await pollingScope();
      if (scope === "authorized-conversations" || (scope === "native-children" && state.continuation === "native-child")) {
        return { reasonCode: state.continuation === "native-child" ? "HOOK_QUERY_CHILD_IN_PROGRESS" : "HOOK_QUERY_CONVERSATION_IN_PROGRESS", output: null };
      }
    }
    return { reasonCode: "HOOK_QUERY_LOOP_ENDED", output: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: reason } }) + "\n" };
  }, { command: "einzbern codex query guard" });
}
