// SPDX-License-Identifier: Apache-2.0
import type { KnowledgeUnitMetadata } from "./knowledge-core.js";
import { recallTextTokens } from "./recall.js";
import { intrinsicScopesIntersect, resolveIntrinsicKnowledgeScope } from "./knowledge-scope.js";

type ClaimText = Pick<KnowledgeUnitMetadata, "subject" | "summary" | "snippet" | "tags">;
type ScopedClaim = ClaimText & Pick<KnowledgeUnitMetadata, "scope" | "projectId">;
const topicCache = new WeakMap<ClaimText, ReadonlySet<string>>();

export interface KnowledgePairAssessment {
  readonly relation: "unrelated" | "related" | "conflicting";
  readonly reason: "disjoint-scope" | "no-shared-topic" | "compatible-topic" | "opposite-assertions" | "exclusive-values";
  readonly sharedTokens: readonly string[];
  readonly evidence: readonly string[];
}

/** Exact token membership on both sides, using Recall's bilingual tokenizer. */
export function knowledgeTopicTokens(text: ClaimText): ReadonlySet<string> {
  let tokens = topicCache.get(text);
  if (tokens === undefined) {
    tokens = recallTextTokens([text.subject, text.summary, text.snippet, ...text.tags].join("\n"));
    topicCache.set(text, tokens);
  }
  return tokens;
}

interface Assertion {
  readonly family: string;
  readonly positive: boolean;
  readonly target: ReadonlySet<string>;
  readonly text: string;
}
const assertionCache = new WeakMap<ClaimText, readonly Assertion[]>();

