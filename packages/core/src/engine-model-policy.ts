// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-INIT-056 (MIN-289 D1/D2): engine-wide model policy. This is device state, not a
// library setting: one atomic file holds an independent category mother, tiers table and escalation
// tuple for each host. Project models.* records remain readable history/compatibility input, but do
// not become a second engine policy store.

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { assertStrictInstant, canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import { deviceHome, engineModelPolicyLockPath, engineModelPolicyPath } from "./device-home.js";
import { withFileLock } from "./file-lock.js";
import { assertActorId } from "./actor-attestation.js";
import { MODELS_ESCALATION_THRESHOLD_MAX, resolveModelsTier, validateModelsEscalationCeiling } from "./models-escalation.js";
import { defaultModelsCategory, validateModelsCategory } from "./models-category.js";
import { validateModelsTiers } from "./models-tiers.js";
import type { ModelsCategories } from "./models-category.js";
import type { ModelsTiers } from "./models-tiers.js";
import { DEFAULT_ENGINE_QUOTA_POLICY, resolveEngineQuotaPolicy, validateEngineQuotaOverrides, validateEngineQuotaPolicy } from "./execution-policy.js";
import type { EngineQuotaOverrides, EngineQuotaPolicy } from "./execution-policy.js";
import { MACHINE_SETTINGS_FILE_NAME, readMachineSettings } from "./machine-settings.js";
import type { ModelsTierResolution } from "./models-escalation.js";
import { writeFileAtomic } from "./atomic-file.js";
import type { AtomicWriteOptions } from "./atomic-file.js";
import type { VerifiedWriteAuthorization } from "./write-authorization.js";

export const ENGINE_MODEL_POLICY_SCHEMA_VERSION = "tcrn.engine-model-policy.v1" as const;
export const ENGINE_MODEL_POLICY_TRANSACTION_VERSION = "tcrn.engine-model-policy.v2" as const;
export const ENGINE_MODEL_POLICY_SHARED_VERSION = "tcrn.engine-model-policy.v3" as const;
export const ENGINE_MODEL_POLICY_CATALOG_VERSION = "tcrn.engine-model-policy-catalog.v1" as const;
export const ENGINE_MODEL_POLICY_WRITE_TARGET = "models.engine-policy" as const;

export const ENGINE_MODEL_POLICY_REASON_CODES = Object.freeze([
  "ENGINE_MODEL_POLICY_AUTHORIZATION_REQUIRED",
  "ENGINE_MODEL_POLICY_FILE_INVALID",
  "ENGINE_MODEL_POLICY_HOST_INVALID",
  "ENGINE_MODEL_POLICY_INVALID",
  "ENGINE_MODEL_POLICY_UNAVAILABLE",
  "ENGINE_MODEL_POLICY_CAS_CONFLICT",
  "ENGINE_MODEL_POLICY_OPERATION_CONFLICT",
  "ENGINE_MODEL_POLICY_SAVE_FAILED",
  "ENGINE_MODEL_POLICY_SAVE_RECONCILIATION_REQUIRED",
] as const);
export type EngineModelPolicyReasonCode = typeof ENGINE_MODEL_POLICY_REASON_CODES[number];

export class EngineModelPolicyError extends Error {
  readonly reasonCode: EngineModelPolicyReasonCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(reasonCode: EngineModelPolicyReasonCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "EngineModelPolicyError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface EngineModelPolicyConfig {
  /** Optional host-local thresholds; omitted fields inherit the device's generic value. */
  readonly quota?: EngineQuotaOverrides | null;
  /** Host-local concurrency cap; null inherits the device's generic value. */
  readonly maxConcurrentSubagents?: number | null;
  readonly categories: ModelsCategories;
  readonly tiers: ModelsTiers;
  readonly escalation: {
    readonly enabled: boolean;
    readonly threshold: number;
    readonly ceiling: string;
  };
}

export interface EngineModelPolicyEntry extends EngineModelPolicyConfig {
  readonly revision: number;
  /** SHA-256 over host plus categories, tiers and escalation. */
  readonly digest: string;
  readonly updatedAt: string;
  readonly actor: string;
  readonly decidedIn: string;
  readonly decidedInLibraryId: string;
}

export interface EngineModelPolicyFile {
  readonly schemaVersion: typeof ENGINE_MODEL_POLICY_SCHEMA_VERSION | typeof ENGINE_MODEL_POLICY_TRANSACTION_VERSION | typeof ENGINE_MODEL_POLICY_SHARED_VERSION;
  /** Increments once per host write, giving the whole file a monotonic revision. */
  readonly revision: number;
  readonly hosts: Readonly<Record<string, EngineModelPolicyEntry>>;
  /** One category table shared by all host tiers on this device. */
  readonly categoryCatalog?: ModelsCategories;
  readonly operations?: Readonly<Record<string, EngineModelPolicyOperation>>;
}

export interface EngineModelPolicyCatalog {
  readonly schemaVersion: typeof ENGINE_MODEL_POLICY_CATALOG_VERSION;
  readonly source: { readonly kind: "device-engine"; readonly path: string };
  readonly storeRevision: number;
  readonly hosts: Readonly<Record<string, EngineModelPolicyEntry>>;
  readonly compatibility: {
    readonly projectModelSettings: "read-only-compatibility-input";
    readonly precedence: "configured-device-host-policy-if-present";
    readonly projectOverrideAllowed: false;
  };
  readonly selectedHost?: string;
  readonly selectedPolicy?: EngineModelPolicyEntry | null;
  readonly selectedStatus?: "configured" | "unconfigured";
  /** Proposed host-local defaults, never a saved policy or authorization. */
  readonly onboarding?: EngineModelPolicyConfig;
  readonly peerReadiness?: CodexPeerReadiness;
}

const HOST_ID = /^[a-z][a-z0-9._-]*$/u;
const LIBRARY_ID = /^(?:library|workspace):[a-f0-9]{24}$/u;
const DECISION_ID = /^minutes:[a-f0-9]{24}#D[1-9][0-9]*$/u;
const STORE_FIELDS = "hosts,revision,schemaVersion";
const ENTRY_FIELDS = "actor,categories,decidedIn,decidedInLibraryId,digest,escalation,revision,tiers,updatedAt";
const CONFIG_FIELDS = "categories,escalation,tiers";
const ESCALATION_FIELDS = "ceiling,enabled,threshold";

function fail(reasonCode: EngineModelPolicyReasonCode, message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new EngineModelPolicyError(reasonCode, message, details);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("ENGINE_MODEL_POLICY_INVALID", `${path} must be an object`, { path });
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Readonly<Record<string, unknown>>, fields: string, path: string): void {
  if (Object.keys(value).sort().join(",") !== fields) {
    fail("ENGINE_MODEL_POLICY_INVALID", `${path} requires exactly ${fields.split(",").join(", ")}`, { path });
  }
}

function hostId(value: unknown): string {
  if (typeof value !== "string" || !HOST_ID.test(value)) {
    fail("ENGINE_MODEL_POLICY_HOST_INVALID", "host must be a lowercase id", { host: String(value) });
  }
  return value;
}

function safeRevision(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail("ENGINE_MODEL_POLICY_FILE_INVALID", `${path} must be an integer of at least ${minimum}`, { path });
  }
  return value;
}

function policyDigest(host: string, config: EngineModelPolicyConfig): string {
  return canonicalSha256({ host, categories: config.categories, tiers: config.tiers, escalation: config.escalation,
    ...(config.quota === undefined ? {} : { quota: config.quota }),
    ...(config.maxConcurrentSubagents === undefined ? {} : { maxConcurrentSubagents: config.maxConcurrentSubagents }) });
}

/** Validate one closed host policy, including all category references and runner isolation. */
export function validateEngineModelPolicy(hostValue: unknown, value: unknown): EngineModelPolicyConfig {
  const host = hostId(hostValue);
  const input = object(value, "policy");
  exactFields(input, ["categories,escalation,tiers", "categories,escalation,maxConcurrentSubagents,quota,tiers", "categories,escalation,quota,tiers", "categories,escalation,maxConcurrentSubagents,tiers"].includes(Object.keys(input).sort().join(","))
    ? Object.keys(input).sort().join(",") : CONFIG_FIELDS, "policy");
  const quota = Object.hasOwn(input, "quota") ? input.quota === null ? null : validateEngineQuotaOverrides(input.quota) : undefined;
  const maxConcurrentSubagents = Object.hasOwn(input, "maxConcurrentSubagents") ? input.maxConcurrentSubagents : undefined;
  if (maxConcurrentSubagents !== undefined && maxConcurrentSubagents !== null && (typeof maxConcurrentSubagents !== "number" || !Number.isSafeInteger(maxConcurrentSubagents) || maxConcurrentSubagents < 1)) {
    fail("ENGINE_MODEL_POLICY_INVALID", "policy.maxConcurrentSubagents must be a positive safe integer or null", { path: "policy.maxConcurrentSubagents" });
  }
  const categories = validateModelsCategory(input.categories);
  const tiers = validateModelsTiers(input.tiers);
  const escalation = object(input.escalation, "policy.escalation");
  exactFields(escalation, ESCALATION_FIELDS, "policy.escalation");
  if (typeof escalation.enabled !== "boolean") {
    fail("ENGINE_MODEL_POLICY_INVALID", "policy.escalation.enabled must be boolean", { path: "policy.escalation.enabled" });
  }
  if (typeof escalation.threshold !== "number" || !Number.isSafeInteger(escalation.threshold) || escalation.threshold < 1 || escalation.threshold > MODELS_ESCALATION_THRESHOLD_MAX) {
    fail("ENGINE_MODEL_POLICY_INVALID", `policy.escalation.threshold must be an integer from 1 to ${MODELS_ESCALATION_THRESHOLD_MAX}`, { path: "policy.escalation.threshold" });
  }
  if (typeof escalation.ceiling !== "string") fail("ENGINE_MODEL_POLICY_INVALID", "policy.escalation.ceiling must be a category id string", { path: "policy.escalation.ceiling" });
  const ceiling = validateModelsEscalationCeiling(escalation.ceiling);
  const categoriesById = new Set(categories.map((category) => category.id));
  if (!categoriesById.has(ceiling)) {
    fail("ENGINE_MODEL_POLICY_INVALID", `policy.escalation.ceiling ${ceiling} is not in this host's category table`, { path: "policy.escalation.ceiling", host, category: ceiling });
  }
  for (const [index, tier] of tiers.entries()) {
    if (tier.runner !== host) {
      fail("ENGINE_MODEL_POLICY_INVALID", `policy.tiers[${index}].runner must equal host ${host}`, { path: `policy.tiers[${index}].runner`, host, runner: tier.runner });
    }
    if (!categoriesById.has(tier.category)) {
      fail("ENGINE_MODEL_POLICY_INVALID", `policy.tiers[${index}].category is not in this host's category table`, { path: `policy.tiers[${index}].category`, host, category: tier.category });
    }
  }
  return Object.freeze({
    categories,
    tiers,
    ...(quota === undefined ? {} : { quota }),
    ...(maxConcurrentSubagents === undefined ? {} : { maxConcurrentSubagents: maxConcurrentSubagents as number | null }),
    escalation: Object.freeze({ enabled: escalation.enabled, threshold: escalation.threshold, ceiling }),
  });
}

function nextModelRowOrder(rows: readonly { readonly order: number }[]): number {
  const maximum = rows.reduce((max, row) => Math.max(max, row.order), 0);
  if (maximum <= Number.MAX_SAFE_INTEGER - 10) return maximum + 10;
  const used = new Set(rows.map(row => row.order));
  let next = 1;
  while (used.has(next)) next += 1;
  return next;
}

/** INIT-076: additive onboarding draft, offered on fresh installs and subsequent repairs.
 * Existing groups, custom categories, quota and escalation remain untouched. Saving the draft
 * still goes through the normal actor/Owner-decision/CAS write path; reading never writes it.
 */
export function engineModelPolicyOnboarding(hostValue: string, policy?: EngineModelPolicyConfig | null, sharedCategories?: ModelsCategories): EngineModelPolicyConfig {
  const host = hostId(hostValue);
  const current = policy == null ? null : validateEngineModelPolicy(host, { categories: policy.categories, tiers: policy.tiers, escalation: policy.escalation, ...(policy.quota === undefined ? {} : { quota: policy.quota }), ...(policy.maxConcurrentSubagents === undefined ? {} : { maxConcurrentSubagents: policy.maxConcurrentSubagents }) });
  if (current === null && sharedCategories && sharedCategories.length > 0) {
    const ceiling = sharedCategories.find(category => category.id === "main")?.id ?? sharedCategories[0]!.id;
    return validateEngineModelPolicy(host, {
      categories: sharedCategories,
      tiers: sharedCategories.map(category => ({ order: category.order, category: category.id, runner: host, model: "", effort: "", note: "" })),
      escalation: { enabled: false, threshold: 2, ceiling },
    });
  }
  const categories = [...(current?.categories ?? [])];
  const tiers = [...(current?.tiers ?? [])];
  for (const category of defaultModelsCategory()) {
    if (!categories.some(row => row.id === category.id)) categories.push({ ...category, order: nextModelRowOrder(categories) });
    if (!tiers.some(row => row.category === category.id)) tiers.push({ order: nextModelRowOrder(tiers), category: category.id, runner: host, model: "", effort: "", note: "" });
  }
  return validateEngineModelPolicy(host, {
    categories, tiers,
    escalation: current?.escalation ?? { enabled: false, threshold: 2, ceiling: "main" },
    ...(current?.quota === undefined ? {} : { quota: current.quota }),
    ...(current?.maxConcurrentSubagents === undefined ? {} : { maxConcurrentSubagents: current.maxConcurrentSubagents }),
  });
}

export interface CodexPeerReadiness {
  readonly applicable: boolean;
  readonly ready: boolean;
  readonly missingCategories: readonly string[];
  readonly invalidCeiling: string | null;
}

/** Configuration readiness only, not host availability, execution permission or a live test.
 * Unknown/non-Codex hosts never acquire Codex behavior. Ordinary host use is not gated here.
 */
export function codexPeerReadiness(hostValue: string, policy?: EngineModelPolicyConfig | null): CodexPeerReadiness {
  const host = hostId(hostValue);
  if (host !== "codex") return Object.freeze({ applicable: false, ready: false, missingCategories: Object.freeze([]), invalidCeiling: null });
  const current = policy == null ? null : validateEngineModelPolicy(host, { categories: policy.categories, tiers: policy.tiers, escalation: policy.escalation, ...(policy.quota === undefined ? {} : { quota: policy.quota }), ...(policy.maxConcurrentSubagents === undefined ? {} : { maxConcurrentSubagents: policy.maxConcurrentSubagents }) });
  const usable = (category: string, ceiling = false): boolean => {
    const rows = (current?.tiers ?? []).filter(row => row.category === category).sort((a, b) => a.order - b.order);
    const row = ceiling ? rows[0] : rows.at(-1);
    return row !== undefined && row.runner === host && row.model.trim() !== "" && row.effort.trim() !== "";
  };
  const missingCategories = ["main", "economy"].filter(category => !usable(category));
  const invalidCeiling = current?.escalation.enabled && !usable(current.escalation.ceiling, true) ? current.escalation.ceiling : null;
  return Object.freeze({ applicable: true, ready: missingCategories.length === 0 && invalidCeiling === null, missingCategories: Object.freeze(missingCategories), invalidCeiling });
}

function emptyFile(): EngineModelPolicyFile {
  return Object.freeze({ schemaVersion: ENGINE_MODEL_POLICY_SHARED_VERSION, revision: 0, categoryCatalog: defaultModelsCategory(), hosts: Object.freeze({}), operations: Object.freeze({}) });
}

function sharedLegacyCategories(tables: readonly ModelsCategories[]): ModelsCategories {
  const defaults = defaultModelsCategory();
  const builtInIds = new Set(defaults.map(row => row.id));
  const custom = new Map<string, { id: string; name: string; description: string; order: number }>();
  for (const table of tables) for (const row of table) {
    if (builtInIds.has(row.id)) continue;
    const prior = custom.get(row.id);
    if (prior && (prior.name !== row.name || prior.description !== row.description)) {
      fail("ENGINE_MODEL_POLICY_INVALID", `legacy hosts disagree about custom category ${row.id}; preserve both source records for Owner reconciliation`, { category: row.id });
    }
    if (!prior || row.order < prior.order) custom.set(row.id, { ...row });
  }
  let order = defaults.reduce((maximum, row) => Math.max(maximum, row.order), 0);
  const categories = [...defaults, ...[...custom.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)).map(row => ({ ...row, order: (order += 10) }))];
  return validateModelsCategory(categories);
}

