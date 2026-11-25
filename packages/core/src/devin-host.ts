// SPDX-License-Identifier: Apache-2.0

// Devin's CLI and Desktop share one user configuration directory. Its `hooks` key uses the grouped
// hook document Claude Code uses, so the hook plan is host-hooks.ts's; this module names where the
// directory is, whether the user selected Devin, and the subagent profiles rendered from the device
// model policy. A version probe proves neither that a hook ran nor which model a subagent used.

import * as fsModule from "node:fs";
import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { spawnCommandSync as spawnSync } from "../../../skill/mana-orchestrate/scripts/process-launch.mjs";
import { writeFileAtomic } from "./atomic-file.js";
import { backupsPath, ensureDeviceDirectory } from "./device-home.js";
import { HOST_HOOK_FILES, isEinzbernHookCommand, planHostHooks, readHostHooks } from "./host-hooks.js";
import type { HostHooksPlan } from "./host-hooks.js";
import type { AgentsNavigationChoice } from "./machine-settings.js";
import type { ModelsTierRecord } from "./models-tiers.js";
import { BRAND } from "./names.js";
import { NAVIGATION_LINES } from "./navigation-lines.js";

export const DEVIN_HOST = "devin" as const;
export const DEVIN_CONFIG_DIRECTORY = "devin" as const;
export const DEVIN_PROFILES_DIRECTORY = "agents" as const;
export const DEVIN_PROFILE_PREFIX = "einzbern-" as const;
export const DEVIN_PROFILES_SCHEMA_VERSION = "tcrn.devin-profiles-plan.v1" as const;
// Where Devin reads a user skill the engine already installs for every device (skill-copies.ts).
export const DEVIN_SKILL_ENTRY = `~/.agents/skills/${BRAND.helper.id}/SKILL.md` as const;
const PROFILE_MARKER = /^<!-- einzbern:managed-profile v1 sha256=([a-f0-9]{64}) -->$/u;

export type DevinSurfaceStatus = "available" | "not-detected" | "unavailable" | "unknown";
export interface DevinHostIdentity {
  readonly schemaVersion: "tcrn.devin-host-identity.v1";
  readonly observedAt: string;
  readonly cli: { readonly status: DevinSurfaceStatus; readonly executable: string | null; readonly version: string | null; readonly versionEvidence: string | null };
  readonly desktop: { readonly status: DevinSurfaceStatus; readonly bundlePath: string | null; readonly version: string | null };
  readonly selected: "unknown";
  readonly subagentFirstWork: { readonly status: "unknown"; readonly reason: string };
}