const NEGATIVE = /\b(?:(?:must|shall|should|may|can|do|does|will|is|are)\s+not|not|never|cannot|can't|don't|doesn't|forbid(?:den)?|prohibit(?:ed)?|disallow(?:ed)?|avoid)\b|禁止|不得|不允许|不准|切勿|不可|不能|不应|无需|无须|不要|严禁|不是|并非|不(?=启用|开启|打开|禁用|关闭|保留|保存|删除|丢弃|移除|使用|接受|拒绝)/gu;
const MODAL = /\b(?:must|shall|should|always|required?|allow(?:ed)?|permit(?:ted)?|only)\b|必须|需要|应当|应该|允许|准许|务必|只能|仅可/gu;
const OPPOSITES: readonly { readonly family: string; readonly positive: RegExp; readonly negative: RegExp }[] = [
  { family: "enabled", positive: /\b(?:enable[ds]?|enabled|activate[ds]?)\b|启用|开启|打开/gu, negative: /\b(?:disable[ds]?|deactivate[ds]?)\b|禁用|关闭/gu },
  { family: "retained", positive: /\b(?:keep|retain(?:ed)?|preserve[ds]?)\b|保留|保存/gu, negative: /\b(?:delete[ds]?|remove[ds]?|discard(?:ed)?)\b|删除|丢弃|移除/gu },
  { family: "synchronous", positive: /\bsynchronous(?:ly)?\b|同步/gu, negative: /\basynchronous(?:ly)?\b|异步/gu },
  { family: "accepted", positive: /\baccept(?:ed)?\b|接受/gu, negative: /\breject(?:ed)?\b|拒绝/gu },
];

// Syntactic support words are not an assertion's object. In particular, 同步缓存 and 缓存…异步模式
// describe the same cache, despite word order and the optional word 模式.
function targetTokens(text: string): ReadonlySet<string> {
  return recallTextTokens(text.replace(/\b(?:use|using|be|is|are|mode|must|shall|should)\b|使用|采用|模式|方式/gu, " "));
}

function sameTarget(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size > 0 && left.size === right.size && [...left].every((token) => right.has(token));
}

// Explicit single-choice constraints can describe one object as a survey, census or count.
// Keep that established write-guard candidate tolerance only for nominal "only use" choices;
// quantitative properties and polarity targets require exact normalized objects. Distinct
// numbered objects never collapse merely because their other words match.
function sameNominalKey(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  const numbers = (tokens: ReadonlySet<string>): string => [...tokens].filter((token) => /\d/u.test(token)).sort().join("\u0000");
  if (numbers(left) !== numbers(right)) return false;
  const shared = [...left].filter((token) => right.has(token)).length;
  return shared > 0 && shared / Math.max(left.size, right.size) >= 0.75;
}

function has(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function assertions(card: ClaimText): readonly Assertion[] {
  const cached = assertionCache.get(card);
  if (cached !== undefined) return cached;
  const result: Assertion[] = [];
  const clauses = new Set([card.subject, card.summary, card.snippet].flatMap((text) =>
    text.normalize("NFKC").toLowerCase().split(/[\n;；。!?！？,，]|\.(?:\s|$)|\b(?:and|but|while)\b|并且|而且|同时|并(?=记录|启用|禁用|开启|关闭)|但/u).map((clause) => clause.trim()).filter(Boolean)));
  for (const text of clauses) {
    const negated = has(NEGATIVE, text);
    const plain = text.replace(NEGATIVE, " ").replace(MODAL, " ");
    let action = false;
    for (const group of OPPOSITES) {
      const positive = has(group.positive, plain);
      const negative = has(group.negative, plain);
      if (positive === negative) continue;
      action = true;
      const target = targetTokens(plain.replace(group.positive, " ").replace(group.negative, " "));
      if (target.size > 0) result.push({ family: group.family, positive: positive !== negated, target, text });
    }
    if (!action) {
      // A mentioned noun or a detached "not X" fragment is not an opposite assertion. The
      // title "catalog revision, not graph revision" and a paragraph mentioning "graph revision"
      // can agree. Require a directive or an explicit predicate for generic negation matching.
      const predicate = has(MODAL, text) || /\b(?:is|are|was|were|has|have|does)\b/u.test(plain) ||
        /^(?:(?:please|to)\s+)?(?:use|deploy|publish|write|read|overwrite|log|encrypt|run|install|execute|store|cache|send|retry|enter|walk)\b|^(?:使用|执行|运行|写入|读取|覆盖|记录|安装|部署|发布|发送|重试)/u.test(plain.trim());
      if (!predicate) continue;
      const target = targetTokens(plain);
      if (target.size > 0) result.push({ family: "asserted", positive: !negated, target, text });
    }
  }
  assertionCache.set(card, result);
  return result;
}

interface QuantityConstraint {
  readonly dimension: string;
  readonly lower: number;
  readonly upper: number;
  readonly lowerClosed: boolean;
  readonly upperClosed: boolean;
}

// Compare the denoted sets, not the presence of different digit tokens. 60 seconds and 1 minute
// are equal; an exact age of 60 seconds also satisfies an upper bound of 120 seconds.
function quantityConstraint(text: string): QuantityConstraint | null {
  const match = /^(?:(at most|at least|no more than|no less than|less than|greater than|exactly|<=|>=|<|>|=|不超过|不少于|最多|至少|小于|大于|等于)\s*)?(-?\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|hours?|days?|毫秒|秒|分钟|小时|天|bytes?|kb|mb|gb|字节|%)?$/u.exec(text.trim());
  if (match === null) return null;
  const unit = match[3] ?? "";
  const groups: readonly [RegExp, string, number][] = [
    [/^(?:milliseconds?|ms|毫秒)$/u, "time", 0.001], [/^(?:seconds?|secs?|s|秒)$/u, "time", 1],
    [/^(?:minutes?|mins?|分钟)$/u, "time", 60], [/^(?:hours?|小时)$/u, "time", 3600], [/^(?:days?|天)$/u, "time", 86400],
    [/^(?:bytes?|字节)$/u, "bytes", 1], [/^kb$/u, "bytes", 1000], [/^mb$/u, "bytes", 1_000_000], [/^gb$/u, "bytes", 1_000_000_000],
  ];
  const group = groups.find(([pattern]) => pattern.test(unit));
  const dimension = group?.[1] ?? (unit === "%" ? "percent" : "scalar");
  const value = Number(match[2]) * (group?.[2] ?? 1);
  if (!Number.isFinite(value)) return null;
  const bound = match[1] ?? "=";
  const lower = /^(?:at least|no less than|greater than|>=|>|不少于|至少|大于)$/u.test(bound);
  const upper = /^(?:at most|no more than|less than|<=|<|不超过|最多|小于)$/u.test(bound);
  return { dimension, lower: upper ? -Infinity : value, upper: lower ? Infinity : value,
    lowerClosed: !/^(?:greater than|>|大于)$/u.test(bound), upperClosed: !/^(?:less than|<|小于)$/u.test(bound) };
}

function quantitiesDisjoint(left: QuantityConstraint, right: QuantityConstraint): boolean {
  if (left.dimension !== right.dimension) return false;
  return left.upper < right.lower || right.upper < left.lower ||
    (left.upper === right.lower && !(left.upperClosed && right.lowerClosed)) ||
    (right.upper === left.lower && !(right.upperClosed && left.lowerClosed));
}

interface ExclusiveValue {
  readonly key: ReadonlySet<string>;
  readonly value: ReadonlySet<string>;
  readonly quantity: QuantityConstraint | null;
  readonly only: boolean;
  readonly text: string;
}
const exclusiveCache = new WeakMap<ClaimText, readonly ExclusiveValue[]>();

function exclusiveValues(card: ClaimText): readonly ExclusiveValue[] {
  const cached = exclusiveCache.get(card);
  if (cached !== undefined) return cached;
  const values = [];
  for (const text of [card.subject, card.summary, card.snippet]) {
    for (const clause of text.normalize("NFKC").toLowerCase().split(/[\n;；。!?！？]/u)) {
      const match = /^(.*?)\s*(\bmust use only\b|\bmust (?:use|be|equal)\b|\b(?:use only|only use)\b|必须使用|只能使用|仅使用|必须为|固定为)\s*(.+)$/u.exec(clause);
      if (match === null || has(NEGATIVE, clause)) continue;
      const key = targetTokens(match[1]!.trim() || card.subject);
      // "store version" and "chain version" name distinct exclusive values even though both
      // carry the type word version. Preserve concrete shared qualifiers such as Redis/TLS.
      const value = recallTextTokens(match[3]!.replace(/\b(?:version|revision|counter|mode|value)\b|版本|模式|计数器|数值/gu, " "));
      const quantity = quantityConstraint(match[3]!);
      const only = /only|只能|仅使用|固定为/u.test(match[2]!);
      if (key.size > 0 && (value.size > 0 || quantity !== null)) values.push({ key, value, quantity, only, text: clause });
    }
  }
  exclusiveCache.set(card, values);
  return values;
}

export function assessKnowledgePair(left: ScopedClaim, right: ScopedClaim): KnowledgePairAssessment {
  if (!intrinsicScopesIntersect(resolveIntrinsicKnowledgeScope(left), resolveIntrinsicKnowledgeScope(right))) {
    return { relation: "unrelated", reason: "disjoint-scope", sharedTokens: [], evidence: [] };
  }
  const rightTokens = knowledgeTopicTokens(right);
  const sharedTokens = [...knowledgeTopicTokens(left)].filter((token) => rightTokens.has(token)).sort();
  if (sharedTokens.length === 0) return { relation: "unrelated", reason: "no-shared-topic", sharedTokens, evidence: [] };
  for (const a of assertions(left)) for (const b of assertions(right)) {
    if (a.family === b.family && a.positive !== b.positive && sameTarget(a.target, b.target)) {
      return { relation: "conflicting", reason: "opposite-assertions", sharedTokens, evidence: [a.text, b.text] };
    }
  }
  for (const a of exclusiveValues(left)) for (const b of exclusiveValues(right)) {
    const quantities = a.quantity !== null && b.quantity !== null;
    const disjoint = quantities
      ? quantitiesDisjoint(a.quantity!, b.quantity!)
      : a.only && b.only && ![...a.value].some((token) => b.value.has(token));
    const sameKey = quantities ? sameTarget(a.key, b.key) : sameNominalKey(a.key, b.key);
    if (sameKey && disjoint) {
      return { relation: "conflicting", reason: "exclusive-values", sharedTokens, evidence: [a.text, b.text] };
    }
  }
  return { relation: "related", reason: "compatible-topic", sharedTokens, evidence: [] };
}
