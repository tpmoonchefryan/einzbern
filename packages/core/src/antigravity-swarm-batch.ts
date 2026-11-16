// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalSha256, parseStrictInstant } from "../../protocol/src/index.js";
import { dotInstant } from "./dot-execution.js";
import { validateEngineModelPolicyFile } from "./engine-model-policy.js";
import type { EngineModelPolicyFile } from "./engine-model-policy.js";
import { hostObject, hostText, HostExecutionError } from "./host-capabilities.js";
import { validateHostNativePreparation } from "./native-tool-evidence.js";
import type { HostNativePreparation } from "./native-tool-evidence.js";
import { runtimeHome } from "./storage-location.js";

export const ANTIGRAVITY_SWARM_MANIFEST_VERSION = "tcrn.antigravity-swarm-manifest.v1" as const;
export const ANTIGRAVITY_SWARM_BATCH_VERSION = "tcrn.antigravity-swarm-batch.v1" as const;
export const ANTIGRAVITY_SWARM_GUARD_VERSION = "einzbern.antigravity-swarm-guard.v1" as const;

export type AntigravitySwarmRole = "author" | "verifier" | "monitor" | "narrator";
export type AntigravitySwarmCategory = "main" | "economy" | "flagship";
export type AntigravitySwarmWorkspace = "inherit" | "share" | "branch";
export type AntigravitySwarmMemberState = "waiting" | "working" | "stopped" | "killed";
export type AntigravitySwarmSwitchReason = "quota-exhausted" | "capacity-exhausted" | "quality-rejected";

export interface AntigravitySwarmMember {
  readonly name: string;
  readonly groupSize?: number;
  readonly role: AntigravitySwarmRole;
  readonly category: AntigravitySwarmCategory;
  readonly workspace: AntigravitySwarmWorkspace;
  readonly preparationAttemptId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly conversationId: string | null;
  readonly workspacePath: string | null;
}

export interface AntigravitySwarmManifest {
  readonly schemaVersion: typeof ANTIGRAVITY_SWARM_MANIFEST_VERSION;
  readonly host: "antigravity";
  readonly batchId: string;
  readonly attemptId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly policyDigest: string;
  readonly coordinator: {
    readonly conversationId: string;
    readonly workspaceRoot: string;
  };
  readonly narratorAuthorizedBy?: string;
  readonly members: readonly AntigravitySwarmMember[];
}

export interface AntigravitySwarmStatusSnapshotMember {
  readonly name: string;
  readonly state: AntigravitySwarmMemberState;
  readonly observedRosterModel?: string | null;
  readonly workspacePath?: string | null;
}

export interface AntigravitySwarmStatusSnapshot {
  readonly observedAt: string;
  readonly members: readonly AntigravitySwarmStatusSnapshotMember[];
}

export interface AntigravitySwarmModelSwitch {
  readonly at: string;
  readonly name: string;
  readonly reason: AntigravitySwarmSwitchReason;
  readonly preparationAttemptId: string;
  readonly fromRequestedModel: string;
  readonly toRequestedModel: string;
}

export interface AntigravitySwarmBoardDeliverable {
  readonly seq: number;
  readonly author: string;
  readonly summary: string;
  readonly commitSha?: string | null;
}

export interface AntigravitySwarmLanding {
  readonly name: string;
  readonly disposition: "merged" | "abandoned";
  readonly coordinatorHead?: string | null;
  readonly workerHead?: string | null;
  readonly workerClean?: boolean;
  readonly decidedIn?: string | null;
  readonly verifiedAt: string;
}

export interface AntigravitySwarmObservations {
  readonly statusSnapshots?: readonly AntigravitySwarmStatusSnapshot[];
  readonly modelSwitches?: readonly AntigravitySwarmModelSwitch[];
  readonly switchPreparations?: readonly unknown[];
  readonly boardDeliverables?: readonly AntigravitySwarmBoardDeliverable[];
  readonly landings?: readonly AntigravitySwarmLanding[];
}

export interface AntigravitySwarmWorkRevision {
  readonly id: string;
  readonly revision: number;
}

export interface AntigravitySwarmBatchInput {
  readonly observationCutoff: string;
  readonly manifest: AntigravitySwarmManifest;
  readonly preparations: readonly HostNativePreparation[];
  readonly observations: AntigravitySwarmObservations;
  readonly policy: EngineModelPolicyFile;
  readonly workRevisions: readonly AntigravitySwarmWorkRevision[];
  readonly prior?: unknown;
}