function validateEntryMetadata(host: string, entry: Record<string, unknown>, revision: number): { revision: number; updatedAt: string; actor: string; decidedIn: string; decidedInLibraryId: string } {
  const entryRevision = safeRevision(entry.revision, `hosts.${host}.revision`, 1);
  if (entryRevision > revision) fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.revision exceeds file revision`, { host });
  if (typeof entry.updatedAt !== "string") fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.updatedAt must be an instant`, { host });
  try { assertStrictInstant(entry.updatedAt); } catch { fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.updatedAt must be a strict UTC instant`, { host }); }
  try { assertActorId(entry.actor); } catch { fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.actor is not an actor id`, { host }); }
  if (typeof entry.decidedIn !== "string" || !DECISION_ID.test(entry.decidedIn)) fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.decidedIn must be a minutes decision address`, { host });
  if (typeof entry.decidedInLibraryId !== "string" || !LIBRARY_ID.test(entry.decidedInLibraryId)) fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.decidedInLibraryId must be a library id`, { host });
  return { revision: entryRevision, updatedAt: entry.updatedAt, actor: entry.actor, decidedIn: entry.decidedIn, decidedInLibraryId: entry.decidedInLibraryId };
}

function entryConfig(host: string, entry: Record<string, unknown>, categories: unknown): EngineModelPolicyConfig {
  return validateEngineModelPolicy(host, {
    categories,
    tiers: entry.tiers,
    escalation: entry.escalation,
    ...(Object.hasOwn(entry, "quota") ? { quota: entry.quota } : {}),
    ...(Object.hasOwn(entry, "maxConcurrentSubagents") ? { maxConcurrentSubagents: entry.maxConcurrentSubagents } : {}),
  });
}

