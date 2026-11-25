// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { type CodexCall } from "./codex-local-rpc.js";
import type { CodexPeerBatch } from "./codex-peer-batch.js";
import { recordHostNativeEvents, type HostNativeRecord, type HostNativeEvent } from "./native-tool-evidence.js";

export interface NativeWorkerTurn { thread: string; turn: string; startedAt: string; endedAt: string | null; result: string | null }
export interface RecipientReceipt { turnId: string; itemId: string; clientId: string | null; receivedAt: string; timeSource: string }
export interface ReturnIntent { clientId: string; prompt: string; requestedAt: string; method: string; targetTurn: string | null }
type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => v && typeof v === "object" && !Array.isArray(v) ? v as Raw : {};
function page(value: unknown): { rows: Raw[]; next: string | null } {
  const v = obj(value);
  if (!Array.isArray(v.data)) throw new Error("Codex did not return a native page");
  return { rows: v.data.map(obj), next: typeof v.nextCursor === "string" ? v.nextCursor : null };
}
function nativeTime(value: unknown, scale = 1000): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value*scale).getTime()) ? new Date(value*scale).toISOString() : null;
}
function memberIdentity(r: HostNativeRecord): string | null {
  const p = obj(r.providerId);
  return p.status === "observed" && typeof p.value === "string" ? p.value : null;
}
function threadPath(r: Raw): unknown { return obj(obj(obj(r.source).subAgent).thread_spawn).agent_path; }

/** Only exact direct children from the retained native spawn return can supply a result. */
export async function nativeWorkerTurns(call: CodexCall, receipt: CodexPeerBatch): Promise<{ records: HostNativeRecord[]; times: Record<string, NativeWorkerTurn> }> {
  const parent = receipt.manifest.coordinator.conversationId;
  const wanted = new Set(receipt.records.map(memberIdentity).filter(id => id !== null));
  const children: Raw[] = [];
  // Fresh names can recur across batches. Read a complete parent-filtered roster, including archived children.
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const visited = new Set<string>();
    do {
      const p = page(await call("thread/list", { parentThreadId: parent, sourceKinds: ["subAgent","subAgentThreadSpawn"], archived, limit: 100, cursor }));
      children.push(...p.rows.filter(t => t.parentThreadId === parent && (wanted.has(String(t.id)) || wanted.has(String(threadPath(t))))));
      cursor = p.next;
      if (cursor && visited.has(cursor)) throw new Error("Codex child roster cursor repeated");
      if (cursor) visited.add(cursor);
    } while (cursor);
  }
  const records: HostNativeRecord[] = [], times: Record<string, NativeWorkerTurn> = {};
  for (const record of receipt.records) {
    const attempt = record.preparation.attempt!;
    const id = memberIdentity(record);
    if (!id) continue;
    const spawn = record.events.find(e => e.kind === "host-response" && e.providerId && e.sourceTool?.endsWith("spawn_agent"));
    const matches = children.filter(t => {
      const at = nativeTime(t.createdAt);
      return at && (t.id === id || threadPath(t) === id) && Date.parse(at) + 999 >= Date.parse(attempt.requestedAt) &&
        (!spawn || Date.parse(at) <= Date.parse(spawn.at));
    });
    if (matches.length !== 1 || typeof matches[0]!.id !== "string") continue;
    const child = matches[0]!, thread = child.id as string;
    const created = nativeTime(child.createdAt);
    if (!created || Date.parse(created) + 999 < Date.parse(attempt.requestedAt)) continue;
    const response = await call("thread/turns/list", { threadId: thread, limit: 2, sortDirection: "asc", itemsView: "summary" });
    const p = page(response);
    // A resumed turn is another execution and must be reconciled explicitly.
    if (p.next || p.rows.length !== 1) continue;
    const turn = p.rows[0]!, start = nativeTime(turn.startedAt), end = nativeTime(turn.completedAt);
    if (!start || !turn.id || Date.parse(start) + 999 < Date.parse(attempt.requestedAt)) continue;
    const final = (Array.isArray(turn.items) ? turn.items.map(obj) : []).findLast(item => item.type === "agentMessage" && item.phase === "final_answer");
    times[attempt.id] = { thread, turn: String(turn.id), startedAt: start, endedAt: end, result: typeof final?.text === "string" ? final.text : null };
    if (record.executionFinality === "confirmed" || !end || !["completed","failed","interrupted"].includes(String(turn.status))) continue;
    const event: HostNativeEvent = { id: "native-turn-" + turn.id, at: new Date().toISOString(), kind: "host-response",
      sourceTool: "thread/turns/list", sourceRef: thread + "/" + turn.id, raw: { request: { threadId: thread }, result: response },
      status: { pointer: "/result/data/0/status", mapping: { completed: "completed", failed: "failed", interrupted: "cancelled" } },
      terminal: { pointer: "/result/data/0/status", values: ["completed","failed","interrupted"], contract: "Codex App Server terminal turn with completedAt" },
      association: { localAttemptId: attempt.id, basis: "Unique native spawn identity in the coordinator's direct child roster and unique turn since the preparation" } };
    records.push(recordHostNativeEvents(record.preparation, [event], record));
  }
  return { records, times };
}

function retainedFinal(record: HostNativeRecord): string | null {
  for (const event of record.events.toReversed()) {
    if (!event.terminal || !event.terminal.pointer.startsWith("/")) continue;
    let value: unknown = event.raw;
    for (const token of event.terminal.pointer.slice(1).split("/")) {
      const key = token.replaceAll("~1","/").replaceAll("~0","~");
      if (!value || typeof value !== "object" || !Object.hasOwn(value,key)) { value = null; break; }
      value = Reflect.get(value,key);
    }
    const fields = obj(value);
    for (const key of ["completed","failed","cancelled"]) if (typeof fields[key] === "string") return fields[key] as string;
  }
  return null;
}

