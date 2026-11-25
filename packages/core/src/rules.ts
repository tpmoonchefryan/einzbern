import { planPrinciples, principleLine, PRINCIPLES_ID, ruleLine } from "./agents-principles.js";
import { assertNotDotAgentsTarget } from "./dot-agents.js";
import { effectiveProjectState } from "./project-chain.js";
import { scopedWorkspaceState } from "./project-scope.js";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-483 R2, R3 (MIN-228 D3, MIN-229 D6; TCRN-CROSS-SUB-336): the Command Spell rules
// a project has switched on, and the state each of them is in. Every rule is off until it is
// enabled: a library that holds no record of a rule has it disabled. Enabling a rule records it in
// the library's rule collection (config-records.ts) as {enabled: true, version}, at the version
// this engine ships. The writer places its one-line principle in the shared agents section of
// AGENTS.md in the project's artifact language. Disabling removes the selected line and records
// {enabled: false, version}. Legacy rule:<id> sections retain their ownership during migration.
//
// A rule's state is read from three places, the rule's record, the section's record and the
// section as it now stands in AGENTS.md, against this engine's catalog body (rules-catalog.ts):
//
//   disabled            no record, or a record that says it is off;
//   output-unconfigured enabled, but no output root was available to inspect;
//   removed-from-file   enabled, and inspected AGENTS.md holds no markers of its section;
//   pending             enabled, and a write of its section was refused because the user had
//                       changed it: the section waits for rule-resolve;
//   user-modified       enabled, and the section is not the text the engine wrote: the user changed
//                       it, or kept a change as theirs (rule-resolve keep), after which the engine
//                       never writes it again;
//   update-available    enabled and intact, but its body differs from the current catalog;
//   enabled             enabled, and the section matches the current catalog.
//
// Reading writes nothing. Managed renders refresh enabled built-ins; engine updates invoke that
// writer for existing registered harness outputs, preserving Owner text and local section ownership.
//
// TCRN-CROSS-STORY-508 R7 (MIN-236 D7): a rule's record may also hold an order, a positive integer
// that places its line among the principles in AGENTS.md. rule-enable sets it when given and
// keeps the recorded one otherwise, and
// rule-disable keeps it, so a rule enabled again takes its old place.
//
// TCRN-CROSS-STORY-489 (TCRN-CROSS-SUB-366): enabling and disabling write AGENTS.md before they
// commit the records. When that commit fails, the file goes back to what it held before the error
// goes on (agents-sections.ts, putBackUnrecorded), so AGENTS.md never holds a section the library
// does not record, nor lacks one the library still records.
//
// TCRN-CROSS-STORY-538 GWT3 (TCRN-CROSS-SUB-499): both read the library and plan AGENTS.md outside the
// library write lock, and write and record under it only while neither has moved since they read
// them (workspace.ts, appendPlannedWrite); a change that writes no file is checked the same way
// before its record goes in.
//
// TCRN-CROSS-STORY-540 GWT1 (MIN-258 D3(c), which replaces MIN-245 D6; TCRN-CROSS-SUB-505): a
// coordination library's rules go the same way as a project's, into the AGENTS.md of the project root
// this device registered for it (agents-sections.ts, managedOutputBinding), and their states are read
// from the same three places. A coordination library this device registered no such root for has
// nowhere to write: enabling or disabling a rule there records the rule alone, as it did before, and
// says so (outputBindingStatus unconfigured).

import { join } from "node:path";

import { compareCanonicalText } from "../../protocol/src/index.js";
import { AGENTS_FILE, RULE_SECTION_PREFIX, AgentsSectionError, commitPlanned, filesAsPlanned, managedOutputBinding, putBackUnrecorded } from "./agents-sections.js";
import type { ManagedOutputBinding, SectionChangeResult } from "./agents-sections.js";
import { configRecord, configRecords, removeConfigRecordDelta, setConfigRecordDelta } from "./config-records.js";
import { applyManagedWrite, managedSectionRecordKey, managedSectionRecordsFor, parseManagedFile, planManagedWrite, sectionDigest } from "./managed-sections.js";
import type { ManagedSectionRecord, ManagedSectionResult, ManagedWritePlan, ParsedSection } from "./managed-sections.js";
import { BUILT_IN_RULES } from "./rules-catalog.js";
import type { BuiltInRule } from "./rules-catalog.js";
import { appendPlannedWrite, materializeWorkspace } from "./workspace.js";
import type { LibraryWritePlan, MutationDelta, WorkspaceMutationOptions, WorkspaceState } from "./workspace.js";