export class DevinHostError extends Error {
  readonly reasonCode: string;
  readonly details: Readonly<Record<string, string>>;
  constructor(reasonCode: string, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "DevinHostError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface DevinLocation {
  readonly home: string;
  // An explicit configuration directory; the platform's default below `home` when left out.
  readonly devinConfigHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

function insideHome(path: string | undefined, home: string): path is string {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  const tail = relative(home, resolve(path));
  return tail !== "" && !tail.startsWith("..") && !isAbsolute(tail);
}

/**
 * Devin's user configuration directory. It follows XDG_CONFIG_HOME (APPDATA on Windows) only when
 * that names a directory inside `home`: a caller working on another home, such as an installation
 * rehearsal, must never be redirected to the invoking user's real configuration.
 */
export function devinConfigRoot(input: DevinLocation): string {
  if (input.devinConfigHome !== undefined) return resolve(input.devinConfigHome);
  const home = resolve(input.home);
  const env = input.env ?? process.env;
  if ((input.platform ?? process.platform) === "win32") {
    return join(insideHome(env.APPDATA, home) ? resolve(env.APPDATA) : join(home, "AppData", "Roaming"), DEVIN_CONFIG_DIRECTORY);
  }
  return join(insideHome(env.XDG_CONFIG_HOME, home) ? resolve(env.XDG_CONFIG_HOME) : join(home, ".config"), DEVIN_CONFIG_DIRECTORY);
}

function entryKind(path: string): "directory" | "file" | "other" | null {
  try {
    const stats = fsModule.lstatSync(path);
    if (stats.isSymbolicLink()) return "other";
    return stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) return null;
    throw error;
  }
}

/** The configuration directory is evidence that the user selected Devin; an installed binary alone is not. */
export function devinSelectionStatus(input: DevinLocation): "selected" | "not-selected" | "unknown" {
  try {
    const kind = entryKind(devinConfigRoot(input));
    return kind === "directory" ? "selected" : kind === null ? "not-selected" : "unknown";
  } catch {
    return "unknown";
  }
}

function plistValue(text: string, key: string): string | null {
  const expression = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`, "u");
  return expression.exec(text)?.[1]?.trim() || null;
}

/** Read-only identity. `devin --version` starts no session; the Desktop bundle is read on macOS only. */
export function probeDevinHost(input: {
  readonly home?: string;
  readonly executable?: string;
  readonly desktopBundlePath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: string;
} = {}): DevinHostIdentity {
  const home = resolve(input.home ?? homedir());
  const env = input.env ?? process.env;
  const executable = input.executable ?? "devin";
  const observedAt = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  let cli: DevinHostIdentity["cli"] = { status: "not-detected", executable: null, version: null, versionEvidence: null };
  try {
    const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: process.platform === "win32" ? 15_000 : 5_000, maxBuffer: 16_384, env, shell: false, windowsHide: true });
    if ((result.error as NodeJS.ErrnoException | null)?.code === "ENOENT") cli = { status: "not-detected", executable: null, version: null, versionEvidence: null };
    else if (result.error || result.status !== 0) cli = { status: "unavailable", executable, version: null, versionEvidence: "devin --version did not return successfully" };
    else {
      const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      const version = /(?:^|\n)devin\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/iu.exec(text)?.[1] ?? null;
      cli = { status: version === null ? "unknown" : "available", executable, version, versionEvidence: version === null ? null : "devin --version" };
    }
  } catch {
    cli = { status: "unavailable", executable, version: null, versionEvidence: "devin --version could not be observed" };
  }

  const candidates = input.desktopBundlePath !== undefined
    ? [resolve(input.desktopBundlePath)]
    : process.platform === "darwin" ? ["/Applications/Devin.app", join(home, "Applications", "Devin.app")] : [];
  // No bundle layout is known for the other platforms; that is unknown, not absence.
  let desktop: DevinHostIdentity["desktop"] = { status: candidates.length === 0 ? "unknown" : "not-detected", bundlePath: null, version: null };
  for (const bundlePath of candidates) {
    try {
      if (entryKind(bundlePath) !== "directory") continue;
      const plist = fsModule.readFileSync(join(bundlePath, "Contents", "Info.plist"), "utf8");
      const named = plistValue(plist, "CFBundleName") === "Devin";
      desktop = { status: named ? "available" : "unknown", bundlePath, version: named ? plistValue(plist, "CFBundleShortVersionString") : null };
      if (named) break;
    } catch {
      desktop = { status: "unknown", bundlePath, version: null };
    }
  }
  return {
    schemaVersion: "tcrn.devin-host-identity.v1", observedAt, cli, desktop, selected: "unknown",
    subagentFirstWork: { status: "unknown", reason: "Devin has no subagent-start hook; a subagent starts with the always-on rules and its profile text" },
  };
}

// ---- Hooks: the `hooks` key of config.json, planned by host-hooks.ts ----

export interface DevinHooksRequest extends DevinLocation {
  readonly deviceHome: string;
  readonly install?: boolean;
  readonly navigation?: AgentsNavigationChoice | null;
}

/** The absolute path of the configuration file the hook plan reads and writes. */
export function devinHooksFile(input: DevinLocation): string {
  return join(devinConfigRoot(input), HOST_HOOK_FILES.devin);
}

/**
 * Devin's hook file as it is and as it would be rendered, or null when the configuration
 * directory does not exist: there is then nothing to install into and nothing of ours to remove.
 * A configuration file that is not strict JSON (comments are legal for Devin) is refused by the
 * shared reader and left as it is.
 */
export async function planDevinHooks(input: DevinHooksRequest): Promise<HostHooksPlan | null> {
  const root = devinConfigRoot(input);
  if (entryKind(root) !== "directory") return null;
  const expectation = planHostHooks({
    host: DEVIN_HOST, scope: "user", deviceHome: input.deviceHome, userHome: input.home,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    ...(input.install === undefined ? {} : { install: input.install }),
    navigation: input.navigation ?? null,
  });
  return readHostHooks(expectation, { root, home: input.home });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** How many Einzbern commands Devin's own configuration runs on UserPromptSubmit. */
export function devinHookCount(text: string | null): number {
  if (text === null || text.trim() === "") return 0;
  let document: unknown;
  try { document = JSON.parse(text); } catch { return 0; }
  const groups = isObject(document) && isObject(document.hooks) ? document.hooks.UserPromptSubmit : null;
  if (!Array.isArray(groups)) return 0;
  let count = 0;
  for (const group of groups as readonly unknown[]) {
    const hooks = isObject(group) && Array.isArray(group.hooks) ? group.hooks as readonly unknown[] : [];
    for (const hook of hooks) if (isObject(hook) && typeof hook.command === "string" && isEinzbernHookCommand(hook.command)) count += 1;
  }
  return count;
}

// ---- Subagent profiles: one per tier row of the device policy's devin host ----

export type DevinProfileTier = Pick<ModelsTierRecord, "order" | "category" | "model" | "effort">;

/** The profile a tier row is dispatched with. The order keeps two rows of one category apart. */
export function devinProfileName(tier: Pick<ModelsTierRecord, "order" | "category">): string {
  return `${DEVIN_PROFILE_PREFIX}${tier.category.replace(/[^a-z0-9-]/gu, "-")}-${tier.order}`;
}

function profileDigest(unmarked: string): string {
  return createHash("sha256").update(unmarked, "utf8").digest("hex");
}

/**
 * A profile's file. Devin's `run_subagent` takes a profile, not a model, so the file exists to pin
 * the tier's model; the role comes from the task prompt. Profiles carry no effort setting. The
 * marker line is the ownership evidence: its digest covers every other byte of the file.
 */
export function renderDevinProfile(tier: DevinProfileTier): string {
  const name = devinProfileName(tier);
  const effort = tier.effort === "default" ? "" : ` The policy requests effort ${tier.effort}; a Devin profile cannot set it.`;
  const frontmatter = [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(`${BRAND.engine.name} ${tier.category} tier, policy order ${tier.order}. Dispatch it when execution-policy-resolve names this profile.${effort}`)}`,
    `model: ${JSON.stringify(tier.model)}`,
    "---",
  ];
  const body = [
    `You are a worker dispatched by a main conversation that uses ${BRAND.engine.name}.`,
    "",
    `- ${NAVIGATION_LINES[1]} When no skill tool is available, read \`${DEVIN_SKILL_ENTRY}\`.`,
    "- Follow the task prompt: it names your scope, the paths you may write and the report to return. Read your own work context before acting.",
    "- Finish with one complete report. Write long results to the file the task names and return a short summary with its path. The host delivers your final message to the main conversation; do not send it again.",
    "- Do not start subagents or message other sessions.",
    "",
  ];
  const unmarked = [...frontmatter, ...body].join("\n");
  return [...frontmatter, `<!-- einzbern:managed-profile v1 sha256=${profileDigest(unmarked)} -->`, ...body].join("\n");
}

