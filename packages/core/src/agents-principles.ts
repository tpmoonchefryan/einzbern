// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { managedSectionRecordsFor, parseManagedFile, planManagedText, planManagedWrite, renderSection, replaceSection, sectionDigest } from "./managed-sections.js";
import type { ManagedSectionRecord, ManagedWritePlan, ParsedManagedFile } from "./managed-sections.js";
import { NAVIGATION_LINES } from "./navigation-lines.js";
import { BUILT_IN_RULES } from "./rules-catalog.js";
import type { BuiltInRule } from "./rules-catalog.js";
import { compareRecordOrder } from "./variables.js";
import { RETIRED_VARIABLE_SECTION_IDS } from "./variables-sections.js";
import type { WorkspaceState } from "./workspace.js";

export const PRINCIPLES_ID = "agents";
const FILE = "AGENTS.md";
type Configuration = Pick<WorkspaceState, "configRecords" | "settings">;

export function principleLine(rule: BuiltInRule, language: string | null): string {
  return language === "zh-CN" ? rule.principle.zh : rule.principle.en;
}

/** The bold labels are part of the published compact format in both supported languages. */
export function ruleLine(body: string, rule: BuiltInRule): string | undefined {
  const prefixes = Object.values(rule.principle).map(line => line.slice(0, line.indexOf("**", 4) + 2));
  return body.split(/\r?\n/u).find(line => prefixes.some(prefix => line === prefix || line.startsWith(prefix + " ")));
}

export function configuredPrinciples(state: Configuration, catalog: readonly BuiltInRule[] = BUILT_IN_RULES): { id: string; body: string }[] {
  if (state.settings.some(s => s.key === "agents.generation" && s.value === "none")) return [];
  const language = state.settings.find(s => s.key === "artifact.language")?.value ?? null;
  const navigation = state.settings.find(s => s.key === "agents.sharedNavigation")?.value !== "declined";
  const rules = new Map(state.configRecords.filter(record => record.collection === "rule").map(record => [record.key, record.value]));
  const enabled = catalog.flatMap(rule => {
    const record = rules.get(rule.id);
    if (record?.enabled !== true || typeof record.version !== "number" || record.version > rule.version) return [];
    const order = typeof record.order === "number" ? record.order : undefined;
    return [{ id: "rule:" + rule.id, body: principleLine(rule, language), order }];
  }).sort(compareRecordOrder);
  const entry = language === "zh-CN" ? "处理 Einzbern 相关任务时，加载 Mana Orchestrate 并遵循相应细则。" : NAVIGATION_LINES.join("\n");
  return [...(navigation ? [{ id: "navigation", body: entry }] : []), ...enabled];
}

export function blockBody(parts: readonly { id: string; body: string }[]): string {
  const navigation = parts.find(part => part.id === "navigation")?.body;
  const rules = parts.filter(part => part.id !== "navigation").map(part => part.body).join("\n");
  return [navigation, rules].filter(Boolean).join("\n\n");
}

// Keep the first legacy section's position and all free text. Adjacent migrated sections
// used at most two empty separator lines, depending on which engine wrote them.
function placeMigratedBlock(parsed: ParsedManagedFile, after: string, migrating: ReadonlySet<string>): string {
  const updated = new Map(parseManagedFile(after, FILE).sections.map(section => [section.id, section.raw]));
  const hasBlock = parsed.sections.some(s => s.id === PRINCIPLES_ID);
  let inserted = hasBlock;
  let output = "";
  for (const [index, old] of parsed.sections.entries()) {
    const outside = parsed.outside[index]!;
    const betweenMigrated = index > 0 && migrating.has(old.id) && migrating.has(parsed.sections[index - 1]!.id);
    if (!betweenMigrated || !/^(?:\r?\n){1,2}$/u.test(outside)) output += outside;
    if (!inserted && migrating.has(old.id)) {
      output += updated.get(PRINCIPLES_ID) ?? "";
      inserted = true;
    }
    output += updated.get(old.id) ?? "";
  }
  return output + parsed.outside[parsed.sections.length]!;
}

export interface PrinciplesPlan extends ManagedWritePlan {
  readonly desiredBody: string;
}