export interface AntigravitySwarmActual {
  readonly model: { readonly status: "unknown"; readonly reason: "Antigravity swarm status reports roster configuration, not provider execution proof" };
  readonly effort: { readonly status: "unknown"; readonly reason: "Antigravity swarm status reports roster configuration, not provider execution proof" };
  readonly usage: { readonly status: "unknown"; readonly reason: "Antigravity swarm does not expose per-worker provider token usage" };
}

export interface AntigravitySwarmBatch {
  readonly schemaVersion: typeof ANTIGRAVITY_SWARM_BATCH_VERSION;
  readonly observationCutoff: string;
  readonly manifest: AntigravitySwarmManifest;
  readonly preparations: readonly HostNativePreparation[];
  readonly observations: AntigravitySwarmObservations;
  readonly policy: EngineModelPolicyFile;
  readonly workRevisions: readonly AntigravitySwarmWorkRevision[];
  readonly actual: AntigravitySwarmActual;
  readonly authority: "receipt-only-not-execution-authorization";
  readonly digest: string;
}

export interface AntigravitySwarmGuardMember {
  readonly name: string;
  readonly groupSize?: number;
  readonly role: AntigravitySwarmRole;
  readonly workspace: AntigravitySwarmWorkspace;
  readonly conversationId: string | null;
  readonly workspacePath: string | null;
  readonly landed: boolean;
  readonly abandonedByDecision: string | null;
  readonly killed: boolean;
}

export interface AntigravitySwarmGuardState {
  readonly schemaVersion: typeof ANTIGRAVITY_SWARM_GUARD_VERSION;
  readonly updatedAt: string;
  readonly libraryId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly manifestDigest: string;
  readonly coordinator: {
    readonly conversationId: string;
    readonly workspaceRoot: string;
  };
  readonly members: readonly AntigravitySwarmGuardMember[];
}

const ACTUAL_UNKNOWN: AntigravitySwarmActual = Object.freeze({
  model: Object.freeze({ status: "unknown", reason: "Antigravity swarm status reports roster configuration, not provider execution proof" }),
  effort: Object.freeze({ status: "unknown", reason: "Antigravity swarm status reports roster configuration, not provider execution proof" }),
  usage: Object.freeze({ status: "unknown", reason: "Antigravity swarm does not expose per-worker provider token usage" }),
});

const ROLES = new Set<AntigravitySwarmRole>(["author", "verifier", "monitor", "narrator"]);
const CATEGORIES = new Set<AntigravitySwarmCategory>(["main", "economy", "flagship"]);
const WORKSPACES = new Set<AntigravitySwarmWorkspace>(["inherit", "share", "branch"]);
const MEMBER_STATES = new Set<AntigravitySwarmMemberState>(["waiting", "working", "stopped", "killed"]);
const SWITCH_REASONS = new Set<AntigravitySwarmSwitchReason>(["quota-exhausted", "capacity-exhausted", "quality-rejected"]);
const MINUTES_DECISION_PATTERN = /^minutes:[A-Za-z0-9_-]+#D[1-9][0-9]*$/u;

function fail(message: string): never {
  throw new HostExecutionError(`Antigravity swarm receipt: ${message}`);
}

function positive(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(`${name} must be a positive safe integer`);
  return Number(value);
}

function optionalNullableText(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  hostText(value, name);
  return String(value);
}

function validateMemberName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.toLowerCase() || /\s/u.test(value)) {
    fail("member name must be lowercase nonempty without whitespace");
  }
  if (value === "all" || value === "coordinator") fail(`member name "${value}" is reserved`);
  return value;
}

