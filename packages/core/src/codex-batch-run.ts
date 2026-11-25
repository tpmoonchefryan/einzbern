// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalSha256, parseStrictInstant } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { withFileLock } from "./file-lock.js";
import { minutesById } from "./minutes.js";
import { readCodexPeerRole, resolveCodexPollingPolicy } from "./codex-peer-hooks.js";
import { normalizeCodexPeerBatch, recordCodexPeerBatch, type CodexPeerBatch } from "./codex-peer-batch.js";
import { readEngineModelPolicyForReceipt } from "./engine-model-policy.js";
import { materializeWorkspace, type WorkspaceState } from "./workspace.js";
import { batchReport, deliverBatch, nativeWorkerTurns, nativeBatchHandoff, type RecipientReceipt, type ReturnIntent, type NativeWorkerTurn } from "./codex-batch-return.js";
import { withLocalCodex } from "./codex-local-rpc.js";

interface Fill { workId: string; readyAt: string; slotAt: string; evidence: string }
interface Timing { receivedAt: string; evidence: string; fills: Fill[] | null }
interface Entry {
  batch: string; attempt: string; manifest: string; receiptFile: string; sample: number | null; timing: Timing | null;
  peaks?: Record<string, {slots:number;path:string}>; times: Record<string, NativeWorkerTurn>; work: Record<string, string>; intent: ReturnIntent | null; delivered: RecipientReceipt | null;
  phase: "waiting" | "unknown" | "received" | "prior-delivery"; error: string | null;
}
interface Campaign { initiative: string; workspace: string; libraryId: string; decidedIn: string; main: string; coordinator: string; armedAt: string; entries: Entry[] }
interface Ledger { version: 1; campaigns: Campaign[] }
function directory(device: string, id: string): string { return join(device, "codex-batch-runs", canonicalSha256(id)); }
async function load(dir: string): Promise<Ledger> {
  try {
    const ledger = JSON.parse(await readFile(join(dir, "ledger.json"), "utf8")) as Ledger;
    if (ledger.version !== 1 || !Array.isArray(ledger.campaigns)) throw new Error("Invalid batch ledger");
    return ledger;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { version: 1, campaigns: [] }; }
}
const save = (dir: string, ledger: Ledger) => writeFileAtomic(join(dir, "ledger.json"), JSON.stringify({ ...ledger,
  campaigns: ledger.campaigns.map(c => ({...c, entries: c.entries.map(e => ({...e, metrics: turnaroundMetrics(e)}))})) }, null, 2) + "\n");