export async function planPrinciples(projectRoot: string, state: Configuration, options: {
  readonly catalog?: readonly BuiltInRule[];
  readonly disable?: { readonly id: string; readonly force: boolean };
} = {}): Promise<PrinciplesPlan> {
  const filePath = join(projectRoot, FILE);
  const records = managedSectionRecordsFor(state, FILE);
  const input = { file: FILE, filePath, records, restoreMissingFile: true };
  const probe = await planManagedWrite({ ...input, desired: [] });
  const before = probe.before;
  const parsed = parseManagedFile(before ?? "", FILE);
  const present = new Map(parsed.sections.map(section => [section.id, section]));
  const previous = new Map(records.map(record => [record.id, record]));
  const observed = new Map(probe.sections.map(decision => [decision.id, decision]));
  const catalog = options.catalog ?? BUILT_IN_RULES;
  const supported = new Set(["navigation", ...catalog.map(rule => "rule:" + rule.id)]);
  const declared = new Set(state.configRecords.filter(record => record.collection === "rule").map(record => "rule:" + record.key));
  for (const record of state.configRecords) {
    const rule = catalog.find(rule => rule.id === record.key);
    if (record.collection === "rule" && typeof record.value.version === "number" && rule && record.value.version > rule.version) supported.delete("rule:" + rule.id);
  }
  const group = present.get(PRINCIPLES_ID);
  const baseline = previous.get(PRINCIPLES_ID);
  const legacy = parsed.sections.filter(section => supported.has(section.id)
    && (section.id === "navigation" || declared.has(section.id)) && observed.get(section.id)?.record.state === "managed");
  const otherDeviceMigration = !group && baseline?.state === "managed" && legacy.length > 0;
  const canMigrate = group ? observed.get(PRINCIPLES_ID)?.record.state === "managed"
    : !baseline || otherDeviceMigration || (before === null && baseline.state === "managed");
  const migrating = new Set<string>();
  const adopted: ManagedSectionRecord[] = [];
  for (const section of canMigrate ? legacy : []) {
    const decision = observed.get(section.id)!;
    migrating.add(section.id);
    if (!previous.has(section.id)) adopted.push(decision.record);
  }
  const parts = configuredPrinciples(state, catalog).filter(part => {
    if (present.has(part.id)) return migrating.has(part.id);
    const old = previous.get(part.id);
    return !old || (before === null && old.state === "managed");
  });
  // Preserve lines from a newer engine whose enabled rule this catalog cannot render.
  const hasUnknownRule = state.configRecords.some(r => r.collection === "rule" && r.value.enabled === true && !catalog.some(rule => rule.id === r.key));
  for (const line of group?.body.split(/\r?\n/u) ?? []) {
    if (!line.startsWith("- **")) continue;
    const rule = catalog.find(rule => ruleLine(line, rule));
    if ((rule && !supported.has("rule:" + rule.id)) || (!rule && hasUnknownRule && canMigrate)) parts.push({ id: "future-rule", body: line });
  }
  const desiredBody = blockBody(parts);
  const retiringBlock = !desiredBody && !!group && canMigrate;
  if (retiringBlock && !baseline) adopted.push(observed.get(PRINCIPLES_ID)!.record);
  const retired = [...RETIRED_VARIABLE_SECTION_IDS, ...migrating, ...(retiringBlock ? [PRINCIPLES_ID] : [])];
  let plan = planManagedText({ ...input, records: [...records, ...adopted], retired,
    ...(otherDeviceMigration ? { restoreMissingSections: [PRINCIPLES_ID] } : {}),
    desired: desiredBody ? [{ id: PRINCIPLES_ID, body: desiredBody }] : [] }, before);
  const disabledId = options.disable?.id;
  const legacyId = "rule:" + disabledId;
  // Force applies to the selected legacy section, or just the selected line of a changed block.
  if (disabledId && options.disable?.force && !migrating.has(legacyId) && present.has(legacyId)) {
    const legacy = present.get(legacyId)!;
    const current = plan.after ?? before!;
    plan = { ...plan, write: true, after: current.replace(legacy.raw, () => ""),
      sections: plan.sections.map(d => d.id === legacyId ? { ...d, result: "removed", recordChanged: previous.has(d.id), forgetRecord: true } : d),
      pending: plan.pending.filter(id => id !== legacyId) };
  }
  if (disabledId && options.disable?.force && group && !canMigrate) {
    const rule = catalog.find(rule => rule.id === disabledId);
    const line = rule && ruleLine(group.body, rule);
    if (line) {
      const rest = group.body.split(/(?<=\n)/u).filter(raw => raw.replace(/\r?\n$/u, "") !== line).join("");
      const current = plan.after ?? before!;
      const clean = sectionDigest(rest) === sectionDigest(desiredBody) && baseline?.state !== "user-owned" && baseline?.state !== "unmanaged";
      const replacement = clean && !desiredBody ? "" : clean ? renderSection({ id: PRINCIPLES_ID, rev: group.rev + 1, body: rest }, parsed.eol)
        : group.raw.slice(0, group.raw.indexOf("\n") + 1) + rest + group.raw.slice(group.raw.indexOf("\n") + 1 + group.body.length);
      const after = current.replace(group.raw, () => replacement);
      plan = { ...plan, after, write: after !== before,
        ...(clean ? { sections: plan.sections.map(d => d.id === PRINCIPLES_ID ? { ...d, result: "replace", recordChanged: true,
          record: { ...d.record, state: "managed", rev: group.rev + 1, digest: sectionDigest(rest) },
          ...(desiredBody ? {} : { result: "removed", forgetRecord: true, recordChanged: !!baseline }) } : d),
          pending: plan.pending.filter(id => id !== PRINCIPLES_ID) } : {}) };
    }
  }
  const forget = new Set([...migrating, ...(retiringBlock ? [PRINCIPLES_ID] : [])]);
  // Restoring a whole file also replaces its former per-rule baselines.
  if (before === null && canMigrate) {
    for (const record of records) if (supported.has(record.id) && record.state === "managed") forget.add(record.id);
  }
  const sections = plan.sections.map(d => forget.has(d.id) && d.result === "removed" ? { ...d, forgetRecord: true, recordChanged: previous.has(d.id) } : d);
  let after = migrating.size && plan.after !== null ? placeMigratedBlock(parsed, plan.after, migrating) : plan.after;
  if (!desiredBody && group && after !== null && parsed.sections.length === 1 && !parseManagedFile(after, FILE).sections.length) {
    after = replaceSection(parsed, 0, "");
  }
  return { ...plan, sections, after, desiredBody };
}