/** owned: the marker's digest matches the rest; modified: a marker that no longer matches; foreign: no marker. */
export function devinProfileOwnership(text: string): "owned" | "modified" | "foreign" {
  const lines = text.split("\n");
  const index = lines.findIndex(line => PROFILE_MARKER.test(line));
  if (index === -1) return "foreign";
  const digest = PROFILE_MARKER.exec(lines[index]!)![1];
  return profileDigest([...lines.slice(0, index), ...lines.slice(index + 1)].join("\n")) === digest ? "owned" : "modified";
}

export type DevinProfileAction = "create" | "update" | "remove" | "current" | "conflict";
export interface DevinProfileFile {
  readonly name: string;
  readonly path: string;
  readonly action: DevinProfileAction;
  readonly before: string | null;
  readonly after: string | null;
}
export interface DevinProfilesPlan {
  readonly schemaVersion: typeof DEVIN_PROFILES_SCHEMA_VERSION;
  readonly root: string;
  readonly directory: string;
  readonly files: readonly DevinProfileFile[];
  readonly changed: boolean;
  // Files that carry a wanted profile's name but are not an unmodified engine copy; kept as they are.
  readonly conflicts: readonly string[];
}

export interface DevinProfilesRequest extends DevinLocation {
  // The devin host's tier rows; null when the device policy has no devin host.
  readonly tiers: readonly DevinProfileTier[] | null;
  readonly install?: boolean;
}

async function regularFileText(path: string): Promise<string | null> {
  const kind = entryKind(path);
  if (kind === null) return null;
  if (kind !== "file") throw new DevinHostError("DEVIN_PROFILE_PATH_UNSUPPORTED", `${path} is not a regular file`, { path });
  return readFile(path, "utf8");
}

/**
 * The profile files as they are and as the policy wants them, or null when Devin's configuration
 * directory does not exist. A row without a model is not callable and gets no profile. An unmodified
 * engine copy the policy no longer names is removed; anything edited or foreign is never touched.
 */