function validateOperations(value: unknown, revision: number): Readonly<Record<string, EngineModelPolicyOperation>> {
  const operations: Record<string, EngineModelPolicyOperation> = {};
  for (const [id, raw] of Object.entries(object(value, "operations"))) {
    const operation = validatePolicyOperation(id, raw);
    if (operation.storeRevision > revision) fail("ENGINE_MODEL_POLICY_FILE_INVALID", "operation revision exceeds store");
    operations[id] = operation;
  }
  return Object.freeze(operations);
}

function validateLegacyFile(record: Record<string, unknown>): EngineModelPolicyFile {
  const transactional = record.schemaVersion === ENGINE_MODEL_POLICY_TRANSACTION_VERSION;
  exactFields(record, transactional ? "hosts,operations,revision,schemaVersion" : STORE_FIELDS, "engine model policy file");
  const revision = safeRevision(record.revision, "revision", 0);
  const rawHosts = object(record.hosts, "hosts");
  const raw: { host: string; config: EngineModelPolicyConfig; metadata: ReturnType<typeof validateEntryMetadata> }[] = [];
  for (const [rawHost, rawEntry] of Object.entries(rawHosts)) {
    const host = hostId(rawHost), entry = object(rawEntry, `hosts.${host}`);
    exactFields(entry, Object.hasOwn(entry, "quota") ? "actor,categories,decidedIn,decidedInLibraryId,digest,escalation,quota,revision,tiers,updatedAt" : ENTRY_FIELDS, `hosts.${host}`);
    const metadata = validateEntryMetadata(host, entry, revision);
    const config = entryConfig(host, entry, entry.categories);
    const digest = policyDigest(host, config);
    if (entry.digest !== digest) fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.digest does not match its policy`, { host, expected: digest });
    raw.push({ host, config, metadata });
  }
  if ((raw.length === 0) !== (revision === 0)) fail("ENGINE_MODEL_POLICY_FILE_INVALID", "an empty store has revision zero and a configured store has a positive revision");
  const categories = sharedLegacyCategories(raw.map(entry => entry.config.categories));
  const hosts: Record<string, EngineModelPolicyEntry> = {};
  for (const { host, config, metadata } of raw) {
    const shared = validateEngineModelPolicy(host, { ...config, categories });
    hosts[host] = Object.freeze({ ...shared, ...metadata, digest: policyDigest(host, shared) });
  }
  const operations = transactional ? validateOperations(record.operations, revision) : Object.freeze({});
  return Object.freeze({ schemaVersion: ENGINE_MODEL_POLICY_SHARED_VERSION, categoryCatalog: categories, revision, hosts: Object.freeze(hosts), operations });
}

/** Validate the on-disk closed schema, promoting old device files in memory without writing them. */
export function validateEngineModelPolicyFile(value: unknown): EngineModelPolicyFile {
  const record = object(value, "engine model policy file");
  if (record.schemaVersion === ENGINE_MODEL_POLICY_SCHEMA_VERSION || record.schemaVersion === ENGINE_MODEL_POLICY_TRANSACTION_VERSION) return validateLegacyFile(record);
  if (record.schemaVersion !== ENGINE_MODEL_POLICY_SHARED_VERSION) fail("ENGINE_MODEL_POLICY_FILE_INVALID", `schemaVersion must be ${ENGINE_MODEL_POLICY_SHARED_VERSION}`);
  exactFields(record, "categoryCatalog,hosts,operations,revision,schemaVersion", "engine model policy file");
  const revision = safeRevision(record.revision, "revision", 0);
  const categories = validateModelsCategory(record.categoryCatalog);
  const hostsValue = object(record.hosts, "hosts");
  const hosts: Record<string, EngineModelPolicyEntry> = {};
  for (const [rawHost, rawEntry] of Object.entries(hostsValue)) {
    const host = hostId(rawHost), entry = object(rawEntry, `hosts.${host}`);
    const expectedFields = ["actor", ...(Object.hasOwn(entry, "categories") ? ["categories"] : []), "decidedIn", "decidedInLibraryId", "digest", "escalation", ...(Object.hasOwn(entry, "quota") ? ["quota"] : []), ...(Object.hasOwn(entry, "maxConcurrentSubagents") ? ["maxConcurrentSubagents"] : []), "revision", "tiers", "updatedAt"].sort().join(",");
    exactFields(entry, expectedFields, `hosts.${host}`);
    if (Object.hasOwn(entry, "categories") && canonicalJson(validateModelsCategory(entry.categories)) !== canonicalJson(categories)) fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.categories must match the shared category catalog`, { host });
    const metadata = validateEntryMetadata(host, entry, revision);
    const config = entryConfig(host, entry, categories);
    const digest = policyDigest(host, config);
    if (entry.digest !== digest) fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.digest does not match its shared category policy`, { host, expected: digest });
    hosts[host] = Object.freeze({ ...config, ...metadata, digest });
  }
  if ((Object.keys(hosts).length === 0) !== (revision === 0)) fail("ENGINE_MODEL_POLICY_FILE_INVALID", "an empty store has revision zero and a configured store has a positive revision");
  const operations = validateOperations(record.operations, revision);
  return Object.freeze({ schemaVersion: ENGINE_MODEL_POLICY_SHARED_VERSION, categoryCatalog: categories, revision, hosts: Object.freeze(hosts), operations });
}

function persistedEngineModelPolicy(file: EngineModelPolicyFile): Record<string, unknown> {
  const validated = validateEngineModelPolicyFile(file);
  return {
    schemaVersion: ENGINE_MODEL_POLICY_SHARED_VERSION,
    categoryCatalog: validated.categoryCatalog ?? defaultModelsCategory(),
    revision: validated.revision,
    hosts: Object.fromEntries(Object.entries(validated.hosts).map(([host, entry]) => [host, {
      actor: entry.actor, decidedIn: entry.decidedIn, decidedInLibraryId: entry.decidedInLibraryId, digest: entry.digest,
      escalation: entry.escalation, ...(entry.quota === undefined ? {} : { quota: entry.quota }),
      ...(entry.maxConcurrentSubagents === undefined ? {} : { maxConcurrentSubagents: entry.maxConcurrentSubagents }),
      revision: entry.revision, tiers: entry.tiers, updatedAt: entry.updatedAt,
    }])),
    operations: validated.operations ?? {},
  };
}

function assertPolicyQuotaCompatibility(file: EngineModelPolicyFile, values: Readonly<Record<string, string>>): void {
  const generic = genericEngineQuotaFromValues(values).quota;
  for (const [host, entry] of Object.entries(file.hosts)) {
    try { resolveEngineQuotaPolicy(generic, entry.quota); }
    catch { fail("ENGINE_MODEL_POLICY_INVALID", `hosts.${host}.quota is incompatible with generic device quota settings`, { host, path: "quota" }); }
  }
}

/** The current device's single file; an absent file means no engine policy has been configured yet. */
export async function readEngineModelPolicyFile(home: string = deviceHome()): Promise<EngineModelPolicyFile> {
  let text: string;
  try {
    text = await readFile(engineModelPolicyPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return emptyFile();
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail("ENGINE_MODEL_POLICY_FILE_INVALID", `${engineModelPolicyPath(home)} is not JSON`); }
  return validateEngineModelPolicyFile(parsed);
}

/** Build a catalog from one validated snapshot, including a write's lock-held readback. */
export function engineModelPolicyCatalogFromSnapshot(
  fileValue: EngineModelPolicyFile,
  hostValue?: string,
  home: string = deviceHome(),
): EngineModelPolicyCatalog {
  const file = validateEngineModelPolicyFile(fileValue);
  const hosts = Object.fromEntries(Object.entries(file.hosts).sort(([left], [right]) => left.localeCompare(right)));
  const host = hostValue === undefined ? undefined : hostId(hostValue);
  const hasSelectedHost = host !== undefined && Object.hasOwn(file.hosts, host);
  return Object.freeze({
    schemaVersion: ENGINE_MODEL_POLICY_CATALOG_VERSION,
    source: Object.freeze({ kind: "device-engine", path: engineModelPolicyPath(home) }),
    storeRevision: file.revision,
    hosts: Object.freeze(hosts),
    compatibility: Object.freeze({
      projectModelSettings: "read-only-compatibility-input",
      precedence: "configured-device-host-policy-if-present",
      projectOverrideAllowed: false,
    }),
    ...(host === undefined ? {} : {
      selectedHost: host,
      selectedPolicy: hasSelectedHost ? file.hosts[host] : null,
      selectedStatus: hasSelectedHost ? "configured" as const : "unconfigured" as const,
      onboarding: engineModelPolicyOnboarding(host, hasSelectedHost ? file.hosts[host] : null, file.categoryCatalog),
      peerReadiness: codexPeerReadiness(host, hasSelectedHost ? file.hosts[host] : null),
    }),
  });
}

/** A host-aware catalog view; callers may request a syntactically valid but unconfigured host. */
export async function readEngineModelPolicyCatalog(hostValue?: string, home: string = deviceHome()): Promise<EngineModelPolicyCatalog> {
  return engineModelPolicyCatalogFromSnapshot(await readEngineModelPolicyFile(home), hostValue, home);
}

/** Older host writes could supply only their own category rows. Keep other declared rows. */
function categoriesForHostWrite(supplied: ModelsCategories, existing: ModelsCategories): ModelsCategories {
  const result = [...supplied];
  for (const row of existing) {
    if (result.some(category => category.id === row.id)) continue;
    const order = result.some(category => category.order === row.order) ? nextModelRowOrder(result) : row.order;
    result.push({ ...row, order });
  }
  return validateModelsCategory(result);
}

/**
 * Replace one host policy in the device store. The CLI supplies a verified Owner decision and the
 * actual actor; the core checks that receipt's shape again before writing and never touches another
 * host's record.
 */
export async function applyEngineModelPolicySet(input: {
  readonly host: string;
  readonly policy: unknown;
  readonly expectedStoreRevision?: number;
  readonly occurredAt: string;
  readonly actor: string;
  readonly authorization: VerifiedWriteAuthorization;
  readonly home?: string;
}): Promise<EngineModelPolicyFile> {
  const host = hostId(input.host);
  let actor: string;
  try { assertActorId(input.actor); actor = input.actor; } catch { fail("ENGINE_MODEL_POLICY_AUTHORIZATION_REQUIRED", "a valid actual --actor is required"); }
  try { assertStrictInstant(input.occurredAt); } catch { fail("ENGINE_MODEL_POLICY_INVALID", "at must be a strict UTC instant", { path: "at" }); }
  const authorization = input.authorization;
  if (authorization?.target !== ENGINE_MODEL_POLICY_WRITE_TARGET || typeof authorization.decidedIn !== "string" || !DECISION_ID.test(authorization.decidedIn) || typeof authorization.libraryId !== "string" || !LIBRARY_ID.test(authorization.libraryId)) {
    fail("ENGINE_MODEL_POLICY_AUTHORIZATION_REQUIRED", "a verified Owner --decided-in authorization for models.engine-policy is required");
  }
  const config = validateEngineModelPolicy(host, input.policy);
  if (input.expectedStoreRevision !== undefined) safeRevision(input.expectedStoreRevision, "expectedStoreRevision", 0);
  const home = input.home ?? deviceHome();
  const path = engineModelPolicyPath(home);
  const lock = engineModelPolicyLockPath(home);
  await mkdir(dirname(lock), { recursive: true });
  await mkdir(dirname(path), { recursive: true });
  return withFileLock(lock, async () => {
    const current = await readEngineModelPolicyFile(home);
    if (input.expectedStoreRevision !== undefined && current.revision !== input.expectedStoreRevision) fail("ENGINE_MODEL_POLICY_CAS_CONFLICT", "shared categories or another host changed after the approved catalog snapshot", { expectedStoreRevision: input.expectedStoreRevision, actualStoreRevision: current.revision });
    const currentHost = Object.hasOwn(current.hosts, host) ? current.hosts[host] : undefined;
    const categories = input.expectedStoreRevision === undefined && current.revision > 0
      ? categoriesForHostWrite(config.categories, current.categoryCatalog ?? [])
      : config.categories;
    const hosts: Record<string, EngineModelPolicyEntry> = {};
    for (const [otherHost, prior] of Object.entries(current.hosts)) {
      if (otherHost === host) continue;
      const shared = validateEngineModelPolicy(otherHost, {
        categories, tiers: prior.tiers, escalation: prior.escalation,
        ...(prior.quota === undefined ? {} : { quota: prior.quota }),
        ...(prior.maxConcurrentSubagents === undefined ? {} : { maxConcurrentSubagents: prior.maxConcurrentSubagents }),
      });
      hosts[otherHost] = Object.freeze({ ...prior, ...shared, digest: policyDigest(otherHost, shared) });
    }
    const sharedConfig = validateEngineModelPolicy(host, { ...config, categories });
    const entry: EngineModelPolicyEntry = Object.freeze({
      ...sharedConfig,
      revision: (currentHost?.revision ?? 0) + 1,
      digest: policyDigest(host, sharedConfig),
      updatedAt: input.occurredAt,
      actor,
      decidedIn: authorization.decidedIn,
      decidedInLibraryId: authorization.libraryId,
    });
    hosts[host] = entry;
    const next = validateEngineModelPolicyFile({
      schemaVersion: ENGINE_MODEL_POLICY_SHARED_VERSION,
      categoryCatalog: categories,
      revision: current.revision + 1,
      hosts,
      operations: current.operations ?? {},
    });
    const machine = await readMachineSettings(join(home, MACHINE_SETTINGS_FILE_NAME));
    assertPolicyQuotaCompatibility(next, machine.values);
    await writeFileAtomic(path, `${canonicalJson(persistedEngineModelPolicy(next))}\n`);
    // Capture the committed bytes while this host transaction still owns the lock. The CLI uses
    // this snapshot for its receipt, so another same-host writer cannot splice a later policy into
    // this write's revision or audit metadata.
    return await readEngineModelPolicyFile(home);
  });
}

/** Runtime provenance is deliberately separate from portable project configuration. */
export interface EngineExecutionPolicyResolution extends ModelsTierResolution {
  readonly host: string;
  readonly category: string;
  readonly rejections: number;
  readonly escalation: EngineModelPolicyConfig["escalation"];
  readonly hostConcurrencyLimit: number | null;
  readonly quota: EngineQuotaPolicy;
  readonly quotaOrigin: "device-host-policy" | "device-generic" | "engine-default";
  readonly capabilityStatus: "verified-by-caller" | "unchecked";
  readonly origin: {
    readonly kind: "device-engine";
    readonly path: string;
    readonly revision: number;
    readonly storeRevision: number;
    readonly digest: string;
  };
}

export interface EngineExecutionPolicyInput {
  /** Optional evidence supplied by a host adapter, not a baked-in vendor capability roster. */
  readonly availableCombinations?: readonly { readonly runner: string; readonly model: string; readonly effort: string }[];
  readonly host: string;
  readonly genericConcurrencyLimit?: number;
  readonly genericQuota?: EngineQuotaPolicy;
  readonly genericQuotaConfigured?: boolean;
  readonly category: string;
  readonly rejections: number;
  readonly home?: string;
}

export function genericEngineQuotaFromValues(values: Readonly<Record<string, string>>): { readonly quota: EngineQuotaPolicy; readonly configured: boolean } {
  const keys = ["models.quota.fiveHourParallelOffPercent", "models.quota.fiveHourWaitPercent", "models.quota.weeklyParallelOffPercent", "models.quota.weeklyWaitPercent"] as const;
  const value = (key: typeof keys[number], fallback: number | null): number | null => Object.hasOwn(values, key) ? Number(values[key]) : fallback;
  const quota = validateEngineQuotaPolicy({
    fiveHourParallelOffPercent: value(keys[0], DEFAULT_ENGINE_QUOTA_POLICY.fiveHourParallelOffPercent),
    fiveHourWaitPercent: value(keys[1], DEFAULT_ENGINE_QUOTA_POLICY.fiveHourWaitPercent),
    weeklyParallelOffPercent: value(keys[2], DEFAULT_ENGINE_QUOTA_POLICY.weeklyParallelOffPercent),
    weeklyWaitPercent: value(keys[3], DEFAULT_ENGINE_QUOTA_POLICY.weeklyWaitPercent),
  });
  return Object.freeze({ quota, configured: keys.some(key => Object.hasOwn(values, key)) });
}

export function genericEngineConcurrencyFromValues(values: Readonly<Record<string, string>>): number {
  const configured = Object.hasOwn(values, "models.maxConcurrentSubagents") ? Number(values["models.maxConcurrentSubagents"]) : 8;
  if (!Number.isSafeInteger(configured) || configured < 1) fail("ENGINE_MODEL_POLICY_INVALID", "generic maxConcurrentSubagents must be a positive safe integer");
  return configured;
}

/** One validated snapshot drives selection, escalation and provenance, never project models.*. */
export function resolveEngineExecutionPolicyFromSnapshot(
  snapshot: EngineModelPolicyFile,
  input: EngineExecutionPolicyInput,
): EngineExecutionPolicyResolution {
  const host = hostId(input.host);
  const file = validateEngineModelPolicyFile(snapshot);
  const policy = Object.hasOwn(file.hosts, host) ? file.hosts[host] : undefined;
  if (policy === undefined) {
    fail("ENGINE_MODEL_POLICY_UNAVAILABLE", `No device engine policy is configured for host ${host}; project model settings are not a fallback`, { host });
  }
  if (policy.escalation.enabled) {
    const ceiling = [...policy.tiers].sort((a, b) => a.order - b.order).find(row => row.category === policy.escalation.ceiling);
    // Missing rows retain the resolver's MODELS_CATEGORY_EMPTY error and ceiling path.
    if (ceiling !== undefined && (ceiling.model.trim() === "" || ceiling.effort.trim() === "")) {
      fail("ENGINE_MODEL_POLICY_INVALID", "An unconfigured model group cannot be an enabled escalation ceiling", { path: "models.escalation.ceiling", host, category: policy.escalation.ceiling });
    }
  }
  const resolution = resolveModelsTier({ ...policy, category: input.category, rejections: input.rejections });
  if (resolution.record.model.trim() === "" || resolution.record.effort.trim() === "") {
    fail("ENGINE_MODEL_POLICY_UNAVAILABLE", `Selected tier is not configured with a callable model and effort for host ${host}`, { host, order: resolution.record.order });
  }
  if (input.availableCombinations !== undefined && !input.availableCombinations.some((combination) => combination.runner === resolution.record.runner && combination.model === resolution.record.model && combination.effort === resolution.record.effort)) {
    fail("ENGINE_MODEL_POLICY_UNAVAILABLE", `Selected combination is unavailable for host ${host}`, { host, model: resolution.record.model, effort: resolution.record.effort });
  }
  const genericQuota = input.genericQuota === undefined ? DEFAULT_ENGINE_QUOTA_POLICY : validateEngineQuotaPolicy(input.genericQuota);
  const quota = resolveEngineQuotaPolicy(genericQuota, policy.quota);
  const hostQuotaConfigured = policy.quota !== undefined && policy.quota !== null && Object.keys(policy.quota).length > 0;
  return Object.freeze({
    ...resolution,
    capabilityStatus: input.availableCombinations === undefined ? "unchecked" : "verified-by-caller",
    host,
    category: input.category,
    rejections: input.rejections,
    escalation: policy.escalation,
    hostConcurrencyLimit: policy.maxConcurrentSubagents ?? null,
    quota,
    quotaOrigin: hostQuotaConfigured ? "device-host-policy" : input.genericQuotaConfigured ? "device-generic" : "engine-default",
    origin: Object.freeze({
      kind: "device-engine",
      path: engineModelPolicyPath(input.home ?? deviceHome()),
      revision: policy.revision,
      storeRevision: file.revision,
      digest: policy.digest,
    }),
  });
}

/** Real device consumer; unavailable and corrupt policies fail rather than choosing a model. */
export async function resolveEngineExecutionPolicy(input: EngineExecutionPolicyInput): Promise<EngineExecutionPolicyResolution> {
  const home = input.home ?? deviceHome();
  const [policy, machine] = await Promise.all([readEngineModelPolicyFile(home), readMachineSettings(join(home, MACHINE_SETTINGS_FILE_NAME))]);
  const genericQuota = genericEngineQuotaFromValues(machine.values);
  return resolveEngineExecutionPolicyFromSnapshot(policy, { ...input, home, genericQuota: genericQuota.quota, genericQuotaConfigured: genericQuota.configured, genericConcurrencyLimit: genericEngineConcurrencyFromValues(machine.values) });
}

/** Native execution reads intent without turning absence/unsupported combinations into a ban.
 * Corrupt schema/digests and I/O errors deliberately propagate; no catch-all default policy. */
export function resolveNativePolicyIntentFromSnapshot(snapshot: EngineModelPolicyFile, input: EngineExecutionPolicyInput): {
  readonly status: "unconfigured" | "entry-unconfigured" | "configured" | "unsupported";
  readonly selection: EngineExecutionPolicyResolution | null;
} {
  const file = validateEngineModelPolicyFile(snapshot);
  const host = hostId(input.host);
  const policy = Object.hasOwn(file.hosts, host) ? file.hosts[host] : undefined;
  if (!policy) return { status: "unconfigured", selection: null };
  const tier = resolveModelsTier({ ...policy, category: input.category, rejections: input.rejections });
  if (!tier.record.model.trim() || !tier.record.effort.trim()) return { status: "entry-unconfigured", selection: null };
  // Keep exact configured intent even when this host cannot request it.
  const { availableCombinations, ...selectors } = input;
  const selection = resolveEngineExecutionPolicyFromSnapshot(file, selectors);
  const supported = availableCombinations === undefined || availableCombinations.some(tuple => tuple.runner === selection.record.runner && tuple.model === selection.record.model && tuple.effort === selection.record.effort);
  return { status: supported ? "configured" : "unsupported", selection };
}

/** V2 operation receipts live in the same atomic file as the policy they committed. */
export interface EngineModelPolicyOperation {
  readonly id: string;
  readonly host: string;
  readonly changeDigest: string;
  readonly expectedRevision: number;
  readonly expectedDigest: string | null;
  readonly storeRevision: number;
  readonly result: EngineModelPolicyEntry;
}
function operationId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) fail("ENGINE_MODEL_POLICY_INVALID", "operation id must be a nonsecret bounded identifier");
  return value;
}
function validatePolicyOperation(id: string, value: unknown): EngineModelPolicyOperation {
  operationId(id);
  const o = object(value, "operation"); exactFields(o, "changeDigest,expectedDigest,expectedRevision,host,id,result,storeRevision", "operation");
  if (o.id !== id || typeof o.changeDigest !== "string" || !/^[a-f0-9]{64}$/u.test(o.changeDigest)) fail("ENGINE_MODEL_POLICY_FILE_INVALID", "invalid operation identity/digest");
  const host = hostId(o.host); const expectedRevision = safeRevision(o.expectedRevision, "expectedRevision", 0);
  if (o.expectedDigest !== null && (typeof o.expectedDigest !== "string" || !/^[a-f0-9]{64}$/u.test(o.expectedDigest))) fail("ENGINE_MODEL_POLICY_FILE_INVALID", "invalid expected policy digest");
  if ((expectedRevision === 0) !== (o.expectedDigest === null)) fail("ENGINE_MODEL_POLICY_FILE_INVALID", "absent host expectation requires revision zero and null digest");
  const storeRevision = safeRevision(o.storeRevision, "operation storeRevision", 1);
  const rawResult = object(o.result, "operation.result");
  const resultFields = ["actor", "categories", "decidedIn", "decidedInLibraryId", "digest", "escalation", ...(Object.hasOwn(rawResult, "quota") ? ["quota"] : []), ...(Object.hasOwn(rawResult, "maxConcurrentSubagents") ? ["maxConcurrentSubagents"] : []), "revision", "tiers", "updatedAt"].sort().join(",");
  exactFields(rawResult, resultFields, "operation.result");
  const metadata = validateEntryMetadata(host, rawResult, storeRevision);
  const config = entryConfig(host, rawResult, rawResult.categories);
  const digest = policyDigest(host, config);
  if (rawResult.digest !== digest) fail("ENGINE_MODEL_POLICY_FILE_INVALID", "operation result digest does not match its policy");
  const result: EngineModelPolicyEntry = Object.freeze({ ...config, ...metadata, digest });
  if (result.revision !== expectedRevision + 1) fail("ENGINE_MODEL_POLICY_FILE_INVALID", "operation result revision does not follow expected host revision");
  return Object.freeze({ id, host, changeDigest: o.changeDigest, expectedRevision, expectedDigest: o.expectedDigest as string | null, storeRevision, result });
}
/** Exact tier tuple replacements only; unrelated tiers/categories/escalation/quota stay intact. */
export interface EngineModelPolicyTierPatch { readonly order: number; readonly model: string; readonly effort: string }
export interface EngineModelPolicySaveInput {
  readonly host: string;
  readonly expectedRevision: number;
  readonly expectedDigest: string | null;
  readonly operationId: string;
  /** Explicit whole policy for a new/unconfigured host; never inferred from a fallback. */
  readonly initialPolicy?: unknown;
  /** Finite waiting budget only, never an authorization expiry. Default 30 seconds. */
  readonly lockTimeoutMs?: number;
  readonly tiers?: readonly EngineModelPolicyTierPatch[];
  readonly occurredAt: string;
  readonly actor: string;
  readonly authorization: VerifiedWriteAuthorization;
  readonly home?: string;
}
/** Deterministic failure seams are not exposed through CLI or persisted configuration. */
export interface EngineModelPolicySaveFaults {
  readonly atomicWriteOptions?: AtomicWriteOptions;
  readonly afterAtomicWriteBeforeAcknowledgement?: () => Promise<void>;
  readonly afterLockReleaseBeforeAcknowledgement?: () => Promise<void>;
  readonly beforeAtomicWrite?: () => Promise<void>;
  readonly afterCommitBeforeReadback?: () => Promise<void>;
  readonly afterReadbackBeforeReturn?: () => Promise<void>;
}
export interface EngineModelPolicyOperationReadback {
  readonly schemaVersion: string;
  readonly operationId: string;
  readonly status: "recorded" | "not-recorded";
  readonly operation: EngineModelPolicyOperation | null;
  readonly currentHost: EngineModelPolicyEntry | null;
  readonly storeRevision: number;
  readonly readOnly: boolean;
}
export async function readEngineModelPolicyOperation(idValue: string, home?: string): Promise<EngineModelPolicyOperationReadback> {
  const id = operationId(idValue), file = await readEngineModelPolicyFile(home);
  const operation = file.operations && Object.hasOwn(file.operations, id) ? file.operations[id]! : null;
  return { schemaVersion: "tcrn.engine-model-policy-operation.v1", operationId: id, status: operation ? "recorded" : "not-recorded", operation, currentHost: operation ? file.hosts[operation.host] ?? null : null, storeRevision: file.revision, readOnly: true };
}
export async function applyEngineModelPolicySave(input: EngineModelPolicySaveInput, faults: EngineModelPolicySaveFaults = {}): Promise<{ readonly status: "committed" | "replayed"; readonly operation: EngineModelPolicyOperation; readonly readback: EngineModelPolicyFile }> {
  const host = hostId(input.host), id = operationId(input.operationId);
  const timeoutMs = input.lockTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) fail("ENGINE_MODEL_POLICY_INVALID", "lockTimeoutMs must be a nonnegative finite integer");
  const expectedRevision = safeRevision(input.expectedRevision, "expectedRevision", 0);
  if ((input.expectedDigest !== null && (typeof input.expectedDigest !== "string" || !/^[a-f0-9]{64}$/u.test(input.expectedDigest))) || (expectedRevision === 0) !== (input.expectedDigest === null)) fail("ENGINE_MODEL_POLICY_INVALID", "expected revision and digest must identify the same host snapshot");
  try { assertActorId(input.actor); assertStrictInstant(input.occurredAt); } catch { fail("ENGINE_MODEL_POLICY_AUTHORIZATION_REQUIRED", "actual actor and valid instant required"); }
  const a = input.authorization;
  if (a?.target !== ENGINE_MODEL_POLICY_WRITE_TARGET || !DECISION_ID.test(a.decidedIn) || !LIBRARY_ID.test(a.libraryId)) fail("ENGINE_MODEL_POLICY_AUTHORIZATION_REQUIRED", "verified models.engine-policy Owner decision required");
  if ((input.initialPolicy !== undefined) === (input.tiers !== undefined)) fail("ENGINE_MODEL_POLICY_INVALID", "choose explicit initialPolicy or exact tier replacements");
  if (input.initialPolicy !== undefined && expectedRevision !== 0) fail("ENGINE_MODEL_POLICY_INVALID", "initialPolicy only creates an absent host; existing host saving uses exact tiers");
  let initial: EngineModelPolicyConfig | undefined;
  if (input.initialPolicy !== undefined) initial = validateEngineModelPolicy(host, input.initialPolicy);
  const tiers = input.tiers;
  if (tiers !== undefined) {
    if (!Array.isArray(tiers) || tiers.length === 0 || tiers.some(t => !t || typeof t !== "object" || Array.isArray(t)) || new Set(tiers.map(t => t.order)).size !== tiers.length) fail("ENGINE_MODEL_POLICY_INVALID", "tier replacements must be nonempty and unique");
    for (const tier of tiers) {
      exactFields(object(tier, "tier replacement"), "effort,model,order", "tier replacement");
      if (!Number.isSafeInteger(tier.order) || tier.order < 1 || typeof tier.model !== "string" || !tier.model.trim() || typeof tier.effort !== "string" || !tier.effort.trim()) fail("ENGINE_MODEL_POLICY_INVALID", "replacement needs order and explicit model/effort");
    }
  }
  const changeDigest = canonicalSha256({ host, expectedRevision, expectedDigest: input.expectedDigest, actor: input.actor, authorization: a, ...(initial === undefined ? { tiers } : { initialPolicy: initial }) });
  const home = input.home ?? deviceHome(), path = engineModelPolicyPath(home), lock = engineModelPolicyLockPath(home);
  await mkdir(dirname(lock), { recursive: true }); await mkdir(dirname(path), { recursive: true });
  let phase: "not-written" | "prewrite" | "atomic-write" | "committed" | "readback-confirmed" | "existing-commit" = "not-written";
  try { const result = await withFileLock(lock, async () => {
    const current = await readEngineModelPolicyFile(home);
    const prior = current.operations && Object.hasOwn(current.operations, id) ? current.operations[id] : undefined;
    if (prior) {
      if (prior.changeDigest !== changeDigest || prior.host !== host) fail("ENGINE_MODEL_POLICY_OPERATION_CONFLICT", "operation id was already used for different authorized changes", { operationId: id });
      phase = "existing-commit";
      return { status: "replayed" as const, operation: prior, readback: current };
    }
    const held = Object.hasOwn(current.hosts, host) ? current.hosts[host] : undefined;
    if ((held?.revision ?? 0) !== expectedRevision || (held?.digest ?? null) !== input.expectedDigest) fail("ENGINE_MODEL_POLICY_CAS_CONFLICT", "host changed after the approved snapshot; preserve current policy and reconcile", { host, expectedRevision, actualRevision: held?.revision ?? 0, expectedDigest: input.expectedDigest, actualDigest: held?.digest ?? null });
    if (!initial && !held) fail("ENGINE_MODEL_POLICY_UNAVAILABLE", "absent host requires an explicitly approved complete initialPolicy");
    if (tiers?.some(tier => !held?.tiers.some(row => row.order === tier.order))) fail("ENGINE_MODEL_POLICY_INVALID", "a selected tier no longer exists; do not invent rows");
    const candidate = initial ?? validateEngineModelPolicy(host, { categories: held!.categories, tiers: held!.tiers.map(row => { const patch = tiers!.find(tier => tier.order === row.order); return patch ? { ...row, model: patch.model, effort: patch.effort } : row; }), escalation: held!.escalation, ...(held!.quota === undefined ? {} : { quota: held!.quota }), ...(held!.maxConcurrentSubagents === undefined ? {} : { maxConcurrentSubagents: held!.maxConcurrentSubagents }) });
    const nextCategories = current.revision === 0 && Object.keys(current.hosts).length === 0 ? candidate.categories : current.categoryCatalog ?? candidate.categories;
    if (Object.keys(current.hosts).length > 0 && canonicalJson(candidate.categories) !== canonicalJson(nextCategories)) fail("ENGINE_MODEL_POLICY_INVALID", "a new host must use the current shared category catalog");
    const config = validateEngineModelPolicy(host, { ...candidate, categories: nextCategories });
    const result: EngineModelPolicyEntry = { ...config, revision: expectedRevision + 1, digest: policyDigest(host, config), updatedAt: input.occurredAt, actor: input.actor, decidedIn: a.decidedIn, decidedInLibraryId: a.libraryId };
    const operation: EngineModelPolicyOperation = { id, host, changeDigest, expectedRevision, expectedDigest: input.expectedDigest, storeRevision: current.revision + 1, result };
    const storedResult = result;
    const next = validateEngineModelPolicyFile({ schemaVersion: ENGINE_MODEL_POLICY_SHARED_VERSION, categoryCatalog: nextCategories, revision: current.revision + 1, hosts: { ...current.hosts, [host]: storedResult }, operations: { ...current.operations, [id]: operation } });
    const machine = await readMachineSettings(join(home, MACHINE_SETTINGS_FILE_NAME));
    assertPolicyQuotaCompatibility(next, machine.values);
    phase = "prewrite"; await faults.beforeAtomicWrite?.();
    phase = "atomic-write"; await writeFileAtomic(path, `${canonicalJson(persistedEngineModelPolicy(next))}\n`, faults.atomicWriteOptions);
    await faults.afterAtomicWriteBeforeAcknowledgement?.();
    phase = "committed"; await faults.afterCommitBeforeReadback?.();
    const readback = await readEngineModelPolicyFile(home);
    phase = "readback-confirmed"; await faults.afterReadbackBeforeReturn?.();
    return { status: "committed" as const, operation: readback.operations![id]!, readback };
  }, { timeoutMs, command: "einzbern engine-model-policy-save" });
    await faults.afterLockReleaseBeforeAcknowledgement?.();
    return result;
  }
  catch (error) {
    const failurePhase = phase as string; // callback writes are intentionally observed after rejection
    if (failurePhase === "not-written") throw error;
    const writeOutcome = failurePhase === "prewrite" ? "not-written" : failurePhase === "atomic-write" ? "unknown" : failurePhase === "existing-commit" ? "previously-committed" : "committed";
    const rawCause = String((error as { reasonCode?: unknown; code?: unknown }).reasonCode ?? (error as { code?: unknown }).code ?? "UNKNOWN");
    const causeCode = ["EIO", "ENOSPC", "EACCES", "EPERM", "EROFS", "ENOENT", "EBUSY", "ATOMIC_WRITE_INTERRUPTED", "ATOMIC_WRITE_RENAME_FAILED", "FILE_LOCK_LOST", "FILE_LOCK_TIMEOUT", "ENGINE_MODEL_POLICY_FILE_INVALID"].includes(rawCause) ? rawCause : "UNKNOWN";
    throw new EngineModelPolicyError(writeOutcome === "not-written" ? "ENGINE_MODEL_POLICY_SAVE_FAILED" : "ENGINE_MODEL_POLICY_SAVE_RECONCILIATION_REQUIRED", "Save did not return a complete receipt; inspect the read-only operation result before retry", { operationId: id, host, phase: failurePhase, writeOutcome, causeCode, readbackConfirmed: failurePhase === "readback-confirmed" || failurePhase === "existing-commit" });
  }
}
