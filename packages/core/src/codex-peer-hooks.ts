// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { withFileLock } from "./file-lock.js";
import { isCodexIndependentCreate, isCodexNativeSpawn } from "./codex-tool-identity.js";
import { isRecognizedEnrolledThreadReadSource } from "./codex-peer-batch.js";
import type { CodexPeerBatch } from "./codex-peer-batch.js";
import { canonicalJson, canonicalSha256, parseStrictInstant } from "../../protocol/src/index.js";
import { readCodexConversationSettings } from "./machine-settings.js";
import { codexToolResult, runCodexQueryGuard, type CodexPollingScope } from "./codex-query-guard.js";
import { hasCodexReportSessionSetting, hasCodexSettingsOverride } from "./codex-peer-settings.js";

type ObjectValue = Record<string, unknown>;
interface PeerTurn {
  readonly schemaVersion: "einzbern.codex-peer-hook.v1";
  readonly sessionId: string;
  readonly turnId: string;
  readonly manifestDigest: string;
  readonly mainId: string;
  readonly coordinatorId: string;
  readonly allTerminal: boolean;
  readonly reportEligible: boolean;
  readonly deliveryStatus: string;
  readonly workerIds?: readonly string[];
  handedOff: boolean;
  deliveryAttempted: boolean;
  stopPrompted: boolean;
}

export interface PeerHookResult {
  readonly reasonCode: string;
  readonly output: string | null;
}

const SEND = "mcp__codex_app__send_message_to_thread";
const TURN_START = "turn/start";
const WAIT = "mcp__codex_app__wait_threads";
const READ = "mcp__codex_app__read_thread";
const DELIVERY_REASON = "This coordinator's recorded batch is terminal, but no return attempt was observed. Load Mana Orchestrate and follow its Codex batch-delivery procedure. If the existing authorization covers delivery, send the batch result to the recorded main conversation and retain the receipt. A local final reply is not cross-conversation delivery. Report unavailable capability or permission instead of retrying blindly.";

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Consume structured tool results only. Never interpret a shell command or a transcript.

function statePath(device: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(device, "cache", "codex-peer-hooks", `${key}.json`);
}