export async function planDevinProfiles(input: DevinProfilesRequest): Promise<DevinProfilesPlan | null> {
  const root = devinConfigRoot(input);
  if (entryKind(root) !== "directory") return null;
  const directory = join(root, DEVIN_PROFILES_DIRECTORY);
  const wanted = new Map<string, string>();
  if (input.install !== false) for (const tier of input.tiers ?? []) {
    if (tier.model.trim() !== "") wanted.set(devinProfileName(tier), renderDevinProfile(tier));
  }
  const present: string[] = [];
  const directoryKind = entryKind(directory);
  if (directoryKind !== null && directoryKind !== "directory") throw new DevinHostError("DEVIN_PROFILE_PATH_UNSUPPORTED", `${directory} is not a directory`, { path: directory });
  if (directoryKind === "directory") {
    for (const entry of await readdir(directory)) if (entry.startsWith(DEVIN_PROFILE_PREFIX) && entry.endsWith(".md")) present.push(entry.slice(0, -3));
  }
  const files: DevinProfileFile[] = [];
  const conflicts: string[] = [];
  for (const name of [...new Set([...wanted.keys(), ...present])].sort()) {
    const path = join(directory, `${name}.md`);
    const before = await regularFileText(path);
    const after = wanted.get(name) ?? null;
    const ownership = before === null ? null : devinProfileOwnership(before);
    if (after === null) {
      // Not wanted: only an unmodified engine copy is stale; the rest is the user's.
      if (ownership === "owned") files.push({ name, path, action: "remove", before, after: null });
      continue;
    }
    if (before === null) files.push({ name, path, action: "create", before, after });
    else if (before === after) files.push({ name, path, action: "current", before, after });
    else if (ownership === "owned") files.push({ name, path, action: "update", before, after });
    else {
      files.push({ name, path, action: "conflict", before, after: before });
      conflicts.push(path);
    }
  }
  return { schemaVersion: DEVIN_PROFILES_SCHEMA_VERSION, root, directory, files, changed: files.some(file => ["create", "update", "remove"].includes(file.action)), conflicts };
}

/** Write a profile plan. Each replaced or removed file is copied to the device's backups first. */
export async function applyDevinProfiles(plan: DevinProfilesPlan, input: { readonly at: string; readonly deviceHome: string }): Promise<void> {
  if (plan.conflicts.length > 0) throw new DevinHostError("DEVIN_PROFILE_USER_EDITED", `${plan.conflicts[0]} is not an unmodified ${BRAND.engine.name} profile; preserve it for review`, { path: plan.conflicts[0]! });
  const changed = plan.files.filter(file => file.action === "create" || file.action === "update" || file.action === "remove");
  for (const file of changed) {
    if (await regularFileText(file.path) !== file.before) throw new DevinHostError("DEVIN_PROFILE_CONCURRENT_MODIFICATION", `${file.path} changed after planning`, { path: file.path });
  }
  const stamp = input.at.replace(/[-:]/gu, "");
  for (const file of changed) {
    if (file.before !== null) {
      const backup = join(backupsPath(input.deviceHome), stamp, "host-profiles", DEVIN_HOST, `${file.name}.md`);
      if (entryKind(backup) === null) {
        await ensureDeviceDirectory(dirname(backup));
        await writeFileAtomic(backup, file.before);
      }
    }
    if (file.after === null) await rm(file.path, { force: true });
    else {
      await ensureDeviceDirectory(dirname(file.path));
      await writeFileAtomic(file.path, file.after);
    }
  }
}

export type DevinProfileStatus = "current" | "missing" | "stale" | "modified" | "not-selected";

/** Whether the profile a resolved tier names is installed as the policy renders it. Reads one file. */
export async function inspectDevinProfile(input: DevinLocation & { readonly tier: DevinProfileTier }): Promise<{ readonly name: string; readonly status: DevinProfileStatus }> {
  const name = devinProfileName(input.tier);
  const root = devinConfigRoot(input);
  if (entryKind(root) !== "directory") return { name, status: "not-selected" };
  let text: string | null;
  try { text = await regularFileText(join(root, DEVIN_PROFILES_DIRECTORY, `${name}.md`)); }
  catch { return { name, status: "modified" }; }
  if (text === null) return { name, status: "missing" };
  if (text === renderDevinProfile(input.tier)) return { name, status: "current" };
  return { name, status: devinProfileOwnership(text) === "owned" ? "stale" : "modified" };
}
