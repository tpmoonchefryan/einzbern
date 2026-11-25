// SPDX-License-Identifier: Apache-2.0
import { hostObject, hostText, hostCount } from "./host-capabilities.js";
import { validateHostExecutionRequest } from "./execution-fallback.js";
import { codexWorkerArguments, observedCodexCapacity, observedCodexUsage, observedHooks } from "./codex-dispatch-input.js";
import { planImplementationBatch } from "./implementation-batch.js";
import { prepareHostNativeDispatch } from "./dispatch-workflow.js";
import { isCodexNativeSpawn, recordHostNativeEvents, type HostNativeRecord } from "./native-tool-evidence.js";
import { withLocalCodex } from "./codex-local-rpc.js";
import { recordedReservations } from "./codex-batch-run.js";
import { readEngineModelPolicyFile } from "./engine-model-policy.js";
import type { WorkspaceState } from "./workspace.js";

function fields(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(name + " must be an object");
  return value as Record<string, unknown>;
}

interface PreparedBatch {
  selected: string[]; waiting: Record<string,string>; records: HostNativeRecord[]; capacity: {limit:number;active:number|null}; manifest?: Record<string,unknown>; timing?: unknown;
  members: { id: string; peakSlots:number; workId: string; workRevision: number; attemptId: string; argumentsValue: unknown }[];
}
export async function prepareCodexBatch(state: WorkspaceState, value: unknown, roster: unknown, admission: unknown, quota: unknown, device: string, prepareWorker: typeof prepareHostNativeDispatch = prepareHostNativeDispatch): Promise<PreparedBatch> {
  const input = hostObject(value, "dispatch input", ["defaults","plan","members","batch","timing"]);
  const plan = { ...hostObject(input.plan, "batch plan", ["freeSlots","reservedSlots","runningPackages","availableCandidates","occupiedWrites","packages"]) };
  const defaults = fields(input.defaults,"common request");
  if (!Array.isArray(plan.packages) || !Array.isArray(input.members)) throw new Error("Expected queue packages and package inputs");
  const capabilities = fields(defaults.capabilities,"observed Codex capabilities");
  if (capabilities.hostKind !== "codex" || !isCodexNativeSpawn(capabilities.toolName)) throw new Error("Use the actual native Codex worker tool");
  const capacity = observedCodexCapacity(roster);
  hostCount(plan.freeSlots, "project and device free slots");
  const freeSlots = Math.min(plan.freeSlots, capacity.limit - (capacity.active ?? capacity.limit));
  const usageCapture = quota ?? await withLocalCodex(async call => {
    const result = fields(await call("account/rateLimits/read",{}),"native rate limits");
    if (result.ordinaryUsageAllowed !== true) throw new Error("Ordinary usage is unavailable or unobserved");
    const raw = fields(result.rateLimits,"native quota windows");
    return { ...raw, ordinaryUsageAllowed: result.ordinaryUsageAllowed, observedAt: new Date().toISOString() };
  });
  const hooks = observedHooks(admission);
  const actor = process.env["CODEX_THREAD_ID"] ?? process.env["CODEX_SESSION_ID"];
  const rawRoster = roster as {actualResult:{agents:{agent_name:string;agent_status:unknown}[]}};
  const autoReserve = actor ? await recordedReservations(device,actor,rawRoster.actualResult.agents) : 0;
  if (plan.reservedSlots === undefined && plan.runningPackages === undefined) plan.reservedSlots = autoReserve;
  else if (autoReserve && typeof plan.reservedSlots === "number") plan.reservedSlots = Math.max(autoReserve,plan.reservedSlots);
  const memberById = new Map<string, Record<string,unknown>>();
  for (const raw of input.members) {
    const member = hostObject(raw,"package input",["id","request","arguments"]);
    hostText(member.id,"package id");
    if (memberById.has(member.id)) throw new Error("Duplicate dispatch input");
    memberById.set(member.id,member);
  }
  const packages = plan.packages.map(p => fields(p,"queued package"));
  const ready: Record<string,HostNativeRecord> = Object.create(null);
  const failed: Record<string,string> = Object.create(null);
  // Prepare only the selected set. A single failing member releases its planned slots for a replacement.
  for (;;) {
    const candidates = packages.filter(p => !Object.hasOwn(failed,String(p.id)));
    const { selected, waiting } = planImplementationBatch({ freeSlots, availableCandidates: plan.availableCandidates, occupiedWrites: plan.occupiedWrites, packages: candidates });
    let retry = false;
    for (const id of selected) {
      if (ready[id]) continue;
      try {
        const member = memberById.get(id);
        if (!member) throw new Error("No dispatch input for " + id);
        const own = fields(member.request,"scoped work request");
        if (own.capabilities !== undefined) throw new Error("Use the observed batch capabilities");
        const request = validateHostExecutionRequest({ schemaVersion: "tcrn.host-execution-request.v1", action: "implementation", phase: "dispatch", category: "economy", rejections: 0, requestedAgents: 1,
          ...defaults, ...own, capabilities: { ...capabilities, platformCapacity: observedCodexCapacity(roster), usage: observedCodexUsage(usageCapture) } });
        if (request.action !== "implementation" || request.phase !== "dispatch" || request.requestedAgents !== 1) throw new Error("Expected one implementation worker per package");
        const args = hostObject(member.arguments,"native spawn input",["task_name","message","fork_turns","model","reasoning_effort"]);
        hostText(args.task_name, "native task name"); hostText(args.message, "native task message");
        const tool = codexWorkerArguments(request,{ argumentsValue: args });
        const prep = await prepareWorker(state,request,{...tool,peerWorker:true,...(hooks ? {codexObservation:hooks} : {})},device);
        if (!prep.attempt) throw new Error([...prep.decision.reasons].join(", ") || "Dispatch not admitted");
        ready[id] = recordHostNativeEvents(prep,[]);
      } catch (error) { failed[id] = String(error); retry = true; }
    }
    if (retry) continue;
    const members = selected.map(id => {
      const prep = ready[id]!.preparation;
      return { id, peakSlots:Number(packages.find(p => p.id === id)?.peakSlots ?? 1), workId: prep.decision.request.workId, workRevision: prep.decision.request.workRevision, attemptId: prep.attempt!.id, argumentsValue: prep.attempt!.argumentsValue };
    });
    const result: PreparedBatch = { selected, waiting: { ...waiting,...failed }, records: selected.map(id => ready[id]!), members,
      capacity: {limit:capacity.limit,active:capacity.active}, ...(input.timing !== undefined ? {timing:input.timing} : {}) };
    if (input.batch && members.length) {
      const batch = hostObject(input.batch,"batch identity",["batchId","attemptId","workId","workRevision","main","coordinator"]);
      result.manifest = { schemaVersion:"tcrn.codex-peer-manifest.v1",host:"codex",...batch,
        policyDigest:(await readEngineModelPolicyFile(device)).hosts.codex?.digest,
        members:members.map(({workId,workRevision,attemptId}) => ({workId,workRevision,attemptId,conversationId:null})) };
    }
    return result;
  }
}