async function readTurn(file: string, sessionId: string, turnId: string): Promise<PeerTurn | null> {
  let value: ObjectValue | null;
  try { value = object(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
  if (value?.schemaVersion !== "einzbern.codex-peer-hook.v1" || value.sessionId !== sessionId || value.turnId !== turnId) return null;
  if (!["manifestDigest", "mainId", "coordinatorId", "deliveryStatus"].every(key => text(value[key]))) return null;
  if (!["allTerminal", "reportEligible", "handedOff", "deliveryAttempted", "stopPrompted"].every(key => typeof value[key] === "boolean")) return null;
  return value as unknown as PeerTurn;
}

async function saveTurn(file: string, state: PeerTurn): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

/** Called only after the engine has validated and retained a native peer receipt. */
export async function stageCodexPeerReceipt(receipt: CodexPeerBatch, device: string, sessionId: string | undefined): Promise<void> {
  const manifest = receipt.manifest;
  if (!sessionId || ![manifest.main.conversationId, manifest.coordinator.conversationId].includes(sessionId)) return;
  const workerIds = receipt.records.flatMap(record => {
    const provider = object(record.providerId);
    return provider?.status === "observed" && text(provider.value) ? [provider.value] : [];
  });
  const handoffBound = await bindHandoff(receipt, device);
  for (const participant of [manifest.main.conversationId, manifest.coordinator.conversationId]) {
    const file = statePath(device, participant);
    const previous = await readTurn(`${file}.receipt`, participant, "pending");
    const same = previous?.manifestDigest === canonicalSha256(manifest) ? previous : null;
    const state: PeerTurn = {
      schemaVersion: "einzbern.codex-peer-hook.v1", sessionId: participant, turnId: "pending",
      manifestDigest: canonicalSha256(manifest), mainId: manifest.main.conversationId, coordinatorId: manifest.coordinator.conversationId,
      allTerminal: receipt.allTerminal, reportEligible: receipt.reportEligible, deliveryStatus: receipt.deliveryStatus,
      workerIds, handedOff: same?.handedOff === true || (participant === manifest.main.conversationId && handoffBound), deliveryAttempted: same?.deliveryAttempted ?? false, stopPrompted: same?.stopPrompted ?? false,
    };
    // A derived participant index is written by the validated receipt path for
    // both peers. It does not assert a native parent/child relationship.
    await saveTurn(`${file}.receipt`, state);
    await saveTurn(`${file}.pending`, state);
  }
}

async function takeReceipt(file: string, sessionId: string): Promise<PeerTurn | null> {
  const claimed = `${file}.${randomUUID()}.claimed`;
  try { await rename(`${file}.pending`, claimed); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try { return await readTurn(claimed, sessionId, "pending"); }
  finally { await rm(claimed, { force: true }); }
}

/** Resolve polling from the actual caller, active enrollment and device settings. */
export async function resolveCodexPollingPolicy(device: string, sessionId: string | undefined, agentId?: string): Promise<{
  readonly mode: "single-conversation" | "dual-conversation" | "unknown";
  readonly scope: CodexPollingScope;
  readonly reasonCode: string;
  readonly detail?: string;
}> {
  if (!sessionId) return { mode: "unknown", scope: "none", reasonCode: "CODEX_POLLING_SESSION_UNKNOWN" };

  let settings;
  try { settings = await readCodexConversationSettings(device); }
  catch (error) { return { mode: "unknown", scope: "none", reasonCode: "CODEX_POLLING_SETTINGS_UNAVAILABLE", detail: String(error) }; }

  if (!settings.dualConversation) {
    if (agentId) return { mode: "single-conversation", scope: "none", reasonCode: "CODEX_POLLING_WORKER" };
    const role = await readCodexPeerRole(device, sessionId);
    if (role.status === "error") return { mode: "single-conversation", scope: "none", reasonCode: "CODEX_POLLING_ROLE_UNAVAILABLE", detail: role.reason };
    if (role.status === "retired") return { mode: "single-conversation", scope: "none", reasonCode: "CODEX_POLLING_ROLE_RETIRED" };
    if (role.status === "active") return { mode: "single-conversation", scope: "none", reasonCode: "CODEX_POLLING_DUAL_DISABLED_COORDINATOR" };
    return { mode: "single-conversation", scope: "native-children", reasonCode: "CODEX_POLLING_SINGLE_CONVERSATION" };
  }

  if (!agentId) {
    const role = await readCodexPeerRole(device, sessionId);
    if (role.status === "error") return { mode: "dual-conversation", scope: "none", reasonCode: "CODEX_POLLING_ROLE_UNAVAILABLE", detail: role.reason };
    if (role.status === "retired") return { mode: "dual-conversation", scope: "none", reasonCode: "CODEX_POLLING_ROLE_RETIRED" };
    if (role.status === "active") return { mode: "dual-conversation", scope: "native-children", reasonCode: "CODEX_POLLING_COORDINATOR" };
  }

  return settings.allowNonCoordinatorPolling
    ? { mode: "dual-conversation", scope: "authorized-conversations", reasonCode: "CODEX_POLLING_ENABLED" }
    : { mode: "dual-conversation", scope: "none", reasonCode: "CODEX_POLLING_DISABLED" };
}

/** Receipt/cache observations grant no dispatch or messaging authority. */
export async function runCodexPeerHook(event: string, payload: unknown, device: string): Promise<PeerHookResult> {
  const body = object(payload);
  const unchanged = { reasonCode: "HOOK_PEER_NOT_APPLICABLE", output: null };
  if (body === null || !text(body.session_id)) return unchanged;
  const tool = body.tool_name;
  if (event === "PostToolUse" && tool === SEND && hasCodexSettingsOverride(body.tool_input)) {
    const { observeCodexSettingsResult } = await import("./codex-peer-settings.js");
    await observeCodexSettingsResult(device, body);
  }
  const sessionId = body.session_id;
  const workerObservation = /^(?:(?:collaboration|multi_agent_v1)(?:__|\.))?(?:wait_agent|list_agents)$/u.test(String(tool)) || tool === WAIT || tool === READ;
  if (!body.agent_id && (event === "Stop" || (event === "PostToolUse" && workerObservation))) {
    if ((await resolveCodexPollingPolicy(device, sessionId)).scope === "native-children") {
      const { advanceBatchRun } = await import("./codex-batch-run.js");
      await advanceBatchRun(device, sessionId);
    }
  }
  if (event === "PreToolUse" && tool === SEND && !body.agent_id) {
    const prompt = object(body.tool_input)?.prompt;
    const marker = typeof prompt === "string" ? /^Einzbern-Codex-Peer-Manifest-SHA256: ([a-f0-9]{64})\n/u.exec(prompt) : null;
    if (marker && await (await import("./codex-batch-run.js")).automaticReturnPendingOrReceived(device, sessionId, marker[1]!)) {
      return denyPeer("CODEX_BATCH_DELIVERY_RETAINED", "This batch already has a delivery attempt. Read its batch ledger and reconcile the recipient receipt.");
    }
  }
  const query = await runCodexQueryGuard(event, body, device, async () =>
    (await resolveCodexPollingPolicy(device, body.session_id, text(body.agent_id) ? body.agent_id : undefined)).scope);
  if (query.reasonCode !== "HOOK_PEER_NOT_APPLICABLE") return query;
  if (event === "PreToolUse" && tool === SEND) {
    const problem = await codexPeerReportDispatchProblem(device, body.session_id, SEND, body.tool_input);
    if (problem) return denyPeer(problem.reasonCode, problem.reason);
  }
  if (event === "PreToolUse" && tool === SEND && hasCodexReportSessionSetting(body.tool_input)) {
    const role = await readCodexPeerRole(device, body.session_id);
    if (role.status === "error") return denyPeer("HOOK_PEER_ROLE_RECOVERY_FAILED", role.reason);
    const input = object(body.tool_input) ?? {};
    if (role.status === "active" && input.threadId === role.role.mainId && (input.hostId === undefined || input.hostId === "local")) {
      try {
        if (!hasCodexSettingsOverride(body.tool_input)) return denyPeer("HOOK_PEER_SETTINGS_DENIED", "Ordinary reports omit model, thinking, effort, serviceTier and serviceTierForTurn. Only the existing explicit model/thinking adjustment supports a separate Owner decision.");
        const { consumeCodexSettingsIntent } = await import("./codex-peer-settings.js");
        if (!await consumeCodexSettingsIntent(device, body)) return denyPeer("HOOK_PEER_SETTINGS_DENIED", "Ordinary reports omit model/thinking. Load Mana Orchestrate; prepare an explicitly authorized settings adjustment with its exact native arguments and existing Owner decision.");
      } catch (error) { return denyPeer("HOOK_PEER_SETTINGS_DENIED", String(error)); }
    }
  }
  if (event === "PreToolUse" && (isCodexIndependentCreate(tool) || isCodexNativeSpawn(tool))) {
    const role = await readCodexPeerRole(device, body.session_id);
    if (role.status === "error") return denyPeer("HOOK_PEER_ROLE_RECOVERY_FAILED", `Load Mana Orchestrate. ${role.reason}; recover the enrolled role before dependent dispatch.`);
    if (role.status === "active" && isCodexIndependentCreate(tool)) return denyPeer("HOOK_PEER_WORKER_TOOL_DENIED", "This enrolled Codex coordinator must load Mana Orchestrate and dispatch workers with collaboration.spawn_agent. Independent create_thread/fork_thread cannot be used as workers.");
    if (role.status === "active" && isCodexNativeSpawn(tool) && (await resolveCodexPollingPolicy(device, body.session_id)).mode === "single-conversation") {
      return denyPeer("HOOK_PEER_DUAL_MODE_DISABLED", "Codex dual-conversation mode is disabled. The enrolled Economy coordinator cannot dispatch another worker; Main must coordinate its own native workers.");
    }
  }
  if (!text(body.turn_id)) return unchanged;
  if (!["Stop", "UserPromptSubmit"].includes(event) && ![SEND, WAIT, READ, "Bash"].includes(String(tool))) return unchanged;
  const file = statePath(device, body.session_id);
  if (event === "UserPromptSubmit") {
    await rm(file, { force: true });
    return unchanged;
  }
  let state = await readTurn(file, body.session_id, body.turn_id);
  const retained = await readTurn(`${file}.receipt`, body.session_id, "pending");
  if (retained && state?.manifestDigest !== retained.manifestDigest) {
    state = { ...retained, turnId: body.turn_id };
    await saveTurn(file, state);
  }
  const input = object(body.tool_input) ?? {};

  if (event === "PostToolUse") {
    const receipt = tool === "Bash" ? await takeReceipt(file, body.session_id) : null;
    if (receipt !== null) {
      const previous = state?.manifestDigest === receipt.manifestDigest ? state : null;
      state = {
        ...receipt, turnId: body.turn_id,
        handedOff: previous?.handedOff === true, deliveryAttempted: previous?.deliveryAttempted === true,
        stopPrompted: previous?.stopPrompted === true,
      };
      await saveTurn(file, state);
      return { reasonCode: "HOOK_PEER_RECEIPT_OBSERVED", output: null };
    }
    const result = codexToolResult(body.tool_response);
    if (tool !== SEND || result === null || !text(input.threadId) || result.threadId !== input.threadId) return unchanged;
    // Preserve a successful main-first send even when no receipt/role exists yet.
    // This is an unbound observation, never a fabricated batch or dispatch permit.
    if (!text(body.agent_id)) await observeHandoff(device, body.session_id, input, result);
    if (state === null) return { reasonCode: "HOOK_PEER_HANDOFF_OBSERVED", output: null };
    if (body.session_id === state.mainId && input.threadId === state.coordinatorId) {
      return { reasonCode: "HOOK_PEER_HANDOFF_OBSERVED", output: null };
    }
    return unchanged;
  }

  if (state === null) return unchanged;
  if (event === "PreToolUse") {
    if (tool === SEND && !(await import("./codex-peer-settings.js")).hasCodexSettingsOverride(input) && body.session_id === state.coordinatorId && input.threadId === state.mainId) {
      // An attempted send with no result is unknown, never an invitation to resend.
      state.deliveryAttempted = true;
      await saveTurn(file, state);
      await saveTurn(`${file}.receipt`, { ...state, turnId: "pending" });
      return { reasonCode: "HOOK_PEER_DELIVERY_ATTEMPTED", output: null };
    }
    return unchanged;
  }

  if (event === "Stop" && body.session_id === state.coordinatorId && state.reportEligible && state.allTerminal &&
      state.deliveryStatus === "not-attempted" && !state.deliveryAttempted && !state.stopPrompted && body.stop_hook_active === false) {
    if ((await resolveCodexPollingPolicy(device, sessionId)).scope !== "native-children") return unchanged;
    if (await (await import("./codex-batch-run.js")).automaticReturnPendingOrReceived(device, sessionId, state.manifestDigest)) return unchanged;
    state.stopPrompted = true;
    await saveTurn(file, state);
    await saveTurn(`${file}.receipt`, { ...state, turnId: "pending" });
    return { reasonCode: "HOOK_PEER_DELIVERY_REMINDER", output: JSON.stringify({ decision: "block", reason: DELIVERY_REASON }) + "\n" };
  }
  return unchanged;
}

function handoffPath(device: string, sourceId: string, targetId: string, hostId: string): string {
  return join(device, "codex-peer-handoffs", canonicalSha256({ sourceId, targetId, hostId }) + ".json");
}
async function handoffState(file: string, sourceId: string, targetId: string, hostId: string): Promise<ObjectValue> {
  try {
    const row = object(JSON.parse(await readFile(file, "utf8")));
    if (!row) throw new Error("invalid handoff state");
    const { digest, ...payload } = row;
    if (digest !== canonicalSha256(payload) || row.schemaVersion !== "einzbern.codex-handoff-observation.v1" || row.sourceId !== sourceId || row.targetId !== targetId || row.hostId !== hostId || !object(row.bindings)) throw new Error("known handoff observation cannot be recovered");
    return payload;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { schemaVersion: "einzbern.codex-handoff-observation.v1", sourceId, targetId, hostId, latest: null, bindings: {} };
  }
}
async function observeHandoff(device: string, sessionId: string, input: ObjectValue, result: ObjectValue): Promise<void> {
  if (!text(input.threadId)) return;
  const hostId = String(input.hostId ?? "local");
  const file = handoffPath(device, sessionId, input.threadId, hostId);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await withFileLock(`${file}.lock`, async () => {
    const prior = await handoffState(file, sessionId, String(input.threadId), hostId);
    const payload = { ...prior, latest: { observedAt: new Date().toISOString(), inputDigest: canonicalSha256(input), resultDigest: canonicalSha256(result), manifestDigest: null } };
    await writeFileAtomic(file, JSON.stringify({ ...payload, digest: canonicalSha256(payload) }) + "\n");
  }, { command: "einzbern handoff observation" });
}
async function bindHandoff(receipt: CodexPeerBatch, device: string): Promise<boolean> {
  const manifest = receipt.manifest;
  const file = handoffPath(device, manifest.main.conversationId, manifest.coordinator.conversationId, "local");
  try { await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  return withFileLock(`${file}.lock`, async () => {
    const state = await handoffState(file, manifest.main.conversationId, manifest.coordinator.conversationId, "local");
    const digest = canonicalSha256(manifest);
    const bindings = object(state.bindings)!;
    if (object(bindings[digest])) return true;
    const latest = object(state.latest);
    if (!latest || latest.manifestDigest !== null || !text(latest.observedAt) || receipt.records.length === 0 || receipt.records.some(record => parseStrictInstant(record.preparation.attempt!.requestedAt) <= parseStrictInstant(String(latest.observedAt)))) return false;
    // Identity, native order and exclusive consumption associate observed facts.
    // They do not authenticate the message's natural-language handoff intent.
    const bound = { ...latest, manifestDigest: digest, batchId: manifest.batchId, attemptId: manifest.attemptId };
    const payload = { ...state, latest: bound, bindings: { ...bindings, [digest]: bound } };
    await writeFileAtomic(file, JSON.stringify({ ...payload, digest: canonicalSha256(payload) }) + "\n");
    return true;
  }, { command: "einzbern handoff association" });
}

export interface CodexPeerRole {
  readonly schemaVersion: "einzbern.codex-peer-role.v1";
  readonly host: "codex";
  readonly coordinatorId: string;
  readonly mainId: string;
  readonly libraryId: string;
  readonly status: "active" | "retired";
  readonly actor: string;
  readonly recordedAt: string;
  readonly decidedIn: string | null;
  readonly previousDigest: string | null;
  readonly receipt: CodexPeerBatch;
  readonly digest: string;
}
export type CodexPeerRoleRead =
  | { readonly status: "unbound" }
  | { readonly status: "error"; readonly reason: string }
  | { readonly status: "active" | "retired"; readonly role: CodexPeerRole };

function reportText(toolName: string, input: ObjectValue | null): string | null {
  if (toolName === SEND) return typeof input?.prompt === "string" ? input.prompt : null;
  if (toolName !== TURN_START || !Array.isArray(input?.input)) return null;
  const item = input.input.map(value => object(value)).find(value => value?.type === "text" && typeof value.text === "string");
  return typeof item?.text === "string" ? item.text : null;
}

function reportArgumentsProblem(toolName: string, input: ObjectValue): string | null {
  const allowed = toolName === SEND ? ["threadId", "hostId", "prompt"] : ["threadId", "input", "clientUserMessageId"];
  const unsupported = Object.keys(input).filter(key => !allowed.includes(key));
  if (unsupported.length > 0) return `ordinary ${toolName} report contains unsupported fields: ${unsupported.join(", ")}`;
  if (!text(input.threadId)) return `ordinary ${toolName} report needs a nonempty threadId`;

  if (toolName === SEND) {
    if (!text(input.prompt)) return "ordinary send_message_to_thread report needs a nonempty prompt";
    if (input.hostId !== undefined && !text(input.hostId)) return "ordinary send_message_to_thread report hostId must be nonempty when supplied";
    return null;
  }

  if (!Array.isArray(input.input) || input.input.length !== 1) return "ordinary turn/start report needs exactly one text input";
  const message = object(input.input[0]);
  if (message === null || Object.keys(message).some(key => !["type", "text", "text_elements"].includes(key)) || message.type !== "text" || !text(message.text)) {
    return "ordinary turn/start report input must be one text input with nonempty text";
  }
  if (Object.hasOwn(message, "text_elements") && (!Array.isArray(message.text_elements) || message.text_elements.length > 0)) {
    return "ordinary turn/start report text_elements must be an empty array when supplied";
  }
  if (Object.hasOwn(input, "clientUserMessageId") && input.clientUserMessageId !== null && !text(input.clientUserMessageId)) {
    return "turn/start clientUserMessageId must be nonempty when supplied";
  }
  return null;
}

function mainHostId(manifest: CodexPeerBatch["manifest"]): string {
  let nativeMain: unknown = manifest.main.raw;
  for (const segment of manifest.main.conversationPointer.split("/").slice(1, -1)) {
    nativeMain = object(nativeMain)?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  const value = object(nativeMain)?.hostId;
  return typeof value === "string" && value.length > 0 ? value : "local";
}

/** The existing report marker binds a batch report; ordinary bound-Main reports get a narrow argument preflight. */
export async function codexPeerReportDispatchProblem(
  device: string,
  sessionId: string | undefined,
  toolName: string,
  argumentsValue: unknown,
  work?: { readonly libraryId: string; readonly workId: string; readonly workRevision: number },
  ordinaryReport = true,
): Promise<{ reasonCode: string; reason: string } | null> {
  const input = object(argumentsValue);
  if (toolName !== SEND && toolName !== TURN_START) return null;
  const prompt = reportText(toolName, input);
  const marked = typeof prompt === "string" && /^Einzbern-Codex-Peer-Manifest-SHA256:/mu.test(prompt);
  if (!marked && !ordinaryReport) return null;
  const role = sessionId ? await readCodexPeerRole(device, sessionId) : { status: "unbound" as const };
  if (!marked && role.status !== "active") return null;
  if (role.status === "error") {
    return {
      reasonCode: "HOOK_PEER_ROLE_RECOVERY_FAILED",
      reason: `Load Mana Orchestrate. ${role.reason}; recover the enrolled role before preparing this batch report.`,
    };
  }
  if (role.status !== "active") {
    return {
      reasonCode: "HOOK_PEER_REPORT_BINDING_DENIED",
      reason: "This batch report needs the current native coordinator session's active durable role. Load Mana Orchestrate and recover the existing role/manifest; native workers return with final.",
    };
  }
  const manifest = role.role.receipt.manifest;
  const source = `role.receipt.manifest.main (${manifest.main.sourceRef})`;
  const binding = `batch ${manifest.batchId}/${manifest.attemptId}`;
  if (marked) {
    const { codexPeerReportPrefix } = await import("./codex-peer-batch.js");
    if (!prompt!.startsWith(codexPeerReportPrefix(manifest))) {
      return {
        reasonCode: "HOOK_PEER_REPORT_BINDING_DENIED",
        reason: `Report marker differs from the current ${binding}. Read the durable role receipt's reportPrefix and ${source}; put that exact prefix, including LF, first.`,
      };
    }
    if (hasCodexReportSessionSetting(argumentsValue)) {
      return {
        reasonCode: "HOOK_PEER_REPORT_SETTINGS_DENIED",
        reason: "Batch reports omit model, thinking, effort, serviceTier and serviceTierForTurn; delivery inherits the bound recipient's session settings.",
      };
    }
    const works = [{ workId: manifest.workId, workRevision: manifest.workRevision }, ...manifest.members];
    if (work && (work.libraryId !== role.role.libraryId || !works.some(member => member.workId === work.workId && member.workRevision === work.workRevision))) {
      return {
        reasonCode: "HOOK_PEER_REPORT_BINDING_DENIED",
        reason: `Report work/library differs from the current ${binding}; read the durable role receipt's manifest and current work before preparing delivery.`,
      };
    }
  } else {
    if (input?.threadId !== manifest.main.conversationId) return null;
    if (hasCodexReportSessionSetting(argumentsValue)) {
      const hostId = mainHostId(manifest);
      if (toolName === SEND && (input.hostId ?? "local") !== hostId) {
        return {
          reasonCode: "HOOK_PEER_REPORT_RECIPIENT_DENIED",
          reason: `This native session is coordinator ${role.role.coordinatorId}. The report must use threadId=${manifest.main.conversationId}, hostId=${String(hostId)} from ${source}.`,
        };
      }
      return null;
    }
  }

  if (input === null) {
    return {
      reasonCode: "HOOK_PEER_REPORT_ARGUMENTS_DENIED",
      reason: `ordinary ${toolName} report arguments must be an object; reports to Main use only their supported recipient, text body and optional deduplication ID.`,
    };
  }
  const malformed = reportArgumentsProblem(toolName, input);
  if (malformed) {
    return {
      reasonCode: "HOOK_PEER_REPORT_ARGUMENTS_DENIED",
      reason: `${malformed}; reports to Main use only their supported recipient, text body and optional deduplication ID.`,
    };
  }

  const hostId = mainHostId(manifest);
  if (input.threadId !== manifest.main.conversationId || (toolName === SEND && (input.hostId ?? "local") !== hostId)) {
    return {
      reasonCode: "HOOK_PEER_REPORT_RECIPIENT_DENIED",
      reason: `This native session is coordinator ${role.role.coordinatorId}. The current ${binding} report must use threadId=${manifest.main.conversationId}${toolName === SEND ? `, hostId=${String(hostId)}` : ""} from ${source}. Correct the arguments explicitly; worker return instructions do not change the coordinator's recipient.`,
    };
  }
  return null;
}

/** Backward-compatible native send preflight entry. */
export async function codexPeerReportRecipientProblem(
  device: string,
  sessionId: string | undefined,
  argumentsValue: unknown,
  work?: { readonly libraryId: string; readonly workId: string; readonly workRevision: number },
): Promise<{ reasonCode: string; reason: string } | null> {
  return codexPeerReportDispatchProblem(device, sessionId, SEND, argumentsValue, work);
}

export function codexPeerRoleDirectory(device: string, sessionId: string): string {
  return join(device, "codex-peer-roles", createHash("sha256").update(sessionId).digest("hex"));
}

/** A directory/anchor is enrollment knowledge even if its fallible payload is gone. */
export async function readCodexPeerRole(device: string, sessionId: string): Promise<CodexPeerRoleRead> {
  const directory = codexPeerRoleDirectory(device, sessionId);
  try { await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "unbound" };
    return { status: "error", reason: `role directory: ${String(error)}` };
  }
  try {
    const anchor = object(JSON.parse(await readFile(join(directory, "anchor.json"), "utf8")));
    if (anchor?.schemaVersion !== "einzbern.codex-peer-enrollment.v1" || anchor.coordinatorId !== sessionId || !["active", "retired"].includes(String(anchor.status))) throw new Error("invalid enrollment anchor");
    const value = object(JSON.parse(await readFile(join(directory, "role.json"), "utf8")));
    if (value === null) throw new Error("missing role payload");
    const { digest, ...payload } = value;
    if (digest !== canonicalSha256(payload) || value.schemaVersion !== "einzbern.codex-peer-role.v1" ||
        value.host !== "codex" || value.coordinatorId !== sessionId || !["active", "retired"].includes(String(value.status)) ||
        !text(value.libraryId) || !text(value.mainId) || !text(anchor.libraryId) || !text(anchor.mainId) ||
        value.libraryId !== anchor.libraryId || value.mainId !== anchor.mainId || value.status !== anchor.status || !text(value.actor) || !text(value.recordedAt)) throw new Error("invalid role identity, version or digest");
    const { normalizeCodexPeerBatchForEnrolledRole } = await import("./codex-peer-batch.js");
    const receipt = normalizeCodexPeerBatchForEnrolledRole(value.receipt, { coordinatorId: sessionId, mainId: value.mainId });
    if ((receipt.schemaVersion !== "tcrn.codex-peer-batch.v2" && receipt.schemaVersion !== "tcrn.codex-peer-batch.v3") || receipt.manifest.coordinator.conversationId !== sessionId ||
        receipt.manifest.main.conversationId !== value.mainId) throw new Error("role differs from validated peer receipt");
    if (value.status === "retired" && !text(value.decidedIn)) throw new Error("retired role has no lifecycle decision");
    return { status: value.status as "active" | "retired", role: value as unknown as CodexPeerRole };
  } catch (error) {
    return { status: "error", reason: `known coordinator role cannot be recovered: ${String(error)}` };
  }
}

export type CodexPeerHistoricalReceiptResolution =
  | { readonly status: "matched"; readonly identity: { readonly coordinatorId: string; readonly mainId: string } }
  | { readonly status: "wrong-batch" }
  | { readonly status: "tampered" }
  | { readonly status: "unknown-origin" };

/** Resolve only an exact v2 receipt already present in the authenticated role's linked history.
 * This is a read-only compatibility path; it does not make the receipt current or authorize resume. */
export async function resolveCodexPeerHistoricalReceipt(
  device: string,
  value: unknown,
): Promise<CodexPeerHistoricalReceiptResolution> {
  const candidate = object(value);
  const manifest = object(candidate?.manifest);
  const main = object(manifest?.main);
  const coordinator = object(manifest?.coordinator);
  const coordinatorId = text(coordinator?.conversationId) ? coordinator.conversationId : "";
  const mainId = text(main?.conversationId) ? main.conversationId : "";
  const batchId = text(manifest?.batchId) ? manifest.batchId : "";
  const attemptId = text(manifest?.attemptId) ? manifest.attemptId : "";
  if (candidate?.schemaVersion !== "tcrn.codex-peer-batch.v2" || !coordinatorId || !mainId || !batchId || !attemptId ||
      coordinator?.conversationPointer !== "/result/thread/id" ||
      !isRecognizedEnrolledThreadReadSource(coordinator.sourceRef)) {
    return { status: "unknown-origin" };
  }

  const enrolled = await readCodexPeerRole(device, coordinatorId);
  if ((enrolled.status !== "active" && enrolled.status !== "retired") || enrolled.role.mainId !== mainId) {
    return { status: "unknown-origin" };
  }

  const role = enrolled.role;
  const identity = { coordinatorId, mainId };
  const directory = codexPeerRoleDirectory(device, coordinatorId);
  const currentRole = role as unknown as ObjectValue;
  const roleMatches = (historical: ObjectValue, expectedDigest: string): boolean => {
    const { digest, ...payload } = historical;
    return digest === expectedDigest && canonicalSha256(payload) === expectedDigest &&
      historical.schemaVersion === "einzbern.codex-peer-role.v1" && historical.host === "codex" &&
      historical.coordinatorId === role.coordinatorId && historical.mainId === role.mainId &&
      historical.libraryId === role.libraryId && ["active", "retired"].includes(String(historical.status)) &&
      (historical.previousDigest === null || (typeof historical.previousDigest === "string" && /^[a-f0-9]{64}$/u.test(historical.previousDigest)));
  };
  const inspectReceipt = (historical: ObjectValue): "matched" | "same-batch" | "other-batch" | "other" => {
    const receipt = object(historical.receipt);
    const priorManifest = object(receipt?.manifest);
    if (priorManifest?.attemptId !== attemptId) return "other";
    if (priorManifest.batchId !== batchId) return "other-batch";
    if (canonicalJson(receipt) === canonicalJson(candidate)) return "matched";
    return "same-batch";
  };
  const stillEnrolled = async (): Promise<boolean> => {
    const confirmed = await readCodexPeerRole(device, coordinatorId);
    return (confirmed.status === "active" || confirmed.status === "retired") &&
      confirmed.role.digest === role.digest && confirmed.role.mainId === mainId && confirmed.role.libraryId === role.libraryId;
  };

  const currentMatch = inspectReceipt(currentRole);
  if (currentMatch === "matched") {
    return await stillEnrolled() ? { status: "matched", identity } : { status: "unknown-origin" };
  }
  let sawSameBatch = currentMatch === "same-batch";
  let sawOtherBatch = currentMatch === "other-batch";
  let previousDigest: unknown = role.previousDigest;
  const seen = new Set([role.digest]);
  while (previousDigest !== null) {
    if (typeof previousDigest !== "string" || !/^[a-f0-9]{64}$/u.test(previousDigest) || seen.has(previousDigest)) {
      return { status: "unknown-origin" };
    }
    seen.add(previousDigest);
    let historical: ObjectValue | null;
    try {
      historical = object(JSON.parse(await readFile(join(directory, "history", `${previousDigest}.json`), "utf8")));
    } catch {
      return { status: "unknown-origin" };
    }
    if (historical === null || !roleMatches(historical, previousDigest)) return { status: "unknown-origin" };
    const match = inspectReceipt(historical);
    if (match === "matched") {
      return await stillEnrolled() ? { status: "matched", identity } : { status: "unknown-origin" };
    }
    sawSameBatch ||= match === "same-batch";
    sawOtherBatch ||= match === "other-batch";
    previousDigest = historical.previousDigest;
  }
  if (!await stillEnrolled()) return { status: "unknown-origin" };
  if (sawSameBatch) return { status: "tampered" };
  if (sawOtherBatch) return { status: "wrong-batch" };
  return { status: "unknown-origin" };
}

/** Existing peer-record is the only enrollment/lifecycle writer. Authorization is resolved
 * against live minutes by its CLI, never taken from a self-declared tool argument. */
export async function persistCodexPeerRole(input: {
  readonly receipt: CodexPeerBatch;
  readonly device: string;
  readonly sessionId: string | undefined;
  readonly libraryId: string;
  readonly actor: string;
  readonly change?: { readonly operation: "retire" | "activate" | "recover"; readonly decidedIn: string | null };
}): Promise<CodexPeerRole> {
  const settings = await readCodexConversationSettings(input.device);
  if (!settings.dualConversation && input.change?.operation !== "retire") throw new Error("Codex dual-conversation mode is disabled on this device");
  const { normalizeCodexPeerBatch } = await import("./codex-peer-batch.js");
  const receipt = normalizeCodexPeerBatch(input.receipt);
  const manifest = receipt.manifest;
  if (receipt.schemaVersion !== "tcrn.codex-peer-batch.v2" && receipt.schemaVersion !== "tcrn.codex-peer-batch.v3") throw new Error("legacy peer receipt is historical, not role enrollment");
  if (!input.sessionId || ![manifest.main.conversationId, manifest.coordinator.conversationId].includes(input.sessionId)) throw new Error("role enrollment requires the actual native main/coordinator session");
  if (receipt.records.length !== manifest.members.length || receipt.blockedReasons.some(reason => reason === "work-revisions-unknown" || reason === "policy-drift" || reason === "model-groups-not-ready" || reason.startsWith("work-revision-drift:"))) throw new Error("role enrollment needs the current complete set of scoped pending worker preparations and matching work/policy");
  const directory = codexPeerRoleDirectory(input.device, manifest.coordinator.conversationId);
  let existed = true;
  try { await lstat(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") existed = false; else throw error; }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return withFileLock(join(directory, "write.lock"), async () => {
    const prior = await readCodexPeerRole(input.device, manifest.coordinator.conversationId);
    const anchorFile = join(directory, "anchor.json");
    let anchor: ObjectValue | null = null;
    try { anchor = object(JSON.parse(await readFile(anchorFile, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (anchor !== null && (anchor.coordinatorId !== manifest.coordinator.conversationId || anchor.mainId !== manifest.main.conversationId || anchor.libraryId !== input.libraryId)) throw new Error("enrolled peer identity/library changed; retire it through the governed lifecycle first");
    if (prior.status === "error" && (anchor !== null || existed) && !input.change) throw new Error(prior.reason);
    if ((prior.status === "retired" || anchor?.status === "retired") && input.change?.operation !== "activate") throw new Error("retired role needs an explicit governed activation");
    if (input.change && input.change.operation !== "recover" && !input.change.decidedIn) throw new Error("role lifecycle requires a verified Owner decision");
    if (input.change?.operation === "recover" && prior.status === "retired") throw new Error("recovery cannot activate a retired role");
    if (input.change?.operation === "retire" && prior.status !== "active") throw new Error("only a recovered active role can retire");
    const payload = {
      schemaVersion: "einzbern.codex-peer-role.v1" as const, host: "codex" as const,
      coordinatorId: manifest.coordinator.conversationId, mainId: manifest.main.conversationId, libraryId: input.libraryId,
      status: input.change?.operation === "retire" ? "retired" as const : "active" as const,
      actor: input.actor, recordedAt: new Date().toISOString(), decidedIn: input.change?.decidedIn ?? null,
      previousDigest: prior.status === "active" || prior.status === "retired" ? prior.role.digest : null, receipt,
    };
    if (prior.status === "active" || prior.status === "retired") {
      await mkdir(join(directory, "history"), { recursive: true, mode: 0o700 });
      await writeFileAtomic(join(directory, "history", `${prior.role.digest}.json`), JSON.stringify(prior.role) + "\n");
    }
    // The anchor goes first: interrupted writes must leave a known failed enrollment.
    await writeFileAtomic(anchorFile, JSON.stringify({ schemaVersion: "einzbern.codex-peer-enrollment.v1", coordinatorId: payload.coordinatorId, mainId: payload.mainId, libraryId: payload.libraryId, status: payload.status }) + "\n");
    const role: CodexPeerRole = { ...payload, digest: canonicalSha256(payload) };
    await writeFileAtomic(join(directory, "role.json"), JSON.stringify(role) + "\n");
    const recovered = await readCodexPeerRole(input.device, manifest.coordinator.conversationId);
    if ((recovered.status !== "active" && recovered.status !== "retired") || recovered.role.digest !== role.digest) throw new Error("role persistence readback failed");
    return recovered.role;
  }, { command: "einzbern execution-codex-peer-record" });
}

export async function inspectCodexPeerRoles(device: string): Promise<{ readonly ready: boolean; readonly roles: readonly { readonly key: string; readonly status: string; readonly reason: string | null }[] }> {
  let entries;
  try { entries = await readdir(join(device, "codex-peer-roles"), { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ready: true, roles: [] };
    return { ready: false, roles: [{ key: "enrollments", status: "error", reason: String(error) }] };
  }
  const roles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const anchor = object(JSON.parse(await readFile(join(device, "codex-peer-roles", entry.name, "anchor.json"), "utf8")));
      if (!text(anchor?.coordinatorId) || codexPeerRoleDirectory(device, anchor.coordinatorId) !== join(device, "codex-peer-roles", entry.name)) throw new Error("enrollment anchor identity mismatch");
      const read = await readCodexPeerRole(device, anchor.coordinatorId);
      roles.push({ key: entry.name, status: read.status, reason: read.status === "error" ? read.reason : null });
    } catch (error) { roles.push({ key: entry.name, status: "error", reason: String(error) }); }
  }
  return { ready: roles.every(role => role.status === "active" || role.status === "retired"), roles };
}

function denyPeer(reasonCode: string, reason: string): PeerHookResult {
  return { reasonCode, output: JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
  } }) + "\n" };
}