function validateManifest(value: unknown): AntigravitySwarmManifest {
  const m = hostObject(value, "swarm manifest", [
    "schemaVersion", "host", "batchId", "attemptId", "workId", "workRevision",
    "policyDigest", "coordinator", "narratorAuthorizedBy", "members",
  ]);
  if (m.schemaVersion !== ANTIGRAVITY_SWARM_MANIFEST_VERSION || m.host !== "antigravity") {
    fail("explicit Antigravity swarm manifest v1 required");
  }
  for (const key of ["batchId", "attemptId", "workId"] as const) hostText(m[key], key);
  positive(m.workRevision, "work revision");
  if (typeof m.policyDigest !== "string" || !/^[a-f0-9]{64}$/u.test(m.policyDigest)) {
    fail("policy digest must bind the planned host policy");
  }
  const coordinator = hostObject(m.coordinator, "coordinator", ["conversationId", "workspaceRoot"]);
  hostText(coordinator.conversationId, "coordinator conversationId");
  hostText(coordinator.workspaceRoot, "coordinator workspaceRoot");

  if (m.narratorAuthorizedBy !== undefined) hostText(m.narratorAuthorizedBy, "narratorAuthorizedBy");
  const hasNarratorAuth = typeof m.narratorAuthorizedBy === "string" && m.narratorAuthorizedBy.trim().length > 0;

  if (!Array.isArray(m.members) || m.members.length === 0) fail("nonempty swarm membership required");
  const names = new Set<string>();
  const attempts = new Set<string>();
  const coordRoot = resolve(String(coordinator.workspaceRoot));

  for (const item of m.members) {
    const member = hostObject(item, "member", [
      "name", "groupSize", "role", "category", "workspace",
      "preparationAttemptId", "workId", "workRevision", "conversationId", "workspacePath",
    ]);
    const name = validateMemberName(member.name);
    if (names.has(name)) fail(`duplicate member name: ${name}`);
    names.add(name);

    if (member.groupSize !== undefined) positive(member.groupSize, "member groupSize");
    if (!ROLES.has(member.role as AntigravitySwarmRole)) fail(`unsupported member role: ${String(member.role)}`);
    if (!CATEGORIES.has(member.category as AntigravitySwarmCategory)) fail(`unsupported member category: ${String(member.category)}`);
    if (!WORKSPACES.has(member.workspace as AntigravitySwarmWorkspace)) fail(`unsupported member workspace: ${String(member.workspace)}`);

    hostText(member.preparationAttemptId, "member preparationAttemptId");
    if (attempts.has(String(member.preparationAttemptId))) fail("duplicate member preparationAttemptId");
    attempts.add(String(member.preparationAttemptId));

    hostText(member.workId, "member workId");
    positive(member.workRevision, "member workRevision");
    if (member.conversationId !== null) hostText(member.conversationId, "member conversationId");
    if (member.workspacePath !== null) hostText(member.workspacePath, "member workspacePath");

    if (member.role === "narrator" && !hasNarratorAuth) {
      fail("narrator role refused without narratorAuthorizedBy");
    }
    if (member.role === "monitor" && member.category !== "economy") {
      fail("monitor role must use economy category");
    }
    if (member.role === "verifier" || member.role === "monitor" || member.role === "narrator") {
      if (member.workspace !== "inherit") fail(`${String(member.role)} role must use workspace "inherit"`);
      if (member.workspacePath !== null && resolve(String(member.workspacePath)) !== coordRoot) {
        fail(`${String(member.role)} role must not use an isolated workspacePath`);
      }
    }
  }
  return structuredClone(m as unknown as AntigravitySwarmManifest);
}

function checkPreparationTimestamps(prep: HostNativePreparation, cutoff: bigint): void {
  if (parseStrictInstant(prep.decision.evaluatedAt) > cutoff) fail("preparation evaluatedAt is after observation cutoff");
  const capabilities = prep.decision.request.capabilities;
  const obs = [...(capabilities.selectionObservations ?? []), ...(capabilities.usage ? [capabilities.usage] : [])];
  for (const item of obs) {
    if (parseStrictInstant(item.observedAt) > cutoff) fail("preparation observation is after observation cutoff");
  }
  if (prep.attempt !== null && dotInstant(prep.attempt.requestedAt, "requestedAt") > cutoff) {
    fail("preparation requestedAt is after observation cutoff");
  }
}

function memberMatchesObservationName(member: AntigravitySwarmMember, target: string): boolean {
  if (member.name === target) return true;
  const groupSize = member.groupSize ?? 1;
  if (groupSize <= 1) return false;
  for (let i = 1; i <= groupSize; i += 1) {
    if (target === `${member.name}-${i}`) return true;
  }
  return false;
}

function resolveMemberForObservationName(
  members: readonly AntigravitySwarmMember[],
  target: string,
): AntigravitySwarmMember | null {
  return members.find(member => memberMatchesObservationName(member, target)) ?? null;
}