export const RULES_REASON_CODES = Object.freeze([
  "RULE_RECORD_INVALID",
  "RULE_UNKNOWN",
  "RULE_VERSION_NEWER",
] as const);

export type RulesReasonCode = typeof RULES_REASON_CODES[number];

export class RuleError extends Error {
  readonly reasonCode: RulesReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: RulesReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "RuleError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: RulesReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new RuleError(reasonCode, message, details);
}

/** The states a rule can be in, as the header of this module describes them. */
export const RULE_STATES = Object.freeze(["disabled", "enabled", "user-modified", "removed-from-file", "update-available", "pending", "output-unconfigured"] as const);
export type RuleState = typeof RULE_STATES[number];

/** What a rule's record holds; the rule's id is the record's key. A record without an order has no order field. */
export interface RuleRecordValue {
  readonly enabled: boolean;
  readonly version: number;
  readonly order?: number;
}

// A rule id: a lowercase letter, then lowercase letters, digits and hyphens, so
// rule:<id> is a managed-section id as well.
const RULE_ID = /^[a-z][a-z0-9-]*$/u;
const RECORD_FIELDS = "enabled,version";
const ORDERED_RECORD_FIELDS = "enabled,order,version";

export function isRuleId(value: unknown): value is string {
  return typeof value === "string" && RULE_ID.test(value);
}

