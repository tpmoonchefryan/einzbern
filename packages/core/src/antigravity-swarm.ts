// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { parseStrictInstant } from "../../protocol/src/index.js";
import { createPrivateWindowsDirectory, hasPrivateWindowsPermissions, openPrivateWindowsFile } from "../../../scripts/lib/windows-system.mjs";
import {
  resolveNativePolicyIntentFromSnapshot,
  validateEngineModelPolicyFile,
} from "./engine-model-policy.js";
import type { EngineModelPolicyFile } from "./engine-model-policy.js";
import type { HostSelection, HostTuple } from "./host-capabilities.js";
import type { ModelsTierRecord } from "./models-tiers.js";
import { pathIsInside } from "./path-containment.js";
import { runtimeHome } from "./storage-location.js";

export const ANTIGRAVITY_SWARM_GUARD_VERSION = "einzbern.antigravity-swarm-guard.v1" as const;
export const ANTIGRAVITY_SWARM_GUARD_DIR = "antigravity-swarm-guards" as const;

export type AntigravitySwarmSupport = "supported" | "unsupported" | "unknown";
export type AntigravitySwarmMemberRole = "author" | "verifier" | "monitor" | "narrator";
export type AntigravitySwarmWorkspaceKind = "inherit" | "share" | "branch";