function validateExecutableSwarmPreparation(
  rawPrep: unknown,
  cutoff: bigint,
  prepByAttempt: Map<string, HostNativePreparation>,
): HostNativePreparation {
  const prep = validateHostNativePreparation(rawPrep);
  const req = prep.decision.request;
  if (req.capabilities.hostKind !== "antigravity" || req.capabilities.toolName !== "swarm" || prep.attempt === null) {
    fail("preparation must be an executable antigravity swarm host-native-preparation");
  }
  checkPreparationTimestamps(prep, cutoff);
  if (prepByAttempt.has(prep.attempt.id)) fail(`duplicate preparation attempt: ${prep.attempt.id}`);
  prepByAttempt.set(prep.attempt.id, prep);
  return prep;
}

function validateObservations(
  value: unknown,
  members: readonly AntigravitySwarmMember[],
  prepByAttempt: Map<string, HostNativePreparation>,
  workRevisions: readonly AntigravitySwarmWorkRevision[],
  cutoff: bigint,
): AntigravitySwarmObservations {
  const obs = hostObject(value, "observations", [
    "statusSnapshots", "modelSwitches", "switchPreparations", "boardDeliverables", "landings",
  ]);
  if (obs.statusSnapshots !== undefined) {
    if (!Array.isArray(obs.statusSnapshots)) fail("statusSnapshots must be an array");
    for (const snap of obs.statusSnapshots) {
      const s = hostObject(snap, "statusSnapshot", ["observedAt", "members"]);
      if (dotInstant(s.observedAt, "statusSnapshot observedAt") > cutoff) fail("statusSnapshot observedAt is after observation cutoff");
      if (!Array.isArray(s.members)) fail("statusSnapshot members must be an array");
      const seen = new Set<string>();
      for (const m of s.members) {
        const sm = hostObject(m, "statusSnapshot member", ["name", "state", "observedRosterModel", "workspacePath"]);
        hostText(sm.name, "statusSnapshot member name");
        if (!resolveMemberForObservationName(members, String(sm.name))) fail(`unknown member in statusSnapshot: ${String(sm.name)}`);
        if (seen.has(String(sm.name))) fail(`duplicate member in statusSnapshot: ${String(sm.name)}`);
        seen.add(String(sm.name));
        if (!MEMBER_STATES.has(sm.state as AntigravitySwarmMemberState)) fail(`invalid member state: ${String(sm.state)}`);
        optionalNullableText(sm.observedRosterModel, "observedRosterModel");
        optionalNullableText(sm.workspacePath, "workspacePath");
      }
    }
  }
  if (obs.switchPreparations !== undefined) {
    if (!Array.isArray(obs.switchPreparations)) fail("switchPreparations must be an array");
    for (const item of obs.switchPreparations) {
      const prep = validateExecutableSwarmPreparation(item, cutoff, prepByAttempt);
      const req = prep.decision.request;
      if (workRevisions.find(row => row.id === req.workId)?.revision !== req.workRevision) {
        fail(`switch preparation ${prep.attempt!.id} mismatches work revision for ${req.workId}`);
      }
    }
  }
  if (obs.modelSwitches !== undefined) {
    if (!Array.isArray(obs.modelSwitches)) fail("modelSwitches must be an array");
    for (const sw of obs.modelSwitches) {
      const s = hostObject(sw, "modelSwitch", ["at", "name", "reason", "preparationAttemptId", "fromRequestedModel", "toRequestedModel"]);
      if (dotInstant(s.at, "modelSwitch at") > cutoff) fail("modelSwitch at is after observation cutoff");
      hostText(s.name, "modelSwitch name");
      const member = resolveMemberForObservationName(members, String(s.name));
      if (!member) fail(`unknown member in modelSwitch: ${String(s.name)}`);
      if (!SWITCH_REASONS.has(s.reason as AntigravitySwarmSwitchReason)) fail(`invalid modelSwitch reason: ${String(s.reason)}`);
      hostText(s.preparationAttemptId, "modelSwitch preparationAttemptId");
      const switchPrep = prepByAttempt.get(String(s.preparationAttemptId));
      if (!switchPrep) fail(`unbound modelSwitch preparationAttemptId: ${String(s.preparationAttemptId)}`);
      const req = switchPrep.decision.request;
      if (req.workId !== member.workId || req.workRevision !== member.workRevision) {
        fail(`modelSwitch preparation ${String(s.preparationAttemptId)} mismatches member ${String(s.name)} workId/workRevision`);
      }
      hostText(s.fromRequestedModel, "fromRequestedModel");
      hostText(s.toRequestedModel, "toRequestedModel");
    }
  }
  if (obs.boardDeliverables !== undefined) {
    if (!Array.isArray(obs.boardDeliverables)) fail("boardDeliverables must be an array");
    for (const d of obs.boardDeliverables) {
      const item = hostObject(d, "boardDeliverable", ["seq", "author", "summary", "commitSha"]);
      positive(item.seq, "boardDeliverable seq");
      hostText(item.author, "boardDeliverable author");
      hostText(item.summary, "boardDeliverable summary");
      optionalNullableText(item.commitSha, "boardDeliverable commitSha");
    }
  }
  if (obs.landings !== undefined) {
    if (!Array.isArray(obs.landings)) fail("landings must be an array");
    for (const l of obs.landings) {
      const item = hostObject(l, "landing", ["name", "disposition", "coordinatorHead", "workerHead", "workerClean", "decidedIn", "verifiedAt"]);
      hostText(item.name, "landing name");
      if (!resolveMemberForObservationName(members, String(item.name))) fail(`unknown member in landing: ${String(item.name)}`);
      if (item.disposition !== "merged" && item.disposition !== "abandoned") fail(`invalid landing disposition: ${String(item.disposition)}`);
      optionalNullableText(item.coordinatorHead, "coordinatorHead");
      optionalNullableText(item.workerHead, "workerHead");
      if (item.workerClean !== undefined && typeof item.workerClean !== "boolean") fail("landing workerClean must be boolean");
      optionalNullableText(item.decidedIn, "decidedIn");
      if (dotInstant(item.verifiedAt, "landing verifiedAt") > cutoff) fail("landing verifiedAt is after observation cutoff");
    }
  }
  return structuredClone(obs as AntigravitySwarmObservations);
}