// TCRN-CROSS-STORY-508 R7: an order is a positive integer.
function isOrder(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** The id of a rule's managed section in AGENTS.md: rule:<rule id>. */
export function ruleSectionId(id: string): string {
  return `${RULE_SECTION_PREFIX}${id}`;
}

/**
 * The check the rule collection of config-records.ts applies to a record: keyed by a rule id, and
 * holding exactly whether the rule is enabled and the version it was enabled at, and, when it has
 * one, its order (TCRN-CROSS-STORY-508 R7). Only the shape is checked, so a library that records a
 * rule this engine does not ship still replays.
 */
export function checkRuleRecordValue(value: Readonly<Record<string, unknown>>, key: string): void {
  if (!isRuleId(key)) fail("RULE_RECORD_INVALID", `${key} is not a rule id`, { key });
  const fields = Object.keys(value).sort(compareCanonicalText).join(",");
  if (fields !== RECORD_FIELDS && fields !== ORDERED_RECORD_FIELDS) {
    fail("RULE_RECORD_INVALID", "a rule record holds exactly enabled and version, and may hold an order", { key });
  }
  if (typeof value.enabled !== "boolean" || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1) {
    fail("RULE_RECORD_INVALID", `the rule record ${key} holds a boolean enabled and a positive integer version`, { key });
  }
  if (value.order !== undefined && !isOrder(value.order)) {
    fail("RULE_RECORD_INVALID", `the order of the rule record ${key} is a positive integer`, { key, field: "order" });
  }
}

/** One rule as listRules reports it. */
export interface RuleStatus {
  readonly id: string;
  // The version this engine ships; null for a rule the library records and this engine does not ship.
  readonly version: number | null;
  // The version the library's record holds; null when the library holds no record of the rule.
  readonly recordedVersion: number | null;
  // The revision the section's start marker carries in AGENTS.md; null when the file holds no such section.
  readonly fileVersion: number | null;
  readonly section: string;
  readonly state: RuleState;
  // TCRN-CROSS-STORY-508 R7: the order the library's record holds; absent when it holds none.
  readonly order?: number;
}

// The language a project writes its artifacts in, which picks a rule's text.
function artifactLanguage(state: Pick<WorkspaceState, "settings">): string | null {
  return state.settings.find((setting) => setting.key === "artifact.language")?.value ?? null;
}

function recordedRule(state: Pick<WorkspaceState, "configRecords">, id: string): RuleRecordValue | null {
  const record = configRecord(state, "rule", id);
  return record === null ? null : record.value as unknown as RuleRecordValue;
}

// The managed sections of a project's AGENTS.md, by id. The managed-section writer reads the file
// the way it reads one before a write (a regular UTF-8 file or none, markers that parse); a plan
// with nothing to write writes nothing.
async function sectionsOfAgentsFile(projectRoot: string): Promise<ReadonlyMap<string, ParsedSection>> {
  const probe = await planManagedWrite({ filePath: join(projectRoot, AGENTS_FILE), file: AGENTS_FILE, desired: [], records: [] });
  return sectionsOfText(probe.before);
}

function sectionsOfText(text: string | null): ReadonlyMap<string, ParsedSection> {
  if (text === null) return new Map();
  return new Map(parseManagedFile(text, AGENTS_FILE).sections.map((section) => [section.id, section]));
}

/**
 * The state of one rule (the header of this module): from its record, the version this engine
 * ships (null when it ships none), its section as the file holds it (null when the markers are
 * not there) and the library's record of that section.
 */
export function ruleState(input: {
  readonly record: RuleRecordValue | null;
  readonly shippedVersion: number | null;
  readonly shippedDigest?: string | null;
  readonly section: ParsedSection | null;
  readonly sectionRecord: ManagedSectionRecord | null;
  readonly outputConfigured?: boolean;
}): RuleState {
  const { record, shippedVersion, section, sectionRecord } = input;
  if (record === null || !record.enabled) return "disabled";
  if (input.outputConfigured === false) return "output-unconfigured";
  if (section === null) return "removed-from-file";
  if (sectionRecord?.state === "pending") return "pending";
  const changed = section.digest !== section.bodyDigest ||
    (sectionRecord !== null && (sectionRecord.digest !== section.digest || sectionRecord.state === "user-owned" || sectionRecord.state === "unmanaged"));
  if (changed) return "user-modified";
  // Body corrections can ship without changing the rule version. Conversely, a render
  // can refresh an enabled rule without changing the version at which it was enabled.
  if (input.shippedDigest != null) return section.bodyDigest === input.shippedDigest ? "enabled" : "update-available";
  if (shippedVersion !== null && shippedVersion > record.version) return "update-available";
  return "enabled";
}

function statusOf(state: Pick<WorkspaceState, "configRecords" | "settings">, inFile: ReadonlyMap<string, ParsedSection>, catalog: readonly BuiltInRule[], id: string, outputConfigured = true): RuleStatus {
  const record = recordedRule(state, id);
  const shipped = catalog.find(rule => rule.id === id);
  const legacy = ruleSectionId(id);
  const section = inFile.has(legacy) || !shipped ? legacy : PRINCIPLES_ID;
  const physical = inFile.get(section) ?? null;
  const sectionRecord = managedSectionRecordsFor(state, AGENTS_FILE).find(entry => entry.id === section) ?? null;
  const language = artifactLanguage(state);
  let status = ruleState({ record, shippedVersion: shipped?.version ?? null, section: physical, sectionRecord, outputConfigured });
  if (physical && shipped && (status === "enabled" || status === "update-available")) {
    const line = section === PRINCIPLES_ID ? ruleLine(physical.body, shipped) : undefined;
    if (section !== PRINCIPLES_ID) status = "update-available";
    else if (!line) status = "removed-from-file";
    else status = sectionDigest(line) === sectionDigest(principleLine(shipped, language)) ? "enabled" : "update-available";
  }
  return {
    id,
    version: shipped?.version ?? null,
    recordedVersion: record?.version ?? null,
    fileVersion: status === "disabled" || status === "removed-from-file" ? null : physical?.rev ?? null,
    section,
    state: status,
    ...(record?.order === undefined ? {} : { order: record.order }),
  };
}

function ruleStatuses(state: Pick<WorkspaceState, "configRecords" | "settings">, inFile: ReadonlyMap<string, ParsedSection>, catalog: readonly BuiltInRule[], outputConfigured = true): readonly RuleStatus[] {
  const shipped: readonly string[] = catalog.map((rule) => rule.id);
  const recordedOnly = configRecords(state, "rule").map((record) => record.key).filter((id) => !shipped.includes(id)).sort(compareCanonicalText);
  return [...shipped, ...recordedOnly].map((id) => statusOf(state, inFile, catalog, id, outputConfigured));
}

export interface ListRulesInput {
  readonly configurationProjectId?: string;
  readonly libraryRoot: string;
  readonly projectRoot?: string;
  // The rules this engine ships (BUILT_IN_RULES); a test hands in another catalog here.
  readonly catalog?: readonly BuiltInRule[];
}

/**
 * Every rule this engine ships, in catalog order, then every other rule the library records, with
 * its state in the project. Writes nothing.
 */
export async function listRules(input: ListRulesInput): Promise<readonly RuleStatus[]> {
  const state = await effectiveProjectState(await materializeWorkspace(input.libraryRoot), input.configurationProjectId);
  return listRulesFromProjectState(state, input.projectRoot, input.catalog);
}

/** Read the rule files against a project state the caller has already materialized and scoped. */
export async function listRulesFromProjectState(
  state: Pick<WorkspaceState, "configRecords" | "settings">,
  projectRoot?: string,
  catalog: readonly BuiltInRule[] = BUILT_IN_RULES,
): Promise<readonly RuleStatus[]> {
  const sections = projectRoot === undefined ? new Map() : await sectionsOfAgentsFile(projectRoot);
  return ruleStatuses(state, sections, catalog, projectRoot !== undefined);
}

export interface RuleChangeInput extends WorkspaceMutationOptions {
  readonly libraryRoot: string;
  readonly projectRoot: string;
  readonly id: string;
  // Where an original is copied before it is replaced: the device directory's backups by default.
  readonly backupRoot?: string;
  // The rules this engine ships (BUILT_IN_RULES); a test hands in another catalog here.
  readonly catalog?: readonly BuiltInRule[];
  // TCRN-CROSS-STORY-527 (Q24; TCRN-CROSS-SUB-477): deltas appended after the change's own, in the
  // same append: Atelier's approval of a proposed rule change settles the proposal here, so the
  // records and the settlement land together or, with AGENTS.md put back, not at all. They are not
  // counted in `recorded`.
  readonly alongside?: readonly ((state: WorkspaceState) => MutationDelta)[];
}

/** What enabling or disabling a rule did. */
export interface RuleChange {
  readonly id: string;
  readonly section: string;
  readonly file: string;
  readonly action: "enable" | "disable";
  // For enable, what the managed-section writer did with the section; for disable, disabled or unchanged.
  readonly result: ManagedSectionResult | SectionChangeResult;
  readonly written: boolean;
  // Where AGENTS.md was copied before it was replaced; null when nothing was replaced.
  readonly backupPath: string | null;
  // How many records the change wrote to the library.
  readonly recorded: number;
  // TCRN-CROSS-STORY-540 (TCRN-CROSS-SUB-505): bound when the change went to AGENTS.md; unconfigured
  // when the library is a coordination library this device registered no project root for, so the
  // change recorded the rule alone (agents-sections.ts, managedOutputBinding).
  readonly outputBindingStatus: ManagedOutputBinding;
  readonly status: RuleStatus;
  readonly state: WorkspaceState;
}

// TCRN-CROSS-STORY-538 GWT3 (TCRN-CROSS-SUB-499): what a rule change plans outside the library write
// lock, for the lock to write and record. With no project root to write (TCRN-CROSS-STORY-540: a
// coordination library this device registered none for) the plan is the rule's record alone
// (commitRecordOnlyRule); otherwise it is the plan of the rule's section as well. `recorded` counts
// the change's own deltas, `deltas` those and the ones alongside them.
interface RecordOnlyRulePlan {
  readonly kind: "record-only";
  readonly recorded: number;
  readonly deltas: number;
}

// TCRN-CROSS-STORY-526 (TCRN-CROSS-SUB-452): every delta of a rule change carries the change's
// authorization (input.authorization), so each event it appends records how the change was let through.
//
// A rule change with nowhere to write, planned: the rule's record as {enabled, version, order},
// unless the library records it so already.
function planRecordOnlyRule(state: Pick<WorkspaceState, "configRecords">, input: RuleChangeInput, enabled: boolean, version: number, order?: number): LibraryWritePlan<RecordOnlyRulePlan> {
  const previous = recordedRule(state, input.id);
  const value = { enabled, version, ...(order === undefined ? {} : { order }) };
  const deltas = previous?.enabled === enabled && previous.version === version && previous.order === order ? [] : [setConfigRecordDelta({ ...(input.configurationProjectId === undefined ? {} : { projectId: input.configurationProjectId }), ...(input.authorization === undefined ? {} : { authorization: input.authorization }), collection: "rule", key: input.id, value })];
  const all = [...deltas, ...(input.alongside ?? [])];
  return { deltas: all, plan: { kind: "record-only", recorded: deltas.length, deltas: all.length } };
}

// A rule change with nowhere to write, recorded under the lock. Its state is read as any rule's is,
// against no file: an enabled rule then reads output-unconfigured, not a file deletion.
async function commitRecordOnlyRule(root: string, append: () => Promise<WorkspaceState>, input: RuleChangeInput, enabled: boolean, planned: RecordOnlyRulePlan): Promise<RuleChange> {
  const committed = await commitPlanned(root, append, planned.deltas);
  return { id: input.id, section: ruleSectionId(input.id), file: AGENTS_FILE, action: enabled ? "enable" : "disable", result: "unchanged", written: false, backupPath: null, recorded: planned.recorded, outputBindingStatus: "unconfigured", status: statusOf(scopedWorkspaceState(committed, input.configurationProjectId), new Map(), input.catalog ?? BUILT_IN_RULES, input.id, false), state: committed };
}

/**
 * Enable a rule at the shipped version and render its principle into the shared agents section
 * of AGENTS.md in the project's artifact language. The section goes
 * through the managed-section writer, so a section the user changed is left as it is and waits
 * (pending), one the user kept is never written again, one whose markers the user removed is not
 * put back, and a file that does not exist is created. A library that records the rule at a
 * version newer than this engine ships is refused (RULE_VERSION_NEWER), so an older engine never
 * writes an older text over a newer one.
 *
 * TCRN-CROSS-STORY-508 R7: `order` sets the rule's order; left out, the rule keeps the order its
 * record holds. The shared section uses this order for its principle lines.
 *
 * TCRN-CROSS-STORY-489: when the records cannot be committed, AGENTS.md returns to what it held,
 * and a file the enable created is taken away, before the error goes on.
 *
 * TCRN-CROSS-STORY-538 GWT3 (TCRN-CROSS-SUB-499): the library is read and AGENTS.md planned outside
 * the library write lock; under it the file is written and the records appended only while the
 * library stands where it was read and the file holds what was read, and the enable is planned again
 * otherwise (workspace.ts, appendPlannedWrite).
 */
export function enableRule(input: RuleChangeInput & { readonly order?: number }): Promise<RuleChange> {
  return changeRule(input, true);
}

export function disableRule(input: RuleChangeInput & { readonly force?: boolean }): Promise<RuleChange> {
  return changeRule(input, false);
}

interface BoundRulePlan {
  readonly kind: "project";
  readonly plan: ManagedWritePlan;
  readonly result: ManagedSectionResult | "disabled";
  readonly recorded: number;
  readonly deltas: number;
}

/** Stage the rule declaration and render the whole block against it in one transaction. */
async function changeRule(input: RuleChangeInput & { readonly order?: number; readonly force?: boolean }, enabled: boolean): Promise<RuleChange> {
  await assertNotDotAgentsTarget(input.projectRoot);
  const catalog = input.catalog ?? BUILT_IN_RULES;
  const rule = catalog.find(entry => entry.id === input.id);
  if (enabled && !rule) fail("RULE_UNKNOWN", `the engine ships no rule ${JSON.stringify(input.id)}`, { id: input.id, known: catalog.map(r => r.id).join(",") });
  if (input.order !== undefined && !isOrder(input.order)) fail("RULE_RECORD_INVALID", "a rule order must be a positive integer", { id: input.id, field: "order" });
  const scope = { ...(input.configurationProjectId === undefined ? {} : { projectId: input.configurationProjectId }),
    ...(input.authorization === undefined ? {} : { authorization: input.authorization }) };
  return appendPlannedWrite<RecordOnlyRulePlan | BoundRulePlan, RuleChange>(input.libraryRoot, input, {
    plan: async (root, nativeState) => {
      const state = await effectiveProjectState(nativeState, input.configurationProjectId);
      const recorded = recordedRule(state, input.id);
      if (!recorded && !rule) fail("RULE_UNKNOWN", `unknown rule ${input.id}`, { id: input.id, known: catalog.map(r => r.id).join(",") });
      if (enabled && recorded && rule && recorded.version > rule.version) {
        fail("RULE_VERSION_NEWER", `the library records a newer version of ${input.id}`, { id: input.id, recordedVersion: String(recorded.version), version: String(rule.version) });
      }
      const version = enabled ? rule!.version : recorded?.version ?? rule!.version;
      const order = input.order ?? recorded?.order;
      const binding = state.settings.some(s => s.key === "agents.generation" && s.value === "none") ? "unconfigured" : await managedOutputBinding(root, input.projectRoot, nativeState);
      if (binding === "unconfigured") return planRecordOnlyRule(state, input, enabled, version, order);
      const value = { enabled, version, ...(order === undefined ? {} : { order }) };
      const next = { settings: state.settings, configRecords: [...state.configRecords.filter(r => r.collection !== "rule" || r.key !== input.id), { collection: "rule" as const, key: input.id, value }] };
      const plan = await planPrinciples(input.projectRoot, next, { catalog, ...(enabled ? {} : { disable: { id: input.id, force: input.force === true } }) });
      const legacy = ruleSectionId(input.id);
      const inFile = sectionsOfText(plan.before);
      const current = statusOf(state, inFile, catalog, input.id);
      const target = inFile.has(legacy) ? legacy : PRINCIPLES_ID;
      const decision = plan.sections.find(d => d.id === target);
      if (!enabled && !input.force && (plan.pending.includes(legacy) || current.state === "user-modified" || current.state === "pending" ||
        (inFile.has(legacy) && decision?.record.state === "user-owned"))) {
        throw new AgentsSectionError("MANAGED_SECTION_FORCE_REQUIRED", `disabling ${input.id} would affect a changed section`, { file: AGENTS_FILE, section: target, state: current.state });
      }
      const deltas: ((state: WorkspaceState) => MutationDelta)[] = [];
      if ((enabled || recorded !== null) && (recorded?.enabled !== enabled || recorded.version !== version || recorded.order !== order)) {
        deltas.push(setConfigRecordDelta({ ...scope, collection: "rule", key: input.id, value }));
      }
      for (const d of plan.sections.filter(d => d.recordChanged)) {
        const key = managedSectionRecordKey(AGENTS_FILE, d.id);
        deltas.push(d.forgetRecord ? removeConfigRecordDelta({ ...scope, collection: "managed-section", key })
          : setConfigRecordDelta({ ...scope, collection: "managed-section", key, value: d.record }));
      }
      const all = [...deltas, ...(input.alongside ?? [])];
      const result = enabled ? (plan.sections.find(d => d.id === (plan.pending.includes(legacy) ? legacy : PRINCIPLES_ID))?.result ?? "unchanged")
        : (plan.write || deltas.length ? "disabled" : "unchanged");
      return { deltas: all, plan: { kind: "project", plan, result, recorded: deltas.length, deltas: all.length } };
    },
    unchanged: async planned => planned.kind === "record-only" || await filesAsPlanned([planned.plan]),
    write: async (root, nativeState, planned, append) => {
      if (planned.kind === "record-only") return commitRecordOnlyRule(root, append, input, enabled, planned);
      const { plan } = planned;
      const applied = await applyManagedWrite(plan, { now: input.occurredAt, ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }) });
      let committed: WorkspaceState;
      try { committed = await commitPlanned(root, append, planned.deltas); }
      catch (error) {
        await putBackUnrecorded(root, nativeState, applied.written ? [plan] : []);
        throw error;
      }
      const status = statusOf(await effectiveProjectState(committed, input.configurationProjectId), sectionsOfText(plan.after ?? plan.before), catalog, input.id);
      return { id: input.id, section: status.section, file: AGENTS_FILE, action: enabled ? "enable" : "disable",
        result: planned.result, written: applied.written, backupPath: applied.backupPath, recorded: planned.recorded,
        outputBindingStatus: "bound", status, state: committed };
    },
  });
}