export function batchReport(receipt: CodexPeerBatch, times: Record<string, NativeWorkerTurn>, source: string): string {
  const lines = [receipt.reportPrefix.trimEnd(), "实施批次 " + receipt.manifest.batchId + " 已结束。尝试 " + receipt.manifest.attemptId + "。"];
  for (const r of receipt.records) {
    const a = r.preparation.attempt!, request = r.preparation.decision.request;
    const report = r.events.findLast(e => e.kind === "work-report")?.report;
    const observed = times[a.id];
    lines.push(request.workId + " r" + request.workRevision + " · " + r.execution + " · " + r.taskOutcome);
    const result = report?.summary || observed?.result || retainedFinal(r);
    lines.push(result ? result.slice(0, 3000) : "成员终态已核实。宿主未返回成果正文，交付仍待核对。");
    if (result && result.length > 3000) lines.push("完整成果正文见批次证据。");
    if (report?.checks.length) lines.push("实施自测 " + report.checks.join("，"));
    if (report?.limitations.length) lines.push("缺口 " + report.limitations.join("，"));
    lines.push("证据 " + (report?.artifacts.join("，") || r.events.at(-1)?.sourceRef || a.id));
  }
  lines.push("完整批次证据 " + source, "请按证据接续实施；正式验收按 INIT 执行。");
  return lines.join("\n");
}

/** The handoff marker is plain text. Only the actual recipient item supplies the clock. */
export async function nativeBatchHandoff(call: CodexCall, coordinator: string, batch: string, attempt: string, since: string, before: string): Promise<{receivedAt:string;evidence:string} | null> {
  const marker = "Einzbern-Batch: " + batch + "/" + attempt;
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const p = page(await call("thread/turns/list", {threadId:coordinator,limit:5,sortDirection:"desc",itemsView:"summary",cursor}));
    for (const turn of p.rows) {
      const inputs = (Array.isArray(turn.items) ? turn.items.map(obj) : []).filter(item => item.type === "userMessage");
      for (const [index,item] of inputs.entries()) {
        if (!Array.isArray(item.content) || !item.content.map(obj).some(i => typeof i.text === "string" && i.text.split("\n",1)[0] === marker)) continue;
        const receivedAt = nativeTime(item.startedAtMs,1) ?? (index === 0 ? nativeTime(turn.startedAt) : null);
        if (receivedAt && Date.parse(receivedAt) <= Date.parse(before)) return {receivedAt,evidence:coordinator + "/" + turn.id + "/" + item.id};
      }
      const end = nativeTime(turn.completedAt);
      if (end && Date.parse(end) < Date.parse(since)) return null;
    }
    cursor = p.next;
    if (cursor && cursors.has(cursor)) throw new Error("Codex handoff cursor repeated");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return null;
}

/** The destination is read once before sending and once for readback. An ambiguous send is never retried. */
export async function deliverBatch(call: CodexCall, main: string, marker: string, prompt: string, since: string,
  existing: ReturnIntent | null, saveIntent: (intent: ReturnIntent) => Promise<void>): Promise<RecipientReceipt> {
  let intent = existing;
  let active: string | null = null;
  async function findReceipt(beforeSend: boolean): Promise<RecipientReceipt | null> {
    let cursor: string | null = null;
    const visited = new Set<string>();
    do {
      const p = page(await call("thread/turns/list", { threadId: main, limit: 5, sortDirection: "desc", itemsView: "summary", cursor }));
      for (const t of p.rows) {
        if (beforeSend && t.status === "inProgress") active = String(t.id);
        for (const item of (Array.isArray(t.items) ? t.items.map(obj) : [])) {
          if (item.type !== "userMessage" || !Array.isArray(item.content)) continue;
          const body = item.content.map(obj).find(c => c.type === "text" && typeof c.text === "string" && c.text.startsWith(marker))?.text;
          if (!body) continue;
          if (!intent || item.clientId !== intent.clientId || body !== intent.prompt) throw new Error("Existing marked report at destination; reconcile its original sender receipt before taking further action");
          const received = nativeTime(item.startedAtMs, 1) ?? nativeTime(item.completedAtMs, 1);
          return { turnId: String(t.id), itemId: String(item.id), clientId: intent.clientId, receivedAt: received ?? new Date().toISOString(), timeSource: received ? "native-item" : "recipient-readback-upper-bound" };
        }
      }
      if (p.rows.some(t => { const end = nativeTime(t.completedAt); return end && Date.parse(end) < Date.parse(since); })) return null;
      cursor = p.next;
      if (cursor && visited.has(cursor)) throw new Error("Codex destination cursor repeated");
      if (cursor) visited.add(cursor);
    } while (cursor);
    return null;
  }
  const found = await findReceipt(true);
  if (found) return found;
  if (intent) throw new Error("Delivery outcome unknown; retain intent and reconcile by client message ID");
  intent = { clientId: randomUUID(), prompt, requestedAt: new Date().toISOString(), method: active ? "turn/steer" : "turn/start", targetTurn: active };
  await saveIntent(intent);
  const sent = obj(await call(intent.method, { threadId: main, clientUserMessageId: intent.clientId, input: [{ type: "text", text: prompt }], ...(active ? { expectedTurnId: active } : {}) }));
  if (!(typeof sent.turnId === "string" || typeof obj(sent.turn).id === "string")) throw new Error("Native send returned no turn identity");
  const delivered = await findReceipt(false);
  if (!delivered) throw new Error("Native send accepted; recipient readback outstanding");
  return delivered;
}