function memberHasIsolatedWorkspace(
  member: AntigravitySwarmMember,
  effectiveWorkspacePath: string | null,
  coordinatorWorkspaceRoot: string,
): boolean {
  if (member.workspace === "share" || member.workspace === "branch") return true;
  return effectiveWorkspacePath !== null && resolve(effectiveWorkspacePath) !== resolve(coordinatorWorkspaceRoot);
}

function latestSnapshot(snapshots: readonly AntigravitySwarmStatusSnapshot[] | undefined): AntigravitySwarmStatusSnapshot | null {
  if (!snapshots || snapshots.length === 0) return null;
  let best = snapshots[0]!;
  let bestAt = parseStrictInstant(best.observedAt);
  for (let i = 1; i < snapshots.length; i += 1) {
    const candidate = snapshots[i]!;
    const at = parseStrictInstant(candidate.observedAt);
    if (at >= bestAt) {
      best = candidate;
      bestAt = at;
    }
  }
  return best;
}

function isLandingValid(landing: AntigravitySwarmLanding): boolean {
  if (landing.disposition === "merged") {
    return landing.workerClean === true
      && typeof landing.coordinatorHead === "string" && landing.coordinatorHead.trim().length > 0
      && typeof landing.workerHead === "string" && landing.workerHead.trim().length > 0;
  }
  return typeof landing.decidedIn === "string" && MINUTES_DECISION_PATTERN.test(landing.decidedIn);
}