function belongs(state: WorkspaceState, id: string, root: string): boolean {
  const seen = new Set<string>();
  let work = state.work.find(w => w.id === id && !w.tombstone);
  while (work && !seen.has(work.id)) {
    if (work.id === root) return true;
    seen.add(work.id);
    const parent = work.parentId;
    work = state.work.find(w => w.id === parent && !w.tombstone);
  }
  return false;
}
function decision(state: WorkspaceState, c: Pick<Campaign, "initiative"|"decidedIn">): void {
  if (!/#D[1-9][0-9]*$/u.test(c.decidedIn)) throw new Error("A numbered initiative decision is required");
  const item = minutesById(state, c.decidedIn);
  if (!item.linkedWorkIds.includes(c.initiative) || !item.decisions.length || item.decisions[0]?.status === "obsolete") throw new Error("Active decision must cover this initiative");
}
export async function armBatchRun(device: string, state: WorkspaceState, workspace: string, initiative: string, coordinator: string, decidedIn: string, existing: unknown[] = []): Promise<{ledger:string;initiative:string;coordinator:string;main:string;sampleLimit:number}> {
  if ((await resolveCodexPollingPolicy(device, coordinator)).scope !== "native-children") throw new Error("Codex batch coordination requires the enabled dual-conversation coordinator");
  const role = await readCodexPeerRole(device, coordinator);
  if (role.status !== "active" || role.role.libraryId !== state.metadata.workspaceId) throw new Error("Use an enrolled coordinator of this library");
  if (!state.work.some(w => w.id === initiative && !w.tombstone && w.kind === "Initiative" && w.status === "active")) throw new Error("Active initiative required");
  decision(state, { initiative, decidedIn });
  const dir = directory(device, coordinator);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const receipts = existing.map(value => normalizeCodexPeerBatch(value));
  for (const batch of receipts) {
    if (batch.schemaVersion === "tcrn.codex-peer-batch.v1" || batch.manifest.coordinator.conversationId !== coordinator || batch.manifest.main.conversationId !== role.role.mainId ||
      ![batch.manifest.workId,...batch.manifest.members.map(m => m.workId)].every(id => belongs(state,id,initiative))) throw new Error("Retained batch is outside the enrolled initiative or conversation pair");
  }
  const enrolled = await withFileLock(join(dir, "lock"), async () => {
    const ledger = await load(dir);
    const prior = ledger.campaigns.find(c => c.initiative === initiative && c.libraryId === state.metadata.workspaceId);
    if (prior && (prior.main !== role.role.mainId || prior.decidedIn !== decidedIn)) throw new Error("Existing batch timing enrollment differs");
    if (!prior) ledger.campaigns.push({ initiative, workspace, libraryId: state.metadata.workspaceId, decidedIn, main: role.role.mainId, coordinator, armedAt: new Date().toISOString(), entries: [] });
    await save(dir, ledger);
    return { ledger: join(dir,"ledger.json"), initiative, coordinator, main: role.role.mainId, sampleLimit: 3 };
  });
  for (const batch of [role.role.receipt, ...receipts]) {
    await registerBatchReceipt(device,coordinator,state,batch,undefined,undefined,false);
  }
  return enrolled;
}
function timingInput(v: unknown): Timing {
  if (!v || typeof v !== "object") throw new Error("Batch timing needs a native handoff and refill observations");
  const t = v as Timing;
  const now = parseStrictInstant(new Date().toISOString());
  const at = (s: string) => { const n = parseStrictInstant(s); if (n > now) throw new Error("Future timing observation"); };
  const ref = (s: unknown) => { if (typeof s !== "string" || !s.trim()) throw new Error("Timing observation requires its evidence reference"); };
  at(t.receivedAt); ref(t.evidence);
  if (t.fills === null) return t;
  if (!Array.isArray(t.fills)) throw new Error("Supply fills, or an empty array when no refill was needed");
  const seen = new Set<string>();
  for (const f of t.fills) {
    at(f.readyAt); at(f.slotAt); ref(f.workId); ref(f.evidence);
    if (seen.has(f.workId)) throw new Error("Duplicate refill observation");
    seen.add(f.workId);
  }
  return t;
}
export function turnaroundMetrics(e: Pick<Entry, "timing"|"times"|"work"|"delivered">): { firstDispatchMs: number | null; refills: { workId: string; milliseconds: number | null; evidence: string }[] | null; returnMs: number | null; receiptClock: string | null } {
  const members = Object.entries(e.work), times = Object.values(e.times);
  const complete = members.length > 0 && members.every(([id]) => e.times[id]?.endedAt);
  const first = members.length && members.every(([id]) => e.times[id]?.startedAt) ? Math.min(...times.map(t => Date.parse(t.startedAt))) : null;
  const tail = complete ? Math.max(...times.map(t => Date.parse(t.endedAt!))) : null;
  // Native worker times have second resolution. Bound an apparent sub-second inversion to zero.
  const elapsed = (start: number, end: number) => end + 999 < start ? null : Math.max(0, end-start);
  return { firstDispatchMs: e.timing && first !== null ? elapsed(Date.parse(e.timing.receivedAt), first) : null,
    refills: e.timing?.fills?.map(f => {
      const ids = members.filter(([,work]) => work === f.workId);
      const start = ids.length === 1 ? e.times[ids[0]![0]]?.startedAt : null;
      return { workId: f.workId, milliseconds: start ? elapsed(Math.max(Date.parse(f.readyAt),Date.parse(f.slotAt)),Date.parse(start)) : null, evidence: f.evidence };
    }) ?? null,
    returnMs: tail !== null && e.delivered ? elapsed(tail, Date.parse(e.delivered.receivedAt)) : null, receiptClock: e.delivered?.timeSource ?? null };
}
export async function batchRunStatus(device: string, coordinator: string): Promise<{ledger:string;campaigns:{initiative:string;armedAt:string;sampleLimit:number;batches:(ReturnType<typeof turnaroundMetrics> & {batch:string;attempt:string;sample:number|null;phase:string;error:string|null;receipt:RecipientReceipt|null})[]}[]}> {
  const dir = directory(device, coordinator);
  const ledger = await load(dir);
  return { ledger: join(dir, "ledger.json"), campaigns: ledger.campaigns.map(c => ({ initiative: c.initiative, armedAt: c.armedAt, sampleLimit: 3,
    batches: c.entries.map(e => ({ batch: e.batch, attempt: e.attempt, sample: e.sample, phase: e.phase, error: e.error, ...turnaroundMetrics(e), receipt: e.delivered })) })) };
}
export async function automaticReturnPendingOrReceived(device: string, actor: string, digest: string): Promise<boolean> {
  const ledger = await load(directory(device,actor));
  return ledger.campaigns.some(c => c.entries.some(e => e.manifest === digest && (e.intent !== null || e.phase === "prior-delivery")));
}
export async function recordedReservations(device: string, coordinator: string, agents: {agent_name:string;agent_status:unknown}[]): Promise<number> {
  const ledger = await load(directory(device,coordinator));
  let slots = 0;
  const owners = new Set<string>();
  for (const c of ledger.campaigns) for (const e of c.entries) {
    if (e.phase !== "waiting") continue;
    for (const [id, peak] of Object.entries(e.peaks ?? {})) {
      if (e.times[id]?.endedAt || owners.has(id)) continue;
      owners.add(id);
      const matching = agents.filter(a => a.agent_name === peak.path || a.agent_name.startsWith(peak.path + "/"));
      const active = (a: typeof agents[number]) => ["running","pending_init","pending","waiting"].includes(typeof a.agent_status === "string" ? a.agent_status : Object.keys(a.agent_status ?? {})[0] ?? "");
      if (matching.some(a => a.agent_name === peak.path && !active(a))) continue;
      slots += Math.max(0,peak.slots - matching.filter(active).length);
    }
  }
  return slots;
}
export async function registerBatchReceipt(device: string, actor: string | undefined, state: WorkspaceState, receipt: CodexPeerBatch, rawTiming?: unknown, preparedMembers?: unknown, observe = true): Promise<void> {
  if (actor !== receipt.manifest.coordinator.conversationId || !actor) return;
  const dir = directory(device, actor);
  if (!(await load(dir)).campaigns.length) return;
  const key = canonicalSha256(receipt.manifest);
  await withFileLock(join(dir,key + ".lock"), () => withFileLock(join(dir, "lock"), async () => {
    const ledger = await load(dir), m = receipt.manifest;
    const c = ledger.campaigns.find(c => c.main === m.main.conversationId && c.libraryId === state.metadata.workspaceId &&
      [m.workId,...m.members.map(w => w.workId)].every(w => belongs(state,w,c.initiative)));
    if (!c || receipt.records.some(r => r.preparation.decision.request.action !== "implementation")) return;
    decision(state, c);
    const prior = c.entries.find(e => e.batch === m.batchId && e.attempt === m.attemptId);
    if (prior && prior.manifest !== key) throw new Error("Immutable batch attempt changed; reconcile the registered manifest");
    const taken = c.entries.filter(e => e.sample !== null);
    const fresh = receipt.records.length > 0 && receipt.records.every(r => Date.parse(r.preparation.attempt!.requestedAt) >= Date.parse(c.armedAt));
    const sample = fresh && taken.length < 3 && !taken.some(e => e.batch === m.batchId) ? taken.length + 1 : null;
    const entry: Entry = prior ?? { batch: m.batchId, attempt: m.attemptId, manifest: key, receiptFile: join(dir, key + ".json"), sample, phase: "waiting", error: null,
      timing: null, delivered: null, intent: null, times: {}, work: Object.fromEntries(m.members.map(w => [w.attemptId,w.workId])) };
    if (rawTiming !== undefined) {
      const t = timingInput(rawTiming);
      if (t.fills?.some(f => !m.members.some(w => w.workId === f.workId))) throw new Error("Refill is outside this batch");
      if (entry.timing && (t.receivedAt !== entry.timing.receivedAt || t.evidence !== entry.timing.evidence || entry.timing.fills?.some(f => !t.fills?.some(v => canonicalSha256(f) === canonicalSha256(v))))) throw new Error("Timing evidence changed");
      entry.timing = t;
    }
    if (Array.isArray(preparedMembers)) for (const member of preparedMembers) {
      const record = receipt.records.find(r => r.preparation.attempt?.id === member?.attemptId);
      const args = record?.preparation.attempt?.argumentsValue as {task_name?:string} | undefined;
      if (!args?.task_name || !Number.isSafeInteger(member.peakSlots) || member.peakSlots < 1) throw new Error("Peak reservation differs from the prepared worker");
      const key = member.attemptId as string;
      entry.peaks ??= {};
      if (entry.peaks[key] && entry.peaks[key]!.slots !== member.peakSlots) throw new Error("Registered peak changed");
      entry.peaks[key] = {slots:member.peakSlots,path:"/root/" + args.task_name};
    }
    let current = receipt;
    if (prior) {
      const old = normalizeCodexPeerBatch(JSON.parse(await readFile(entry.receiptFile,"utf8")));
      current = recordCodexPeerBatch({ ...receipt, workRevisions: receipt.workRevisions ?? [], observationCutoff: new Date().toISOString(), prior: old });
    } else c.entries.push(entry);
    if (current.deliveryStatus !== "not-attempted" && !entry.delivered) entry.phase = "prior-delivery";
    await writeFileAtomic(entry.receiptFile, JSON.stringify(current) + "\n");
    await save(dir, ledger);
  }));
  if (observe && receipt.reportEligible) await advanceBatchRun(device, actor, receipt.manifest.attemptId);
}

/** Called by the coordinator's native completion/roster event or its explicit bounded observation. */
export async function advanceBatchRun(device: string, actor: string | undefined, attempt?: string, connect: typeof withLocalCodex = withLocalCodex): Promise<void> {
  if (!actor || (await resolveCodexPollingPolicy(device, actor)).scope !== "native-children") return;
  const dir = directory(device, actor), initial = await load(dir);
  if (!initial.campaigns.some(c => c.entries.some(e => ["waiting","unknown"].includes(e.phase) && (!attempt || e.attempt === attempt)))) return;
  const role = await readCodexPeerRole(device, actor);
  if (role.status !== "active") return;
  for (const c of initial.campaigns) {
    if (role.role.mainId !== c.main || role.role.libraryId !== c.libraryId) continue;
    for (const seen of c.entries) {
      if (!["waiting","unknown"].includes(seen.phase) || (attempt && seen.attempt !== attempt)) continue;
      await withFileLock(join(dir,seen.manifest + ".lock"),async () => {
        const find = (ledger: Ledger) => ledger.campaigns.find(row => row.initiative === c.initiative)?.entries.find(row => row.manifest === seen.manifest);
        const e = find(await load(dir));
        if (!e || !["waiting","unknown"].includes(e.phase)) return;
        const persist = () => withFileLock(join(dir,"lock"),async () => {
          const latest = await load(dir), stored = find(latest);
          if (!stored) throw new Error("Batch registration disappeared");
          Object.assign(stored,e);
          await save(dir,latest);
        });
        try {
          let batch = normalizeCodexPeerBatch(JSON.parse(await readFile(e.receiptFile,"utf8")));
          if (!batch.records.some(r => (r.providerId as {status?:string})?.status === "observed")) return;
          await connect(async call => {
            if (e.intent) {
              e.delivered = await deliverBatch(call,c.main,batch.reportPrefix,e.intent.prompt,e.intent.requestedAt,e.intent,async () => { throw new Error("Duplicate send"); });
              e.phase = "received"; e.error = null; return;
            }
            const observed = await nativeWorkerTurns(call, batch).catch(error => {
              if (!batch.reportEligible) throw error;
              return { records: [], times: {} };
            });
            Object.assign(e.times, observed.times);
            if (e.sample !== null && !e.timing) {
              const firstRequest = batch.records.map(r => r.preparation.attempt!.requestedAt).sort()[0]!;
              const handoff = await nativeBatchHandoff(call,c.coordinator,batch.manifest.batchId,batch.manifest.attemptId,c.armedAt,firstRequest).catch(() => null);
              if (handoff) e.timing = { ...handoff, fills: null };
            }
            if (!batch.allTerminal && !observed.records.length) return;
            const state = await materializeWorkspace(c.workspace);
            decision(state, c);
            const ids = new Set([batch.manifest.workId, batch.manifest.pack?.packId, ...batch.manifest.members.map(w => w.workId)]);
            const workRevisions = state.work.filter(w => ids.has(w.id) && !w.tombstone).map(w => ({ id: w.id, revision: w.revision }));
            const policy = await readEngineModelPolicyForReceipt("codex", batch.manifest.policyDigest, device);
            batch = recordCodexPeerBatch({ ...batch, workRevisions, records: observed.records, policy, observationCutoff: new Date().toISOString(), prior: batch });
            await writeFileAtomic(e.receiptFile, JSON.stringify(batch) + "\n");
            if (!batch.reportEligible) { e.error = batch.blockedReasons.join(", ") || null; return; }
            const since = batch.records.map(r => r.preparation.attempt!.requestedAt).sort()[0]!;
            const report = await batchReport(batch, e.times, e.receiptFile, { device, libraryId: c.libraryId });
            const prompt = report + "\n批次计时 " + join(dir, "ledger.json");
            e.delivered = await withFileLock(join(dir,"recipient.lock"),() => deliverBatch(call,c.main,batch.reportPrefix,prompt,since,e.intent,async intent => {
              e.intent = intent; e.phase = "unknown"; await persist();
            }));
            e.phase = "received"; e.error = null;
          });
        } catch (error) { e.error = String(error); }
        await persist();
      });
    }
  }
}