export class AntigravitySwarmError extends Error {
  readonly reasonCode: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(reasonCode: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "AntigravitySwarmError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface AntigravitySwarmSelectionObservation {
  readonly selection: HostSelection;
  readonly support: AntigravitySwarmSupport;
  readonly observedAt: string;
}

export interface AntigravitySwarmParsedModel {
  readonly id: string;
  readonly displayName: string | null;
  readonly tuple: HostTuple;
  readonly support: AntigravitySwarmSupport;
  readonly quotaRemaining: string | null;
  readonly quotaRemainingPercent: number | null;
  readonly quotaResets: string | null;
  readonly quotaNote: string | null;
  readonly aiCreditsFallback: boolean;
}

export interface AntigravitySwarmModelsParseResult {
  readonly combinations: readonly HostTuple[];
  readonly supportedCombinations: readonly HostTuple[];
  readonly selectionObservations: readonly AntigravitySwarmSelectionObservation[];
  readonly parsedModels: readonly AntigravitySwarmParsedModel[];
}

export interface AntigravitySwarmSwitchDecision {
  readonly reason: "quota-exhausted" | "capacity-exhausted" | "quality-rejected";
  readonly swarmAction: "model";
  readonly status: "selected" | "exhausted" | "unconfigured" | "entry-unconfigured";
  readonly currentRejections: number;
  readonly nextRejections: number;
  readonly selected: ModelsTierRecord | null;
  readonly steps: number;
  readonly atCeiling: boolean;
}

export interface AntigravitySwarmGuardMember {
  readonly name: string;
  readonly groupSize?: number;
  readonly role: AntigravitySwarmMemberRole;
  readonly workspace: AntigravitySwarmWorkspaceKind;
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

export interface AntigravitySwarmWorkspaceLandingResult {
  readonly landed: boolean;
  readonly coordinatorHead: string | null;
  readonly workerHead: string | null;
  readonly workerClean: boolean;
  readonly problems: readonly string[];
}

export interface AntigravitySwarmPreToolObservation {
  readonly status: "allowed" | "denied";
  readonly reasonCode:
    | "HOOK_ANTIGRAVITY_SWARM_OBSERVED"
    | "HOOK_ANTIGRAVITY_SWARM_UNBOUND_OBSERVED"
    | "HOOK_ANTIGRAVITY_SWARM_WORKER_MUTATION_DENIED"
    | "HOOK_ANTIGRAVITY_SWARM_UNLANDED_KILL_DENIED";
  readonly reason?: string;
}

const EFFORT_SUFFIXES = ["low", "medium", "high", "xhigh", "max"] as const;
const AI_CREDITS_PATTERN = /\b(?:ai\s+)?credits?\b|\boverage\b|\bpaid\s+coverage\b/iu;
const PERCENT_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/u;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameTuple(a: HostTuple, b: { readonly runner: string; readonly model: string; readonly effort: string }): boolean {
  return a.runner === b.runner && a.model === b.model && a.effort === b.effort;
}

function effortFromModelId(modelId: string): string {
  for (const suffix of EFFORT_SUFFIXES) {
    if (modelId.endsWith(`-${suffix}`)) return suffix;
  }
  return "default";
}

function parseQuotaPercent(raw: string | null): number | null {
  if (raw === null) return null;
  const match = PERCENT_PATTERN.exec(raw);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function hasAiCreditsCoverage(quotaNote: string | null): boolean {
  return quotaNote !== null && AI_CREDITS_PATTERN.test(quotaNote);
}

/**
 * Parse Antigravity `swarm{action:"models", all:true}` output into host combinations and
 * freshness-aware selection observations.
 *
 * Quota rule (D4): `0%` without an AI credits fallback note emits `unsupported`; `> 0%` or `0%`
 * with an AI credits note emits `supported`; missing or unparseable quota emits `unknown`.
 */
export function parseAntigravitySwarmModels(
  rawModelsOutput: unknown,
  options: { readonly observedAt: string; readonly runner?: string },
): AntigravitySwarmModelsParseResult {
  if (!isObject(rawModelsOutput) || !Array.isArray(rawModelsOutput.models)) {
    throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_MODELS_INVALID", "swarm models output must be an object with a models array");
  }
  parseStrictInstant(options.observedAt);
  const runner = options.runner === undefined ? "antigravity" : nonEmptyString(options.runner);
  if (runner === null) {
    throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_MODELS_INVALID", "runner must be a non-empty string");
  }

  const quotas = isObject(rawModelsOutput.quotas) ? rawModelsOutput.quotas : {};
  const displayNames = isObject(rawModelsOutput.display_names) ? rawModelsOutput.display_names : {};
  const combinations: HostTuple[] = [];
  const supportedCombinations: HostTuple[] = [];
  const selectionObservations: AntigravitySwarmSelectionObservation[] = [];
  const parsedModels: AntigravitySwarmParsedModel[] = [];
  const seen = new Set<string>();

  for (const rawModel of rawModelsOutput.models) {
    const id = nonEmptyString(rawModel);
    if (id === null || seen.has(id)) continue;
    seen.add(id);

    const tuple: HostTuple = { runner, model: id, effort: effortFromModelId(id) };
    const quotaEntry = isObject(quotas[id]) ? quotas[id] : null;
    const quotaRemaining = quotaEntry ? nonEmptyString(quotaEntry.quota_remaining) : null;
    const quotaResets = quotaEntry ? nonEmptyString(quotaEntry.quota_resets) : null;
    const quotaNote = quotaEntry ? nonEmptyString(quotaEntry.quota_note) : null;
    const quotaRemainingPercent = parseQuotaPercent(quotaRemaining);
    const aiCreditsFallback = hasAiCreditsCoverage(quotaNote);

    let support: AntigravitySwarmSupport = "unknown";
    if (quotaRemainingPercent !== null) {
      support = quotaRemainingPercent > 0 || aiCreditsFallback ? "supported" : "unsupported";
    }

    const displayName = nonEmptyString(displayNames[id]);
    combinations.push(tuple);
    if (support !== "unsupported") {
      supportedCombinations.push(tuple);
    }
    selectionObservations.push({
      selection: { kind: "explicit", tuple },
      support,
      observedAt: options.observedAt,
    });
    parsedModels.push({
      id,
      displayName,
      tuple,
      support,
      quotaRemaining,
      quotaRemainingPercent,
      quotaResets,
      quotaNote,
      aiCreditsFallback,
    });
  }

  return { combinations, supportedCombinations, selectionObservations, parsedModels };
}

/**
 * Resolve an in-place `swarm{action:"model"}` switch decision while keeping quota/capacity
 * exhaustion strictly orthogonal to quality rejection escalation (D4).
 */
export function resolveAntigravitySwarmSwitchDecision(input: {
  readonly reason: "quota-exhausted" | "capacity-exhausted" | "quality-rejected";
  readonly currentRejections: number;
  readonly category: string;
  readonly policy: EngineModelPolicyFile;
  readonly availableCombinations?: readonly HostTuple[];
  readonly currentModel?: string;
}): AntigravitySwarmSwitchDecision {
  if (!Number.isSafeInteger(input.currentRejections) || input.currentRejections < 0) {
    throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_SWITCH_INVALID", "currentRejections must be a non-negative integer");
  }
  const file = validateEngineModelPolicyFile(input.policy);
  const antigravityPolicy = Object.hasOwn(file.hosts, "antigravity") ? file.hosts.antigravity : undefined;

  if (input.reason === "quality-rejected") {
    const nextRejections = input.currentRejections + 1;
    const intent = resolveNativePolicyIntentFromSnapshot(file, {
      host: "antigravity",
      category: input.category,
      rejections: nextRejections,
      ...(input.availableCombinations === undefined ? {} : { availableCombinations: input.availableCombinations }),
    });
    if (intent.status === "unconfigured" || intent.status === "entry-unconfigured") {
      return {
        reason: input.reason,
        swarmAction: "model",
        status: intent.status,
        currentRejections: input.currentRejections,
        nextRejections,
        selected: null,
        steps: 0,
        atCeiling: false,
      };
    }
    if (intent.status === "unsupported") {
      const targetSelection = intent.selection;
      const fallbackTier =
        targetSelection !== null && input.availableCombinations !== undefined && antigravityPolicy !== undefined
          ? ([...antigravityPolicy.tiers]
              .filter(
                (tier) =>
                  tier.category === targetSelection.record.category &&
                  tier.order < targetSelection.record.order &&
                  tier.model.trim().length > 0 &&
                  tier.effort.trim().length > 0 &&
                  input.availableCombinations!.some((combo) => sameTuple(combo, tier)),
              )
              .sort((a, b) => b.order - a.order)[0] ?? null)
          : null;
      return {
        reason: input.reason,
        swarmAction: "model",
        status: fallbackTier === null ? "exhausted" : "selected",
        currentRejections: input.currentRejections,
        nextRejections,
        selected: fallbackTier,
        steps: targetSelection?.steps ?? 0,
        atCeiling: targetSelection?.atCeiling ?? false,
      };
    }
    return {
      reason: input.reason,
      swarmAction: "model",
      status: "selected",
      currentRejections: input.currentRejections,
      nextRejections,
      selected: intent.selection?.record ?? null,
      steps: intent.selection?.steps ?? 0,
      atCeiling: intent.selection?.atCeiling ?? false,
    };
  }

  if (antigravityPolicy === undefined) {
    return {
      reason: input.reason,
      swarmAction: "model",
      status: "unconfigured",
      currentRejections: input.currentRejections,
      nextRejections: input.currentRejections,
      selected: null,
      steps: 0,
      atCeiling: false,
    };
  }

  // Quota and capacity exhaustion never increment quality rejections.
  const currentIntent = resolveNativePolicyIntentFromSnapshot(file, {
    host: "antigravity",
    category: input.category,
    rejections: input.currentRejections,
  });
  const currentOrder = currentIntent.selection?.record.order;
  const currentModelId = nonEmptyString(input.currentModel);
  const modelOrder =
    currentModelId === null
      ? undefined
      : antigravityPolicy.tiers.find((tier) => tier.category === input.category && tier.model === currentModelId)?.order;
  const activeOrder =
    currentOrder !== undefined && modelOrder !== undefined
      ? Math.min(currentOrder, modelOrder)
      : (currentOrder ?? modelOrder);
  const categoryTiersDesc = [...antigravityPolicy.tiers]
    .filter((tier) => tier.category === input.category && tier.model.trim().length > 0 && tier.effort.trim().length > 0)
    .sort((a, b) => b.order - a.order);

  const candidate =
    categoryTiersDesc.find(
      (tier) =>
        (activeOrder === undefined || tier.order < activeOrder) &&
        (input.availableCombinations === undefined || input.availableCombinations.some((combo) => sameTuple(combo, tier))),
    ) ?? null;

  return {
    reason: input.reason,
    swarmAction: "model",
    status: candidate === null ? "exhausted" : "selected",
    currentRejections: input.currentRejections,
    nextRejections: input.currentRejections,
    selected: candidate,
    steps: currentIntent.selection?.steps ?? 0,
    atCeiling: currentIntent.selection?.atCeiling ?? false,
  };
}

export function antigravitySwarmGuardDirectory(deviceHome: string): string {
  const rtHome = resolve(runtimeHome(resolve(deviceHome)));
  return join(rtHome, "cache", ANTIGRAVITY_SWARM_GUARD_DIR);
}

export function antigravitySwarmGuardPath(deviceHome: string, coordinatorConversationId: string): string {
  const id = nonEmptyString(coordinatorConversationId);
  if (id === null) {
    throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_GUARD_INVALID", "coordinatorConversationId must be non-empty");
  }
  return join(antigravitySwarmGuardDirectory(deviceHome), `${sha256Hex(id)}.json`);
}

function validateGuardMember(raw: unknown): AntigravitySwarmGuardMember | null {
  if (!isObject(raw)) return null;
  const name = nonEmptyString(raw.name);
  if (name === null) return null;
  if (!["author", "verifier", "monitor", "narrator"].includes(String(raw.role))) return null;
  if (!["inherit", "share", "branch"].includes(String(raw.workspace))) return null;
  if (raw.groupSize !== undefined && (!Number.isSafeInteger(raw.groupSize) || Number(raw.groupSize) < 1)) return null;
  if (raw.conversationId !== null && typeof raw.conversationId !== "string") return null;
  if (raw.workspacePath !== null && typeof raw.workspacePath !== "string") return null;
  if (raw.abandonedByDecision !== null && typeof raw.abandonedByDecision !== "string") return null;
  if (typeof raw.landed !== "boolean" || typeof raw.killed !== "boolean") return null;
  return {
    name,
    ...(raw.groupSize === undefined ? {} : { groupSize: Number(raw.groupSize) }),
    role: raw.role as AntigravitySwarmMemberRole,
    workspace: raw.workspace as AntigravitySwarmWorkspaceKind,
    conversationId: raw.conversationId,
    workspacePath: raw.workspacePath,
    landed: raw.landed,
    abandonedByDecision: raw.abandonedByDecision,
    killed: raw.killed,
  };
}

function parseGuardState(raw: unknown): AntigravitySwarmGuardState | null {
  if (!isObject(raw) || raw.schemaVersion !== ANTIGRAVITY_SWARM_GUARD_VERSION) return null;
  if (
    nonEmptyString(raw.updatedAt) === null ||
    nonEmptyString(raw.libraryId) === null ||
    nonEmptyString(raw.workId) === null ||
    !Number.isSafeInteger(raw.workRevision) ||
    Number(raw.workRevision) < 0 ||
    nonEmptyString(raw.manifestDigest) === null
  ) {
    return null;
  }
  if (!isObject(raw.coordinator)) return null;
  const conversationId = nonEmptyString(raw.coordinator.conversationId);
  const workspaceRoot = nonEmptyString(raw.coordinator.workspaceRoot);
  if (conversationId === null || workspaceRoot === null) return null;
  if (!Array.isArray(raw.members)) return null;
  const members: AntigravitySwarmGuardMember[] = [];
  for (const entry of raw.members) {
    const parsed = validateGuardMember(entry);
    if (parsed === null) return null;
    members.push(parsed);
  }
  return {
    schemaVersion: ANTIGRAVITY_SWARM_GUARD_VERSION,
    updatedAt: String(raw.updatedAt),
    libraryId: String(raw.libraryId),
    workId: String(raw.workId),
    workRevision: Number(raw.workRevision),
    manifestDigest: String(raw.manifestDigest),
    coordinator: { conversationId, workspaceRoot },
    members,
  };
}

function assertNotSymlinkSync(targetPath: string): void {
  try {
    const stats = lstatSync(targetPath);
    if (stats.isSymbolicLink()) {
      throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_GUARD_SYMLINK", `refusing symlink at ${targetPath}`, { path: targetPath });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function assertNotSymlink(targetPath: string): Promise<void> {
  try {
    const stats = await lstat(targetPath);
    if (stats.isSymbolicLink()) {
      throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_GUARD_SYMLINK", `refusing symlink at ${targetPath}`, { path: targetPath });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/**
 * Atomically persist one Antigravity swarm guard state under `deviceHome` with `0700` directory
 * and `0600` file permissions, refusing symlinks.
 */
export async function stageAntigravitySwarmGuardState(
  deviceHome: string,
  state: AntigravitySwarmGuardState,
): Promise<string> {
  const validated = parseGuardState(state);
  if (validated === null) {
    throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_GUARD_INVALID", "invalid Antigravity swarm guard state");
  }
  const resolvedDeviceHome = resolve(deviceHome);
  await assertNotSymlink(resolvedDeviceHome);
  const rtHome = resolve(runtimeHome(resolvedDeviceHome));
  await assertNotSymlink(rtHome);
  const cacheDir = join(rtHome, "cache");
  const target = antigravitySwarmGuardPath(deviceHome, validated.coordinator.conversationId);
  const guardDir = dirname(target);
  await assertNotSymlink(cacheDir);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await assertNotSymlink(guardDir);
  if (process.platform === "win32") {
    if (!createPrivateWindowsDirectory(guardDir) && !hasPrivateWindowsPermissions(guardDir, true)) {
      throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_GUARD_PERMISSIONS", "swarm guard directory requires a private ACL", { path: guardDir });
    }
  } else {
    await mkdir(guardDir, { recursive: true, mode: 0o700 });
  }
  await assertNotSymlink(target);

  const temporary = join(guardDir, `.tmp-${randomUUID()}.json`);
  const payload = `${JSON.stringify(validated, null, 2)}\n`;
  const handle = process.platform === "win32" ? await openPrivateWindowsFile(temporary) : await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return target;
}

/**
 * Synchronous variant for `PreToolUse` hooks and tests: reads all valid guard states from
 * `cache/antigravity-swarm-guards`, refusing symlinks and ignoring `.tmp-*` siblings.
 */
export function readAntigravitySwarmGuardStatesSync(deviceHome: string): readonly AntigravitySwarmGuardState[] {
  const resolvedDeviceHome = resolve(deviceHome);
  const rtHome = resolve(runtimeHome(resolvedDeviceHome));
  const guardDir = join(rtHome, "cache", ANTIGRAVITY_SWARM_GUARD_DIR);
  try {
    assertNotSymlinkSync(resolvedDeviceHome);
    assertNotSymlinkSync(rtHome);
    assertNotSymlinkSync(join(rtHome, "cache"));
    assertNotSymlinkSync(guardDir);
  } catch (error) {
    if (error instanceof AntigravitySwarmError) throw error;
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(guardDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const states: AntigravitySwarmGuardState[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".json") || name.startsWith(".tmp-")) continue;
    const filePath = join(guardDir, name);
    try {
      const stats = lstatSync(filePath);
      if (stats.isSymbolicLink() || !stats.isFile()) continue;
      const parsed = parseGuardState(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
      if (parsed !== null) states.push(parsed);
    } catch {
      // Corrupt or unreadable state files are skipped rather than crashing unrelated tool hooks.
    }
  }
  return states;
}

function runGitSync(cwd: string, args: readonly string[]): { readonly ok: boolean; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

/**
 * Verify synchronously that an isolated worker workspace is clean and its `HEAD` is an ancestor of
 * the coordinator's `targetRef` (default `"HEAD"`).
 */
export function verifyAntigravitySwarmWorkspaceLanding(input: {
  readonly coordinatorWorkspaceRoot: string;
  readonly workerWorkspacePath: string;
  readonly targetRef?: string;
}): AntigravitySwarmWorkspaceLandingResult {
  const problems: string[] = [];
  const coordinatorRoot = runGitSync(input.coordinatorWorkspaceRoot, ["rev-parse", "--show-toplevel"]);
  if (!coordinatorRoot.ok) {
    problems.push(`coordinator workspace is not a git repository: ${input.coordinatorWorkspaceRoot}`);
  }
  const workerRoot = runGitSync(input.workerWorkspacePath, ["rev-parse", "--show-toplevel"]);
  if (!workerRoot.ok) {
    problems.push(`worker workspace is not a git repository: ${input.workerWorkspacePath}`);
  }

  const targetRef = input.targetRef ?? "HEAD";
  const coordinatorHeadRes = coordinatorRoot.ok ? runGitSync(input.coordinatorWorkspaceRoot, ["rev-parse", targetRef]) : { ok: false, stdout: "", stderr: "" };
  const workerHeadRes = workerRoot.ok ? runGitSync(input.workerWorkspacePath, ["rev-parse", "HEAD"]) : { ok: false, stdout: "", stderr: "" };
  const coordinatorHead = coordinatorHeadRes.ok && coordinatorHeadRes.stdout.length > 0 ? coordinatorHeadRes.stdout : null;
  const workerHead = workerHeadRes.ok && workerHeadRes.stdout.length > 0 ? workerHeadRes.stdout : null;

  if (coordinatorRoot.ok && coordinatorHead === null) {
    problems.push(`cannot resolve coordinator ref ${targetRef}`);
  }
  if (workerRoot.ok && workerHead === null) {
    problems.push("cannot resolve worker HEAD");
  }

  let workerClean = false;
  if (workerRoot.ok) {
    const statusRes = runGitSync(input.workerWorkspacePath, ["status", "--porcelain", "--untracked-files=normal"]);
    workerClean = statusRes.ok && statusRes.stdout.length === 0;
    if (!workerClean) {
      problems.push("worker workspace has uncommitted or untracked changes");
    }
  }

  let isAncestor = false;
  if (coordinatorRoot.ok && workerHead !== null && coordinatorHead !== null) {
    const mergeBaseRes = runGitSync(input.coordinatorWorkspaceRoot, ["merge-base", "--is-ancestor", workerHead, targetRef]);
    isAncestor = mergeBaseRes.ok;
    if (!isAncestor) {
      problems.push(`worker commit ${workerHead} is not an ancestor of coordinator ${targetRef}`);
    }
  }

  return {
    landed: problems.length === 0 && workerClean && isAncestor,
    coordinatorHead,
    workerHead,
    workerClean,
    problems,
  };
}

export function memberHasIsolatedWorkspace(
  member: Pick<AntigravitySwarmGuardMember, "workspace" | "workspacePath">,
  guard: Pick<AntigravitySwarmGuardState, "coordinator">,
): boolean {
  if (member.workspace === "share" || member.workspace === "branch") return true;
  return member.workspacePath !== null && resolve(member.workspacePath) !== resolve(guard.coordinator.workspaceRoot);
}

function memberMatchesKillTarget(member: AntigravitySwarmGuardMember, targetName: string): boolean {
  if (member.name === targetName) return true;
  if ((member.groupSize ?? 1) <= 1) return false;
  const prefix = `${member.name}-`;
  if (!targetName.startsWith(prefix)) return false;
  const suffix = targetName.slice(prefix.length);
  if (!/^[1-9][0-9]*$/u.test(suffix)) return false;
  const index = Number(suffix);
  return index >= 1 && index <= (member.groupSize ?? 1);
}

function isMemberLandedOrAbandoned(member: AntigravitySwarmGuardMember, guard: AntigravitySwarmGuardState): boolean {
  if (nonEmptyString(member.abandonedByDecision) !== null) return true;
  if (member.landed) return true;
  if (member.workspacePath === null || member.workspacePath.trim().length === 0) return false;
  return verifyAntigravitySwarmWorkspaceLanding({
    coordinatorWorkspaceRoot: guard.coordinator.workspaceRoot,
    workerWorkspacePath: member.workspacePath,
  }).landed;
}

function callerMatchesMember(
  member: AntigravitySwarmGuardMember,
  guard: AntigravitySwarmGuardState,
  conversationId: string | null,
  resolvedCwd: string,
): boolean {
  if (member.killed) return false;
  if (conversationId !== null && member.conversationId === conversationId) return true;
  return (
    memberHasIsolatedWorkspace(member, guard) &&
    member.workspacePath !== null &&
    pathIsInside(resolve(member.workspacePath), resolvedCwd)
  );
}

/**
 * Enforce Antigravity Swarm `PreToolUse` boundaries (D2, D5):
 * - Non-coordinator workers cannot call `swarm` with `add`, `model`, or `kill`.
 * - Coordinators cannot `kill` an isolated-workspace member until its work is landed or abandoned
 *   by an Owner decision.
 * - Unbound sessions are observed and allowed.
 */
export function antigravitySwarmPreToolObservation(
  payload: unknown,
  cwd: string,
  deviceHome: string,
): AntigravitySwarmPreToolObservation {
  const body = isObject(payload) ? payload : {};
  const call = isObject(body.toolCall) ? body.toolCall : null;
  if (call === null || call.name !== "swarm") {
    return { status: "allowed", reasonCode: "HOOK_ANTIGRAVITY_SWARM_UNBOUND_OBSERVED" };
  }

  const conversationId = nonEmptyString(body.conversationId);
  const args = isObject(call.args) ? call.args : {};
  const action = nonEmptyString(args.action);
  const resolvedCwd = resolve(cwd);

  let states: readonly AntigravitySwarmGuardState[];
  try {
    states = readAntigravitySwarmGuardStatesSync(deviceHome);
  } catch (error) {
    if (action === "kill") {
      return {
        status: "denied",
        reasonCode: "HOOK_ANTIGRAVITY_SWARM_UNLANDED_KILL_DENIED",
        reason: `Swarm guard directory is unreadable or symlinked (${String((error as Error).message ?? error)}); refusing swarm kill.`,
      };
    }
    if (action === "add" || action === "model") {
      return {
        status: "denied",
        reasonCode: "HOOK_ANTIGRAVITY_SWARM_WORKER_MUTATION_DENIED",
        reason: `Swarm guard directory is unreadable or symlinked (${String((error as Error).message ?? error)}); refusing swarm ${action}.`,
      };
    }
    return { status: "allowed", reasonCode: "HOOK_ANTIGRAVITY_SWARM_UNBOUND_OBSERVED" };
  }

  let matchedAnyGuard = false;

  for (const guard of states) {
    const matchedWorker = guard.members.find((member) => callerMatchesMember(member, guard, conversationId, resolvedCwd));
    if (matchedWorker !== undefined) {
      matchedAnyGuard = true;
      if (action === "add" || action === "model" || action === "kill") {
        return {
          status: "denied",
          reasonCode: "HOOK_ANTIGRAVITY_SWARM_WORKER_MUTATION_DENIED",
          reason: `Swarm worker "${matchedWorker.name}" cannot call swarm action "${action}" (only coordinator may mutate the swarm).`,
        };
      }
    }

    if (conversationId !== null && guard.coordinator.conversationId === conversationId) {
      matchedAnyGuard = true;
      if (action === "kill") {
        const targetName = nonEmptyString(args.name);
        const activeMembers = guard.members.filter((member) => !member.killed);
        const targets = targetName === null
          ? activeMembers.filter((member) => memberHasIsolatedWorkspace(member, guard))
          : activeMembers.filter((member) => memberMatchesKillTarget(member, targetName));

        for (const member of targets) {
          if (!memberHasIsolatedWorkspace(member, guard)) continue;
          if (!isMemberLandedOrAbandoned(member, guard)) {
            return {
              status: "denied",
              reasonCode: "HOOK_ANTIGRAVITY_SWARM_UNLANDED_KILL_DENIED",
              reason: `Cannot kill swarm member "${member.name}" before its isolated workspace is clean and merged into the coordinator HEAD (or explicitly abandoned by an Owner decision).`,
            };
          }
        }
      }
    }
  }

  return {
    status: "allowed",
    reasonCode: matchedAnyGuard ? "HOOK_ANTIGRAVITY_SWARM_OBSERVED" : "HOOK_ANTIGRAVITY_SWARM_UNBOUND_OBSERVED",
  };
}