function derive(input: Omit<AntigravitySwarmBatchInput, "prior">): AntigravitySwarmBatch {
  const cutoff = dotInstant(input.observationCutoff, "observation cutoff");
  const manifest = validateManifest(input.manifest);
  const policy = validateEngineModelPolicyFile(input.policy);
  if (policy.hosts.antigravity?.digest !== manifest.policyDigest) {
    fail("policy digest differs from device hosts.antigravity policy");
  }

  if (!Array.isArray(input.workRevisions)) fail("workRevisions must be an array");
  const revIds = new Set<string>();
  const workRevisions: AntigravitySwarmWorkRevision[] = [];
  for (const row of input.workRevisions) {
    const item = hostObject(row, "work revision", ["id", "revision"]);
    hostText(item.id, "work id");
    const rev = positive(item.revision, "work revision");
    if (revIds.has(String(item.id))) fail(`duplicate work revision: ${String(item.id)}`);
    revIds.add(String(item.id));
    workRevisions.push({ id: String(item.id), revision: rev });
  }
  for (const target of [{ workId: manifest.workId, workRevision: manifest.workRevision }, ...manifest.members]) {
    if (workRevisions.find(row => row.id === target.workId)?.revision !== target.workRevision) {
      fail(`work revision drift for ${target.workId}`);
    }
  }

  if (!Array.isArray(input.preparations)) fail("preparations must be an array");
  const prepByAttempt = new Map<string, HostNativePreparation>();
  const preparations: HostNativePreparation[] = [];
  for (const rawPrep of input.preparations) {
    preparations.push(validateExecutableSwarmPreparation(rawPrep, cutoff, prepByAttempt));
  }

  for (const member of manifest.members) {
    const prep = prepByAttempt.get(member.preparationAttemptId);
    if (!prep) fail(`missing preparation for member ${member.name} (${member.preparationAttemptId})`);
    const req = prep.decision.request;
    if (req.workId !== member.workId || req.workRevision !== member.workRevision || req.category !== member.category) {
      fail(`preparation ${member.preparationAttemptId} mismatches member ${member.name} workId/workRevision/category`);
    }
  }

  const observations = validateObservations(input.observations, manifest.members, prepByAttempt, workRevisions, cutoff);

  const latest = latestSnapshot(observations.statusSnapshots);
  const landings = observations.landings ?? [];
  for (const member of manifest.members) {
    const snapMatches = latest?.members.filter(m => memberMatchesObservationName(member, m.name)) ?? [];
    for (const snapMember of snapMatches) {
      const effectivePath = snapMember.workspacePath !== undefined ? snapMember.workspacePath : member.workspacePath;
      if (memberHasIsolatedWorkspace(member, effectivePath, manifest.coordinator.workspaceRoot) && snapMember.state === "killed") {
        const matching = landings.filter(l => l.name === snapMember.name || l.name === member.name);
        if (!matching.some(isLandingValid)) {
          fail(`isolated-workspace member "${snapMember.name}" is killed without a verified merge landing or abandonment decision`);
        }
      }
    }
  }

  const payload = {
    schemaVersion: ANTIGRAVITY_SWARM_BATCH_VERSION,
    observationCutoff: input.observationCutoff,
    manifest,
    preparations,
    observations,
    policy,
    workRevisions,
    actual: ACTUAL_UNKNOWN,
    authority: "receipt-only-not-execution-authorization" as const,
  };
  return { ...payload, digest: canonicalSha256(payload) };
}

/** Recompute and validate a saved Antigravity swarm batch receipt read-only. */
export function normalizeAntigravitySwarmBatch(value: unknown): AntigravitySwarmBatch {
  const row = hostObject(value, "antigravity swarm receipt", [
    "schemaVersion", "observationCutoff", "manifest", "preparations",
    "observations", "policy", "workRevisions", "actual", "authority", "digest",
  ]);
  if (row.schemaVersion !== ANTIGRAVITY_SWARM_BATCH_VERSION) fail("unknown antigravity swarm receipt version");
  if (row.authority !== "receipt-only-not-execution-authorization") fail("invalid receipt authority marker");
  const calculated = derive({
    observationCutoff: row.observationCutoff as string,
    manifest: row.manifest as AntigravitySwarmManifest,
    preparations: row.preparations as readonly HostNativePreparation[],
    observations: row.observations as AntigravitySwarmObservations,
    policy: row.policy as EngineModelPolicyFile,
    workRevisions: row.workRevisions as readonly AntigravitySwarmWorkRevision[],
  });
  if (canonicalSha256(calculated) !== canonicalSha256(row)) fail("receipt differs from retained swarm evidence");
  return calculated;
}

/** Validate and record an Antigravity swarm batch receipt with optional monotonic prior check. */
export function recordAntigravitySwarmBatch(input: AntigravitySwarmBatchInput): AntigravitySwarmBatch {
  const prior = input.prior === undefined ? null : normalizeAntigravitySwarmBatch(input.prior);
  const cutoff = dotInstant(input.observationCutoff, "observation cutoff");
  if (prior) {
    if (cutoff < dotInstant(prior.observationCutoff, "prior observation cutoff")) {
      fail("observation cutoff moved backwards; reconcile the clock before resuming");
    }
    const manifest = validateManifest(input.manifest);
    if (canonicalSha256(prior.manifest) !== canonicalSha256(manifest)) {
      fail("immutable manifest changed; reconcile instead of redispatching");
    }
  }
  return derive({
    observationCutoff: input.observationCutoff,
    manifest: input.manifest,
    preparations: input.preparations,
    observations: input.observations,
    policy: input.policy,
    workRevisions: input.workRevisions,
  });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function assertNotSymlink(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) fail(`refusing symlink path: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Stage the local PreToolUse guard state derived from a validated swarm batch receipt. */
export async function stageAntigravitySwarmGuardFromBatch(
  receipt: AntigravitySwarmBatch,
  deviceHome: string,
  libraryId: string,
): Promise<string> {
  hostText(libraryId, "libraryId");
  const normalized = normalizeAntigravitySwarmBatch(receipt);
  const resolvedHome = resolve(deviceHome);
  await assertNotSymlink(resolvedHome);
  const rtHome = resolve(runtimeHome(resolvedHome));
  await assertNotSymlink(rtHome);
  const cacheDir = join(rtHome, "cache");
  await assertNotSymlink(cacheDir);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const guardDir = join(cacheDir, "antigravity-swarm-guards");
  await assertNotSymlink(guardDir);
  await mkdir(guardDir, { recursive: true, mode: 0o700 });

  const file = join(guardDir, `${sha256Hex(normalized.manifest.coordinator.conversationId)}.json`);
  await assertNotSymlink(file);

  const latest = latestSnapshot(normalized.observations.statusSnapshots);
  const landings = normalized.observations.landings ?? [];
  const members: AntigravitySwarmGuardMember[] = normalized.manifest.members.map(member => {
    const snapMatches = latest?.members.filter(m => memberMatchesObservationName(member, m.name)) ?? [];
    const effectivePath = snapMatches.find(m => m.workspacePath !== undefined)?.workspacePath ?? member.workspacePath;
    const groupSize = member.groupSize ?? 1;
    const instanceNames = groupSize > 1
      ? Array.from({ length: groupSize }, (_, i) => `${member.name}-${i + 1}`)
      : [];
    const baseMerged = landings.some(l => l.name === member.name && l.disposition === "merged" && isLandingValid(l));
    const baseAbandoned = landings.find(l => l.name === member.name && l.disposition === "abandoned" && isLandingValid(l));
    const baseKilled = latest?.members.some(m => m.name === member.name && m.state === "killed") ?? false;

    let landed: boolean;
    let abandonedByDecision: string | null;
    let killed: boolean;
    if (instanceNames.length > 0) {
      const instMerged = (inst: string) =>
        landings.some(l => l.name === inst && l.disposition === "merged" && isLandingValid(l));
      const instAbandoned = (inst: string) =>
        landings.find(l => l.name === inst && l.disposition === "abandoned" && isLandingValid(l));
      const allInstAccounted = instanceNames.every(inst => instMerged(inst) || instAbandoned(inst) !== undefined);
      const firstInstAbandoned = instanceNames.map(instAbandoned).find(l => l !== undefined);
      landed = baseMerged || instanceNames.every(instMerged);
      abandonedByDecision = baseAbandoned?.decidedIn
        ?? (allInstAccounted && firstInstAbandoned ? (firstInstAbandoned.decidedIn ?? null) : null);
      killed = baseKilled || instanceNames.every(
        inst => latest?.members.some(m => m.name === inst && m.state === "killed") ?? false,
      );
    } else {
      landed = baseMerged;
      abandonedByDecision = baseAbandoned?.decidedIn ?? null;
      killed = baseKilled;
    }

    return {
      name: member.name,
      ...(member.groupSize !== undefined ? { groupSize: member.groupSize } : {}),
      role: member.role,
      workspace: member.workspace,
      conversationId: member.conversationId,
      workspacePath: effectivePath,
      landed,
      abandonedByDecision,
      killed,
    };
  });

  const guardState: AntigravitySwarmGuardState = {
    schemaVersion: ANTIGRAVITY_SWARM_GUARD_VERSION,
    updatedAt: normalized.observationCutoff,
    libraryId,
    workId: normalized.manifest.workId,
    workRevision: normalized.manifest.workRevision,
    manifestDigest: canonicalSha256(normalized.manifest),
    coordinator: normalized.manifest.coordinator,
    members,
  };

  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(guardState, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, file);
  return file;
}
