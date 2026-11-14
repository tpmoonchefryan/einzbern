import { observeRecall } from "./recall-observation.js";
import { fileContentDigest } from "./local-file-identity.js";
import type { InvolvedProjects } from "../../protocol/src/index.js";
import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-362 — the FTS5 recall core.
//
// WHAT THIS REPLACES. Retrieval on this platform was substring matching over card
// metadata, with a query tokenizer that kept a contiguous CJK run whole. A prompt
// written in Chinese therefore produced one enormous token that matched nothing, and
// two real prompts measured on 2026-09-04 returned zero cards; the same prompts in
// English returned every card carrying the tag someone happened to type. Neither
// answer is retrieval: one is silence and the other is the whole library.
//
// WHAT IT IS. One in-memory SQLite FTS5 index over the three record families a session
// can be reminded of — knowledge cards, conference minutes, work records — ranked by
// bm25 with per-field weights, with contiguous CJK segmented into overlapping bigrams
// on BOTH the index side and the query side. Bigrams are what make a Chinese prompt
// searchable at all without a dictionary: a four-character phrase indexes as its three
// overlapping pairs, and a differently worded question that shares one pair finds it.
//
// WHY node:sqlite AND NOTHING ELSE. This repository declares zero runtime dependencies
// and verify:p1's offline leg refuses any module that reaches the network. node:sqlite
// is a Node built-in on the pinned 24.16.0 runtime, its bundled SQLite is 3.53.0, and
// FTS5 and bm25 are compiled into it. Nothing is downloaded, nothing is built natively,
// and the offline boundary does not move.
//
// The index is disposable derived data. CLI/Hook persist its verified projection
// on this device; pure in-process users can still use an in-memory index. Both are
// rebuilt from the current chain and knowledge corpus without losing a fact.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { serialize, deserialize } from "node:v8";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { constants, rmSync, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cachePath } from "./device-home.js";
import { openLibrary } from "./ether-library.js";
import { readProtectedProjection, writeProtectedProjection } from "./protected-projection.js";
import { observeAuthorityWork, observeCacheRead, observeCacheReason } from "./recall-observation.js";
import { writeFileAtomic } from "./atomic-file.js";

import type { ObsoleteDecisionHint } from "./minutes.js";

export type RecallKind = "card" | "minutes" | "work";

/**
 * TCRN-CROSS-STORY-476 R5: which store a card came from -- the library's crest ("project") or the
 * user's crest ("user"), which every project recalls from. A card input that does not say is left
 * unlabelled here; recall-inputs.ts labels what it reads.
 */
export type RecallScope = "project" | "user";

/** One indexed record, reduced to the four ranked fields plus what a caller reads back. */
export interface RecallDocument {
  readonly involvedProjects?: InvolvedProjects;
  readonly id: string;
  readonly kind: RecallKind;
  readonly key: string;
  readonly status: string;
  readonly title: string;
  readonly body: string;
  readonly tags: string;
  readonly expansions: string;
  readonly summary: string;
  // TCRN-CROSS-STORY-474 R2: what a hit line shows beside the ranked fields, never ranked itself:
  // the record's own kind (Story, Epic, minutes, card), the titles above it (the Epic, then the
  // Initiative), and a lead (a minutes record's first decision).
  readonly recordKind: string;
  readonly parentChain: readonly string[];
  readonly lead: string;
  readonly decisions?: readonly RecallDecision[];
  readonly currentContract?: boolean;
  // A card's store (TCRN-CROSS-STORY-476 R5), shown beside the hit and never ranked.
  readonly scope?: RecallScope;
}

/**
 * TCRN-CROSS-SUB-426 R17 续作修订三 (STORY-514 AC1): a removed card's removal, as knowledge-list
 * answers it for the card: why (`reason`), on what basis, by whom and when, the card that superseded
 * it (null unless it was superseded), and the device, sequence and hash of the event that holds it --
 * all three null for a removal a supersession derives.
 */
export interface RecallCardRemoval {
  readonly reason: string;
  readonly basis: string;
  readonly actor: string | null;
  readonly removedAt: string;
  readonly supersededBy: string | null;
  readonly deviceId: string | null;
  readonly sequence: number | null;
  readonly eventHash: string | null;
}

export interface RecallHit {
  readonly involvedProjects?: InvolvedProjects;
  readonly kind: RecallKind;
  readonly key: string;
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly summary: string;
  readonly score: number;
  readonly recordKind: string;
  readonly parentChain: readonly string[];
  readonly lead: string;
  readonly decision?: RecallDecision;
  readonly historical?: boolean;
  readonly scope?: RecallScope;
  // TCRN-CROSS-SUB-426 (MIN-239 D5): the obsolete decisions the hit's record points at -- a work
  // record's decided-by minutes, a card's linked minutes and the decisions it names, and a minutes
  // record's own when the recall was asked for obsolete decisions (R17 续作修订二) -- each with the
  // decision that superseded it, null when it was withdrawn. Set after selection (recall-inputs.ts),
  // never by the index.
  readonly obsoleteDecisions?: readonly ObsoleteDecisionHint[];
  // TCRN-CROSS-SUB-426 R17 续作修订三 (STORY-514 AC1): a hit on a removed card, which only a recall
  // asked for removed cards has, carries the card's removal. Set after selection, never by the index.
  readonly removal?: RecallCardRemoval;
}

/** A clause keeps its number, validity and expandable source through ranking and delivery. */
export interface RecallDecision {
  readonly number: number;
  readonly text: string;
  readonly reference: string;
  readonly scope: string;
  readonly status: "valid" | "obsolete";
  readonly excerpt?: string;
  readonly matchedText?: string;
  readonly supersededBy?: string | null;
}

export interface RecallSelectionOptions {
  // The absolute floor in bm25, the unit of the ranked scores (selectRecallHits); not retrieval.tau.
  readonly tau?: number;
  readonly relativeFloor?: number;
  readonly limit?: number;
  readonly quota?: Readonly<Record<RecallKind, number>> | null;
}

/**
 * The measured field weights. Subject/title carries the strongest signal, an author's
 * own restatements of the question (expansions) the next, the closed tag vocabulary
 * next, and the prose body least because it is the longest and the least deliberate.
 * The numbers are the ones the 2026-09-04 retrieval evaluation settled on.
 */
export const RECALL_FIELD_WEIGHTS = { title: 8, body: 3, tags: 5, expansions: 6, externalKey: 1 } as const;

/**
 * TCRN-CROSS-STORY-474 R3, MIN-235 D9 (TCRN-CROSS-SUB-302): the unit the strong-hit threshold is
 * counted in -- the bm25 weight of a word exactly one of the index's `indexed` records carries,
 * ln((N - 0.5) / 1.5), with the floor FTS5 puts under a non-positive inverse document frequency
 * (1e-6), so in a library of one or two records a threshold scales exactly as its scores do. bm25
 * grows with the logarithm of a library's size, so one bm25 number means one thing in four records
 * and another in six hundred: measured on 2026-09-28, the goal words of a Story in a four-record
 * library scored 3.65 while an unrelated prompt reached 16.98 on the recorded cross-project corpus,
 * and no fixed number sat between the two. In this unit they are 4.31 and 2.83.
 */
export function recallScoreUnit(indexed: number): number {
  const weight = Math.log((indexed - 0.5) / 1.5);
  return weight > 0 ? weight : 1e-6;
}

/** The bm25 floor a strong-hit threshold `tau` becomes in an index of `indexed` records. */
export function recallStrongHitFloor(tau: number, indexed: number): number {
  return tau * recallScoreUnit(indexed);
}

/**
 * TCRN-CROSS-STORY-474 R3 (MIN-227 D7), MIN-235 D9: the strong-hit threshold and the default of the
 * `retrieval.tau` setting, in recallScoreUnit units -- a strong hit is worth at least three words
 * that only one record carries. When the best hit of a prompt scores below it the prompt is about
 * nothing the library holds, and recall answers with nothing at all (RECALL_NO_STRONG_HIT) rather
 * than its best weak guesses -- a prompt that has no business in the library must not be handed a
 * reminder. Above it, the threshold is still the absolute floor of every hit. A term carried by
 * most of the corpus scores near zero by construction (FTS5 clamps a non-positive inverse document
 * frequency), which is what turns "every card is tagged lesson" into no answer.
 * The value is calibrated by retrieval-eval and held in tests/fixtures/retrieval-eval/
 * strong-threshold.json (TCRN-CROSS-SUB-303): the smallest whole number above the best score any
 * unrelated prompt reaches -- 2.83 on the recorded cross-project corpus (16.98 in bm25 over its
 * 600 records, a two-word coincidence with a record written in English) and 0 in the four-record
 * library -- and no higher than the lowest score a query of the four-record library's related
 * group reaches (3.52, the other Story's goal words). Because the unit moves with the library,
 * the one default holds at both sizes; the setting stays a whole number, as it always was.
 */
export const RECALL_STRONG_TAU = 3;

/** The name the absolute floor had before it became the strong-hit threshold; the same value. */
export const RECALL_DEFAULT_TAU = RECALL_STRONG_TAU;

/**
 * The relative floor, as a fraction of the best bm25 score in the same answer. The
 * absolute floor alone cannot tell a query with one strong match and a long tail from
 * a query where everything matched equally; this one drops the tail. 0.25 is the
 * largest value that leaves the mixed-index criterion at its measured 20 of 36 — 0.30
 * costs two of them, and the 0.40 the exploratory script used costs three.
 */
export const RECALL_RELATIVE_FLOOR = 0.25;

/**
 * Per-kind caps, so one loud family cannot fill the answer. A session asking about a
 * defect wants the card, the minutes that decided it and the record that carries it,
 * not eight work records.
 */
export const RECALL_KIND_QUOTA: Readonly<Record<RecallKind, number>> = { card: RUNTIME_CAPACITY.arrayEntries, minutes: RUNTIME_CAPACITY.arrayEntries, work: RUNTIME_CAPACITY.arrayEntries };

export const RECALL_DEFAULT_LIMIT = 8;

/** How deep the ranked list goes before selection, so the quota has something to choose from. */
const RECALL_CANDIDATE_LIMIT = RUNTIME_CAPACITY.arrayEntries;

/**
 * The score an exact external-key match carries. It is not a bm25 number and is not
 * meant to be comparable with one: naming a record by its key is not a guess about
 * relevance, so the hit is placed first and kept out of the relative floor's basis.
 */
export const RECALL_EXTERNAL_KEY_SCORE = 99;

const CJK_RUN = /[㐀-鿿豈-﫿]+/gu;
const ASCII_TOKEN = /[a-z0-9][a-z0-9_.-]+/gu;
const EXTERNAL_KEY_CANDIDATE = /[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+/gu;
const RECORD_REFERENCE_CANDIDATE = new RegExp(`([a-z][a-z0-9-]+:[a-z0-9][a-z0-9._-]*|${EXTERNAL_KEY_CANDIDATE.source})(?:#D([1-9][0-9]*)\\b)?`, "giu");


/**
 * Bigrams that carry no topic. They are the connective tissue of a spoken question,
 * and every one of them appears in a large fraction of the corpus, so leaving them in
 * costs a query slot and buys nothing.
 */
const STOP_BIGRAMS: ReadonlySet<string> = new Set([
  "应该", "怎么", "需要", "可以", "没有",
  "什么", "这个", "那个", "一个", "如果",
  "然后", "现在", "已经", "还是", "还有",
  "就是", "不是", "但是", "因为", "所以",
  "或者", "以及", "对于", "关于", "这样",
  "那样", "这些", "那些", "我们", "你们",
  "他们", "它们", "帮我", "一下", "是否",
  "怎样", "如何", "请你", "你的", "我的",
  "的话", "而且", "并且", "以后", "之后",
  "之前", "这里", "那里", "一起", "一样",
  "同时", "另外", "其实", "其他", "这次",
  "上次", "下次", "这种", "情况", "为啥",
]);

/**
 * TCRN-CROSS-SUB-303 (the strong-hit calibration): the English counterpart of the stop bigrams.
 * In a library written mostly in Chinese, "the", "is" or "what" are rare, so each carries a high
 * inverse document frequency; measured on the recorded cross-project corpus, "what is in it"
 * scored 25.9 on the few records written in English and "what is the weather like in Paris today"
 * 30.1 -- a strong hit made of nothing but grammar. They leave the query, and a one-word query part
 * that is one of them (or a single character, the "I" of TCRN-CROSS-SUB-302's finding) no longer
 * asks the external-key column for a prefix.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "about", "am", "an", "and", "are", "as", "at", "be", "been",
  "being", "but", "by", "can", "could", "did", "do", "does", "for", "from",
  "get", "got", "had", "has", "have", "he", "her", "here", "him", "his",
  "how", "i", "if", "in", "into", "is", "it", "its", "just", "let",
  "like", "may", "me", "might", "must", "my", "no", "nor", "not", "of",
  "off", "on", "onto", "or", "our", "ours", "out", "over", "please", "shall",
  "she", "should", "so", "than", "that", "the", "their", "them", "then", "there",
  "these", "they", "this", "those", "to", "too", "up", "us", "very", "was",
  "we", "were", "what", "when", "where", "which", "while", "who", "whom", "whose",
  "why", "will", "with", "would", "you", "your", "yours",
]);

function bigrams(run: string): readonly string[] {
  const out: string[] = [];
  for (let index = 0; index < run.length - 1; index += 1) out.push(run.slice(index, index + 2));
  return out;
}

/**
 * Index-side segmentation: every contiguous CJK run becomes its overlapping bigrams,
 * space separated, and everything else is left exactly as it was. A one-character run
 * has no bigram and is kept whole rather than dropped.
 */
export function segmentForIndex(text: string): string {
  return String(text ?? "")
    .replace(/[A-Za-z][A-Za-z0-9_.-]*/gu, (identifier) => {
      const parts = externalKeyTokens(identifier);
      return parts.length > 1 ? `${identifier} ${parts.join(" ")}` : identifier;
    })
    .replace(CJK_RUN, (run) => bigrams(run).join(" ") || run);
}

function segmentProse(text: string): string {
  return text.replace(CJK_RUN, (run) => bigrams(run).join(" ") || run);
}

/**
 * Every query-side token of a text, in the order it is first read and without the query's cap:
 * lowercased ASCII words and CJK bigrams, stop words and stop bigrams removed. TCRN-CROSS-SUB-426
 * (MIN-239 D5): the topic comparison of decisions (minutes.ts) and the duplicate check of a card
 * write (knowledge-duplicates.ts) read a text this way, so the words they call shared are the ones
 * recall calls shared.
 */
export function recallTextTokens(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const match of String(text ?? "").toLowerCase().matchAll(ASCII_TOKEN)) {
    const token = match[0].replace(/[.-]+$/u, "");
    if (!STOP_WORDS.has(token)) tokens.add(token);
  }
  for (const run of String(text ?? "").match(CJK_RUN) ?? []) {
    for (const gram of bigrams(run)) if (!STOP_BIGRAMS.has(gram)) tokens.add(gram);
  }
  return new Set([...tokens].filter((token) => token.length >= 2));
}

/** Query-side tokens: lowercased ASCII words and CJK bigrams, stop words and stop bigrams removed. */
export function recallQueryTokens(text: string): readonly string[] {
  return [...new Set([
    ...recallTextTokens(text),
    ...[...String(text).matchAll(/[A-Za-z][A-Za-z0-9_.-]*/gu)]
      .flatMap((match) => externalKeyTokens(match[0]))
      .filter((part) => part.length >= 2 && !STOP_WORDS.has(part)),
  ])];
}

export function recallQueryIsHistorical(query: string): boolean {
  // A negated instruction can mention history without asking a historical question.
  const intent = query.replace(/(?:请勿|不要|不得)[^，,。！？!?；;\n]*/gu, "");
  return /^\s*历史(?:\s|上|问题)|历史原因|当初|曾经|旧版|退役原因|\bhistor(?:y|ical)\b|\bpreviously\b|\bused to\b/iu.test(intent);
}

/**
 * External keys spelled in the prompt. Deliberately not a pattern for this platform's
 * own key shape: the roster of prefixes is a chain fact, so the test is "does the
 * corpus hold a record with exactly this key", which stays correct when the roster
 * grows. TCRN-CROSS-MIN-ACCEPTANCE-LANES is a live key, and a pattern demanding a
 * numeric suffix would not have found it.
 */
export function externalKeyCandidates(text: string): readonly string[] {
  return [...new Set([...String(text ?? "").matchAll(EXTERNAL_KEY_CANDIDATE)].map((match) => match[0].toUpperCase()))];
}

function externalKeyTokens(text: string): readonly string[] {
  return [...new Set(text
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/gu) ?? [])];
}

function externalKeyExpression(query: string): string {
  return (query.match(/[A-Za-z0-9][A-Za-z0-9-]*/gu) ?? [])

    .map((part) => externalKeyTokens(part))
    // A lone word asks for a key prefix only when it could be one: not a stop word, not one letter.
    .filter((tokens) => tokens.length > 1 || (tokens.length === 1 && tokens[0]!.length > 1 && !STOP_WORDS.has(tokens[0]!)))
    .map((tokens) => `(${tokens.map((token) => `"${token}"*`).join(" AND ")})`)
    .join(" OR ");
}

/**
 * A key as the ordered run of its tokens, repeats kept, for matching a fragment inside it. Case is
 * folded before splitting on both sides, because a prompt's candidate arrives upper-cased
 * (externalKeyCandidates) and a case boundary it no longer has cannot be matched.
 */
function keyTokenRun(text: string): readonly string[] {
  return text.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
}

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return true;
  }
  return false;
}

// The display fields are in the digest too: they are not ranked, but a hit must not show a status,
// a parent title or a lead the record no longer has.
function documentDigest(document: RecallDocument): string {
  return createHash("sha256")
    .update(`${document.key}\u0000${document.title}\u0000${document.body}\u0000${document.tags}\u0000${document.expansions}`
      + `\u0000${document.status}\u0000${document.summary}\u0000${document.recordKind}\u0000${document.parentChain.join("\u0001")}\u0000${document.lead}`
      + `\u0000${document.scope ?? ""}\u0000${JSON.stringify(document.involvedProjects ?? null)}`, "utf8")
    .update(JSON.stringify([document.decisions ?? null, document.currentContract ?? false]))
    .digest("hex");
}

function matchExpression(tokens: readonly string[]): string {
  return tokens.map((token) => `"${token.replace(/"/gu, "")}"`).join(" OR ");
}

interface IndexedRow {
  readonly rowId: number;
  readonly digest: string;
  readonly document: RecallDocument;
  readonly lexicon: DocumentLexicon;
  readonly deliveryDocument?: RecallDocument;
  readonly scoring?: Pick<DocumentLexicon, "words" | "identifiers" | "coverage" | "anchor">;
}

interface ClauseLexicon {
  readonly words: Uint32Array;
  readonly passages: readonly { readonly text: string; readonly words: Uint32Array }[];
}
interface DocumentLexicon {
  readonly words: Uint32Array;
  readonly identifiers: Uint32Array;
  readonly coverage: Uint32Array;
  readonly anchor: Uint32Array;
  readonly clauses: readonly ClauseLexicon[];
}

function wordIds(words: Iterable<string>, vocabulary: Map<string, number>): Uint32Array {
  return new Uint32Array([...new Set(Array.from(words, word => {
    let id = vocabulary.get(word);
    if (id === undefined) { id = vocabulary.size + 1; vocabulary.set(word, id); }
    return id;
  }))].sort((a, b) => a - b));
}

function hasWord(words: Uint32Array, id: number | undefined): boolean {
  if (id === undefined) return false;
  let low = 0, high = words.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (words[middle]! < id) low = middle + 1;
    else high = middle;
  }
  return words[low] === id;
}

function documentLexicon(document: RecallDocument, vocabulary: Map<string, number>): DocumentLexicon {
  return {
    words: wordIds(recallQueryTokens(`${document.title} ${document.body} ${document.expansions}`), vocabulary),
    identifiers: wordIds(recallTextTokens(document.decisions === undefined ? `${document.title} ${document.body} ${document.expansions}` : document.decisions.map(decision => decision.text).join(" ")), vocabulary),
    coverage: wordIds(recallQueryTokens(`${document.title} ${document.body} ${document.tags} ${document.expansions}`), vocabulary),
    anchor: wordIds(recallQueryTokens(`${document.title} ${document.summary} ${document.expansions}`), vocabulary),
    clauses: (document.decisions ?? []).map(clause => ({ words: wordIds(recallQueryTokens(clause.text), vocabulary),
      passages: clause.text.split(/(?<=[。；;!?])\s*|(?<=\.)\s+/u).filter(part => part.trim().length > 0)
        .map(text => ({ text, words: wordIds(recallQueryTokens(text), vocabulary) })) })),
  };
}

interface PackedRecallClauses {
  readonly docIds: readonly string[];
  // 6 uint32s per clause sorted by id: id, docIndex, wordsOffset, wordsLength, originalOffset, originalLength.
  readonly meta: Uint32Array;
  readonly words: Uint32Array;
}

interface PackedScoringLexicons {
  readonly docIds: readonly string[];
  // 8 uint32s per doc: wordsOffset, wordsLength, idOffset, idLength, covOffset, covLength, anchOffset, anchLength.
  readonly meta: Uint32Array;
  readonly words: Uint32Array;
}

interface RecallIndexState {
  readonly rows: Map<string, Pick<IndexedRow, "rowId" | "digest" | "document">>;
  readonly byExternalKey: Map<string, string>;
  readonly keyRuns: Map<string, readonly string[]>;
  readonly frequencies: Map<string, number>;
  readonly clauses: Map<number, { readonly documentId: string; readonly words: Uint32Array; readonly originalWords: Uint32Array }>;
  readonly packedClauses?: PackedRecallClauses;
  readonly packedScoring?: PackedScoringLexicons;
  readonly vocabulary: Map<string, number>;
  readonly clauseRows: Map<string, readonly number[]>;
  readonly clauseFrequencies: Map<string, number>;
  readonly nextRowId: number;
  readonly nextClauseId: number;
  readonly packedTerms?: PackedRecallTerms;
}

interface PackedRecallTerms {
  readonly text: Buffer;
  // Sorted UTF-8 terms: byte offset, length, token id, record frequency, clause frequency.
  readonly entries: Uint32Array;
}
interface RecallTerm { readonly id: number; readonly frequency: number; readonly clauseFrequency: number }
type WordLookup = Pick<ReadonlyMap<string, number>, "get">;

function findPackedTerm(terms: PackedRecallTerms, word: string): RecallTerm | null {
  const bytes = Buffer.from(word);
  let low = 0, high = terms.entries.length / 5;
  while (low < high) {
    const middle = (low + high) >>> 1, offset = middle * 5;
    const compared = Buffer.compare(terms.text.subarray(terms.entries[offset]!, terms.entries[offset]! + terms.entries[offset + 1]!), bytes);
    if (compared < 0) low = middle + 1;
    else if (compared > 0) high = middle;
    else return { id: terms.entries[offset + 2]!, frequency: terms.entries[offset + 3]!, clauseFrequency: terms.entries[offset + 4]! };
  }
  return null;
}

function hitMetadata(document: RecallDocument, score: number, query: string): RecallHit {
  return { kind: document.kind, key: document.key, id: document.id, status: document.status, title: document.title,
    summary: document.summary, score, recordKind: document.recordKind, parentChain: document.parentChain, lead: document.lead,
    ...(recallQueryIsHistorical(query) ? { historical: true } : {}),
    ...(document.scope === undefined ? {} : { scope: document.scope }),
    ...(document.involvedProjects === undefined ? {} : { involvedProjects: document.involvedProjects }) };
}

function hitOf(document: RecallDocument, lexicon: DocumentLexicon, vocabulary: WordLookup, score: number, query: string, frequencies: WordLookup, requested: number = 0): RecallHit {
  const tokens = recallQueryTokens(query);
  const clauses = document.decisions ?? [];
  const selected = clauses.map((clause, index) => {
    const words = lexicon.clauses[index]!.words;
    const matches = tokens.filter((token) => hasWord(words, vocabulary.get(token)));
    const weight = matches.reduce((sum, token) => sum + 1 / (frequencies.get(token) ?? 1), 0);
    return { clause, index, weight: requested === clause.number ? Number.POSITIVE_INFINITY : weight };
  }).sort((a, b) => b.weight - a.weight || a.index - b.index)[0]?.clause;
  const selectedIndex = clauses.findIndex(clause => clause === selected);
  const passageWords = lexicon.clauses[selectedIndex]?.passages ?? [];
  const passages = passageWords.map(passage => passage.text);
  const snippets = passages.length === 0 ? [] : [excerpt(passages[0]!, 240)];
  const covered = new Set(recallQueryTokens(snippets.join(" ")));
  const used = new Set([0]);
  let matchedText = snippets[0] ?? selected?.text ?? "";
  for (let count = 0; count < 2; count += 1) {
    const next = passages.map((text, index) => ({ text, index,
      weight: used.has(index) ? 0 : tokens.filter((token) => !covered.has(token) && hasWord(passageWords[index]!.words, vocabulary.get(token)))
        .reduce((sum, token) => sum + 1 / (frequencies.get(token) ?? 1), 0),
    })).sort((a, b) => b.weight - a.weight || a.index - b.index)[0];
    if (next === undefined || next.weight === 0) break;
    snippets.push(next.text);
    matchedText = next.text;
    used.add(next.index);
    for (const token of recallQueryTokens(next.text)) covered.add(token);
  }
  const decision = selected === undefined ? undefined : {
    ...selected,
    matchedText,
    excerpt: passages.length <= 1 ? selected.text : snippets.join(" … "),
  };
  return {
    ...hitMetadata(document, score, query),
    lead: requested > 0 && selected?.number !== requested ? "" : decision === undefined ? document.lead : `D${decision.number} ${decision.text}`,
    ...(decision === undefined || requested > 0 && selected?.number !== requested ? {} : { decision }),
  };
}

/**
 * The index itself. It is mutable on purpose: the checkpoint cache hands the same
 * instance to the next query, and a chain that has moved gets the rows that actually
 * changed rewritten rather than the whole table rebuilt.
 */
function packScoring(lexicon: Pick<DocumentLexicon, "words" | "identifiers" | "coverage" | "anchor">): Buffer {
  const { words, identifiers, coverage, anchor } = lexicon;
  const packed = new Uint32Array(3 + words.length + identifiers.length + coverage.length + anchor.length);
  packed[0] = words.length;
  packed[1] = identifiers.length;
  packed[2] = coverage.length;
  let offset = 3;
  packed.set(words, offset); offset += words.length;
  packed.set(identifiers, offset); offset += identifiers.length;
  packed.set(coverage, offset); offset += coverage.length;
  packed.set(anchor, offset);
  const raw = Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength);
  return raw.length > 64 ? deflateRawSync(raw) : raw;
}

function unpackScoring(bytes: Uint8Array, compressed: boolean): Pick<DocumentLexicon, "words" | "identifiers" | "coverage" | "anchor"> {
  const raw = compressed ? inflateRawSync(bytes) : bytes;
  const packed = new Uint32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const wLen = packed[0]!;
  const iLen = packed[1]!;
  const cLen = packed[2]!;
  let offset = 3;
  const words = packed.subarray(offset, offset + wLen); offset += wLen;
  const identifiers = packed.subarray(offset, offset + iLen); offset += iLen;
  const coverage = packed.subarray(offset, offset + cLen); offset += cLen;
  const anchor = packed.subarray(offset);
  return { words, identifiers, coverage, anchor };
}

export class RecallIndex {
  #database: DatabaseSync;
  #rows = new Map<string, IndexedRow>();
  #rowProjections = new Map<string, Pick<IndexedRow, "document" | "lexicon">>();
  #byExternalKey = new Map<string, string>();
  #keyRuns = new Map<string, readonly string[]>();
  #frequencies = new Map<string, number>();
  #clauses = new Map<number, { readonly document: RecallDocument; readonly words: Uint32Array; readonly originalWords: Uint32Array }>();
  #restoredClauses: Map<number, { readonly documentId: string; readonly words: Uint32Array; readonly originalWords: Uint32Array }> | undefined;
  #packedClauses: PackedRecallClauses | undefined;
  #packedScoring: PackedScoringLexicons | undefined;
  #scoringIndex: Map<string, number> | undefined;
  #vocabulary = new Map<string, number>();
  #clauseRows = new Map<string, readonly number[]>();
  #clauseFrequencies = new Map<string, number>();
  #nextRowId = 1;
  #nextClauseId = 1;
  #checkpoint: string;
  #cleanup: (() => void) | undefined;
  #requested = new WeakMap<RecallHit, number>();
  #packedTerms: PackedRecallTerms | undefined;
  #slim = false;
  #slimSize = 0;
  #slimClauseCount = 0;
  #docClausesCache = new Map<string, readonly { readonly id: number; readonly words: Uint32Array; readonly originalWords: Uint32Array }[]>();
  #termCache = new Map<string, RecallTerm | null>();
  #wordLookup: WordLookup = { get: word => this.#term(word, "id") };
  #frequencyLookup: WordLookup = { get: word => this.#term(word, "frequency") };
  #clauseFrequencyLookup: WordLookup = { get: word => this.#term(word, "clauseFrequency") };

  #rowProjection(id: string): Pick<IndexedRow, "document" | "lexicon"> {
    let projection = this.#rowProjections.get(id);
    if (projection === undefined) {
      const saved = this.#database.prepare("SELECT meta, scoring, scoringCompressed, projection FROM recall_documents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (saved !== undefined && saved["projection"] != null) {
        projection = deserialize(inflateRawSync(saved["projection"] as Uint8Array)) as Pick<IndexedRow, "document" | "lexicon">;
      } else {
        const doc = deserialize(saved!["meta"] as Uint8Array) as RecallDocument;
        const scoring = unpackScoring(saved!["scoring"] as Uint8Array, Boolean(saved!["scoringCompressed"]));
        projection = { document: doc, lexicon: { ...scoring, clauses: [] } };
      }
      this.#rowProjections.set(id, projection);
    }
    return projection;
  }

  #rowScoring(id: string): Pick<DocumentLexicon, "words" | "identifiers" | "coverage" | "anchor"> {
    if (this.#packedScoring !== undefined) {
      this.#scoringIndex ??= new Map(this.#packedScoring.docIds.map((docId, index) => [docId, index]));
      const docIdx = this.#scoringIndex.get(id);
      if (docIdx !== undefined) {
        const { meta, words } = this.#packedScoring;
        const off = docIdx * 8;
        return {
          words: words.subarray(meta[off]!, meta[off]! + meta[off + 1]!),
          identifiers: words.subarray(meta[off + 2]!, meta[off + 2]! + meta[off + 3]!),
          coverage: words.subarray(meta[off + 4]!, meta[off + 4]! + meta[off + 5]!),
          anchor: words.subarray(meta[off + 6]!, meta[off + 6]! + meta[off + 7]!),
        };
      }
    }
    return this.#rowProjection(id).lexicon;
  }

  #clause(id: number): { readonly document: RecallDocument; readonly words: Uint32Array; readonly originalWords: Uint32Array } | undefined {
    if (this.#slim) {
      const cached = this.#clauses.get(id);
      if (cached !== undefined) return cached;
      const saved = this.#database.prepare("SELECT documentId, words, originalWords FROM recall_clause_data WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (saved === undefined) return undefined;
      const doc = this.#rowDoc(String(saved["documentId"]));
      if (doc === undefined) return undefined;
      const wBuf = saved["words"] as Uint8Array;
      const oBuf = saved["originalWords"] as Uint8Array;
      const entry = {
        document: doc,
        words: new Uint32Array(wBuf.buffer.slice(wBuf.byteOffset, wBuf.byteOffset + wBuf.byteLength)),
        originalWords: new Uint32Array(oBuf.buffer.slice(oBuf.byteOffset, oBuf.byteOffset + oBuf.byteLength)),
      };
      this.#clauses.set(id, entry);
      return entry;
    }
    if (this.#packedClauses !== undefined) {
      const { docIds, meta, words } = this.#packedClauses;
      let low = 0, high = meta.length / 6;
      while (low < high) {
        const mid = (low + high) >>> 1, off = mid * 6, cur = meta[off]!;
        if (cur < id) low = mid + 1;
        else if (cur > id) high = mid;
        else {
          const row = this.#rows.get(docIds[meta[off + 1]!]!);
          if (row === undefined) return undefined;
          const ws = meta[off + 2]!, wl = meta[off + 3]!, os = meta[off + 4]!, ol = meta[off + 5]!;
          return { document: row.document, words: words.subarray(ws, ws + wl), originalWords: words.subarray(os, os + ol) };
        }
      }
      return undefined;
    }
    if (this.#restoredClauses !== undefined) {
      const clause = this.#restoredClauses.get(id);
      if (clause === undefined) return undefined;
      const row = this.#rows.get(clause.documentId);
      return row === undefined ? undefined : { document: row.document, words: clause.words, originalWords: clause.originalWords };
    }
    return this.#clauses.get(id);
  }

  #clauseCount(): number {
    return this.#slim ? this.#slimClauseCount
      : this.#packedClauses !== undefined ? this.#packedClauses.meta.length / 6
      : this.#restoredClauses !== undefined ? this.#restoredClauses.size : this.#clauses.size;
  }

  #rowDoc(id: string): RecallDocument | undefined {
    const existing = this.#rows.get(id);
    if (existing !== undefined) return existing.document;
    if (!this.#slim) return undefined;
    const saved = this.#database.prepare("SELECT rowId, meta, scoring, scoringCompressed FROM recall_documents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (saved === undefined) return undefined;
    const doc = deserialize(saved["meta"] as Uint8Array) as RecallDocument;
    const scoring = unpackScoring(saved["scoring"] as Uint8Array, Boolean(saved["scoringCompressed"]));
    this.#rows.set(doc.id, { rowId: Number(saved["rowId"]), digest: "", document: doc, lexicon: undefined as unknown as DocumentLexicon, scoring });
    return doc;
  }

  #clausesForDoc(docId: string): readonly { readonly id: number; readonly words: Uint32Array; readonly originalWords: Uint32Array }[] {
    let list = this.#docClausesCache.get(docId);
    if (list !== undefined) return list;
    const rows = this.#database.prepare("SELECT id, words, originalWords FROM recall_clause_data WHERE documentId = ?").all(docId) as Record<string, unknown>[];
    list = rows.map(r => {
      const wBuf = r["words"] as Uint8Array;
      const oBuf = r["originalWords"] as Uint8Array;
      return {
        id: Number(r["id"]),
        words: new Uint32Array(wBuf.buffer.slice(wBuf.byteOffset, wBuf.byteOffset + wBuf.byteLength)),
        originalWords: new Uint32Array(oBuf.buffer.slice(oBuf.byteOffset, oBuf.byteOffset + oBuf.byteLength)),
      };
    });
    this.#docClausesCache.set(docId, list);
    return list;
  }

  #materializeClauses(): void {
    if (this.#packedClauses !== undefined) {
      const { docIds, meta, words } = this.#packedClauses;
      this.#clauses = new Map();
      for (let off = 0; off < meta.length; off += 6) {
        const row = this.#rows.get(docIds[meta[off + 1]!]!);
        if (row !== undefined) {
          const ws = meta[off + 2]!, wl = meta[off + 3]!, os = meta[off + 4]!, ol = meta[off + 5]!;
          this.#clauses.set(meta[off]!, { document: row.document, words: words.subarray(ws, ws + wl), originalWords: words.subarray(os, os + ol) });
        }
      }
      this.#packedClauses = undefined;
      return;
    }
    if (this.#restoredClauses === undefined) return;
    this.#clauses = new Map();
    for (const [id, clause] of this.#restoredClauses) {
      const row = this.#rows.get(clause.documentId);
      if (row !== undefined) this.#clauses.set(id, { document: row.document, words: clause.words, originalWords: clause.originalWords });
    }
    this.#restoredClauses = undefined;
  }

  #term(word: string, field: keyof RecallTerm): number | undefined {
    if (this.#slim) {
      if (!this.#termCache.has(word)) {
        const row = this.#database.prepare("SELECT id, frequency, clauseFrequency FROM recall_terms WHERE word = ?").get(word) as Record<string, unknown> | undefined;
        this.#termCache.set(word, row === undefined ? null : { id: Number(row["id"]), frequency: Number(row["frequency"]), clauseFrequency: Number(row["clauseFrequency"]) });
      }
      const term = this.#termCache.get(word);
      return term == null || field !== "id" && term[field] === 0 ? undefined : term[field];
    }
    if (this.#packedTerms === undefined) return (field === "id" ? this.#vocabulary : field === "frequency" ? this.#frequencies : this.#clauseFrequencies).get(word);
    if (!this.#termCache.has(word)) this.#termCache.set(word, findPackedTerm(this.#packedTerms, word));
    const term = this.#termCache.get(word);
    return term == null || field !== "id" && term[field] === 0 ? undefined : term[field];
  }

  #restoreAllTerms(): void {
    const terms = this.#packedTerms;
    if (terms === undefined) return;
    for (let offset = 0; offset < terms.entries.length; offset += 5) {
      const word = terms.text.subarray(terms.entries[offset]!, terms.entries[offset]! + terms.entries[offset + 1]!).toString("utf8");
      this.#vocabulary.set(word, terms.entries[offset + 2]!);
      if (terms.entries[offset + 3]! > 0) this.#frequencies.set(word, terms.entries[offset + 3]!);
      if (terms.entries[offset + 4]! > 0) this.#clauseFrequencies.set(word, terms.entries[offset + 4]!);
    }
    this.#packedTerms = undefined;
    this.#termCache.clear();
  }

  constructor(documents: readonly RecallDocument[], checkpoint: string, database = ":memory:", restored?: RecallIndexState, slim?: SlimRecallHeader) {
    this.#database = new DatabaseSync(database, { readOnly: restored !== undefined || slim !== undefined });
    this.#checkpoint = checkpoint;
    if (slim !== undefined) {
      this.#slim = true;
      this.#slimSize = slim.size;
      this.#slimClauseCount = slim.clauseCount;
      this.#byExternalKey = slim.byExternalKey;
      this.#keyRuns = slim.keyRuns;
      this.#nextRowId = slim.nextRowId;
      this.#nextClauseId = slim.nextClauseId;
      try { this.#database.exec("BEGIN"); this.#database.prepare("SELECT rowId FROM recall_documents LIMIT 1").get(); }
      catch (error) { this.#database.close(); throw error; }
      return;
    }
    if (restored !== undefined) {
      this.#rows = restored.rows as Map<string, IndexedRow>;
      this.#byExternalKey = restored.byExternalKey;
      this.#keyRuns = restored.keyRuns;
      this.#frequencies = restored.frequencies;
      if (restored.packedClauses !== undefined) this.#packedClauses = restored.packedClauses;
      else this.#restoredClauses = restored.clauses;
      this.#packedScoring = restored.packedScoring;
      this.#vocabulary = restored.vocabulary;
      this.#clauseRows = restored.clauseRows;
      this.#clauseFrequencies = restored.clauseFrequencies;
      this.#nextRowId = restored.nextRowId;
      this.#nextClauseId = restored.nextClauseId;
      this.#packedTerms = restored.packedTerms;
      // Exercise the actual database now, so locked/truncated artifacts recover
      // before recall tries to return a result from them.
      try { this.#database.exec("BEGIN"); this.#database.prepare("SELECT rowId FROM recall_documents LIMIT 1").get(); }
      catch (error) { this.#database.close(); throw error; }
      return;
    }
    // The fifth column serves key queries. The four-column projection preserves
    // prose BM25 statistics: a zero weight would still count key tokens in length.
    if (database !== ":memory:") this.#database.exec("PRAGMA page_size = 16384;");
    this.#database.exec(
      "CREATE TABLE recall_fts_content(rowId INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL, expansions TEXT NOT NULL, externalKey TEXT NOT NULL, proseTitle TEXT, proseBody TEXT, proseTags TEXT, proseExpansions TEXT);"
        + "CREATE VIEW recall_prose_view AS SELECT rowId, COALESCE(proseTitle, title) AS title, COALESCE(proseBody, body) AS body, COALESCE(proseTags, tags) AS tags, COALESCE(proseExpansions, expansions) AS expansions FROM recall_fts_content;"
        + "CREATE VIRTUAL TABLE recall_index USING fts5(title, body, tags, expansions, externalKey, content='recall_fts_content', content_rowid='rowId', tokenize='unicode61');"
        + "CREATE VIRTUAL TABLE recall_prose USING fts5(title, body, tags, expansions, content='recall_prose_view', content_rowid='rowId', tokenize='unicode61');"
        + "CREATE VIRTUAL TABLE recall_clauses USING fts5(body, tokenize='unicode61');"
        + "CREATE TABLE recall_documents(id TEXT PRIMARY KEY, rowId INTEGER NOT NULL, meta BLOB NOT NULL, scoring BLOB NOT NULL, scoringCompressed INTEGER NOT NULL, projection BLOB);"
        + "CREATE INDEX recall_documents_rowId ON recall_documents(rowId);"
        + "CREATE TABLE recall_terms(word TEXT PRIMARY KEY, id INTEGER NOT NULL, frequency INTEGER NOT NULL, clauseFrequency INTEGER NOT NULL);"
        + "CREATE TABLE recall_clause_data(id INTEGER PRIMARY KEY, documentId TEXT NOT NULL, words BLOB NOT NULL, originalWords BLOB NOT NULL);"
        + "CREATE INDEX recall_clause_doc ON recall_clause_data(documentId)",
    );
    this.#apply(documents);
  }

  projection(): RecallIndexState {
    this.#restoreAllTerms();
    this.#materializeClauses();
    const scoringDocIds: string[] = [];
    const scoringLexicons: Pick<DocumentLexicon, "words" | "identifiers" | "coverage" | "anchor">[] = [];
    let totalScoringWords = 0;
    for (const [id, row] of this.#rows) {
      const lex = row.lexicon ?? this.#rowScoring(id);
      scoringDocIds.push(id);
      scoringLexicons.push(lex);
      totalScoringWords += lex.words.length + lex.identifiers.length + lex.coverage.length + lex.anchor.length;
    }
    const scoringMeta = new Uint32Array(scoringDocIds.length * 8);
    const scoringWords = new Uint32Array(totalScoringWords);
    let scoringOff = 0;
    for (let i = 0; i < scoringLexicons.length; i += 1) {
      const lex = scoringLexicons[i]!;
      const off = i * 8;
      scoringMeta[off] = scoringOff; scoringMeta[off + 1] = lex.words.length;
      scoringWords.set(lex.words, scoringOff); scoringOff += lex.words.length;
      scoringMeta[off + 2] = scoringOff; scoringMeta[off + 3] = lex.identifiers.length;
      scoringWords.set(lex.identifiers, scoringOff); scoringOff += lex.identifiers.length;
      scoringMeta[off + 4] = scoringOff; scoringMeta[off + 5] = lex.coverage.length;
      scoringWords.set(lex.coverage, scoringOff); scoringOff += lex.coverage.length;
      scoringMeta[off + 6] = scoringOff; scoringMeta[off + 7] = lex.anchor.length;
      scoringWords.set(lex.anchor, scoringOff); scoringOff += lex.anchor.length;
    }
    // SQLite holds each row's display/lexical projection. A new process restores
    // only this catalogue and loads records actually matched by the query.
    return { rows: new Map([...this.#rows].map(([id, row]) => {
      const { decisions: _decisions, ...document } = row.document;
      return [id, { rowId: row.rowId, digest: row.digest, document: { ...document, body: "", tags: "", expansions: "" } }];
    })),
      byExternalKey: this.#byExternalKey,
      keyRuns: this.#keyRuns, frequencies: this.#frequencies,
      clauses: new Map([...this.#clauses].map(([id, clause]) => [id, { words: clause.words, originalWords: clause.originalWords, documentId: clause.document.id }])),
      packedScoring: { docIds: scoringDocIds, meta: scoringMeta, words: scoringWords },
      clauseRows: this.#clauseRows, clauseFrequencies: this.#clauseFrequencies,
      nextRowId: this.#nextRowId, nextClauseId: this.#nextClauseId, vocabulary: this.#vocabulary };
  }

  /** A private copy permits a transaction without modifying a published index. */
  writableCopy(database: string): void {
    this.#database.close();
    this.#database = new DatabaseSync(database);
  }

  async publish(temporary: string, destination: string): Promise<Buffer> {
    this.#database.close();
    const bytes = await readFile(temporary);
    await writeFileAtomic(destination, bytes);
    // Keep querying exactly the artifact whose maps we just built. Another
    // process may atomically publish a newer head at destination at any time.
    this.#database = new DatabaseSync(temporary, { readOnly: true });
    this.#cleanup = () => { this.#database.close(); rmSync(temporary, { force: true }); };
    process.once("exit", this.#cleanup);
    return bytes;
  }

  get checkpoint(): string {
    return this.#checkpoint;
  }

  get size(): number {
    return this.#slim ? this.#slimSize : this.#rows.size;
  }

  /** Rewrite only what moved, and report how much moved. */
  update(
    documents: readonly RecallDocument[],
    checkpoint: string,
  ): { readonly inserted: number; readonly removed: number } {
    const moved = this.#apply(documents);
    this.#checkpoint = checkpoint;
    return moved;
  }

  #apply(documents: readonly RecallDocument[]): { readonly inserted: number; readonly removed: number } {
    this.#restoreAllTerms();
    this.#materializeClauses();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const insertFtsContent = this.#database.prepare(
        "INSERT INTO recall_fts_content(rowId, title, body, tags, expansions, externalKey, proseTitle, proseBody, proseTags, proseExpansions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insert = this.#database.prepare(
        "INSERT INTO recall_index(rowid, title, body, tags, expansions, externalKey) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertProse = this.#database.prepare(
        "INSERT INTO recall_prose(rowid, title, body, tags, expansions) VALUES (?, ?, ?, ?, ?)",
      );
      const removeFtsIndex = this.#database.prepare(
        "INSERT INTO recall_index(recall_index, rowid, title, body, tags, expansions, externalKey) SELECT 'delete', rowId, title, body, tags, expansions, externalKey FROM recall_fts_content WHERE rowId = ?",
      );
      const removeFtsProse = this.#database.prepare(
        "INSERT INTO recall_prose(recall_prose, rowid, title, body, tags, expansions) SELECT 'delete', rowId, title, body, tags, expansions FROM recall_prose_view WHERE rowId = ?",
      );
      const removeFtsContent = this.#database.prepare("DELETE FROM recall_fts_content WHERE rowId = ?");
      const removeClause = this.#database.prepare("DELETE FROM recall_clauses WHERE rowid = ?");
      const removeClauseData = this.#database.prepare("DELETE FROM recall_clause_data WHERE id = ?");
      const insertClause = this.#database.prepare("INSERT INTO recall_clauses(rowid, body) VALUES (?, ?)");
      const insertClauseData = this.#database.prepare("INSERT INTO recall_clause_data(id, documentId, words, originalWords) VALUES (?, ?, ?, ?)");
      const removeProjection = this.#database.prepare("DELETE FROM recall_documents WHERE id = ?");
      const insertProjection = this.#database.prepare("INSERT INTO recall_documents(id, rowId, meta, scoring, scoringCompressed, projection) VALUES (?, ?, ?, ?, ?, ?)");
      const incoming = new Map<string, RecallDocument>();
      for (const document of documents) incoming.set(document.id, document);
      let removed = 0;
      for (const [id, row] of [...this.#rows]) {
        const next = incoming.get(id);
        if (next !== undefined && documentDigest(next) === row.digest) continue;
        removeFtsIndex.run(row.rowId);
        removeFtsProse.run(row.rowId);
        removeFtsContent.run(row.rowId);
        removeProjection.run(id);
        for (const clauseId of this.#clauseRows.get(id) ?? []) {
          removeClause.run(clauseId);
          removeClauseData.run(clauseId);
          this.#clauses.delete(clauseId);
        }
        this.#clauseRows.delete(id);
        this.#rows.delete(id);
        removed += 1;
      }
      let inserted = 0;
      for (const [id, document] of incoming) {
        if (this.#rows.has(id)) continue;
        const rowId = this.#nextRowId;
        this.#nextRowId += 1;
        const fields = [
          segmentForIndex(document.title),
          segmentForIndex(document.body),
          segmentForIndex(document.tags),
          segmentForIndex(document.expansions),
        ] as const;
        const keyTokens = externalKeyTokens(document.key).join(" ");
        const proseFields = [
          segmentProse(document.title),
          segmentProse(document.body),
          segmentProse(document.tags),
          segmentProse(document.expansions),
        ] as const;
        insertFtsContent.run(
          rowId,
          fields[0], fields[1], fields[2], fields[3], keyTokens,
          proseFields[0] === fields[0] ? null : proseFields[0],
          proseFields[1] === fields[1] ? null : proseFields[1],
          proseFields[2] === fields[2] ? null : proseFields[2],
          proseFields[3] === fields[3] ? null : proseFields[3],
        );
        insert.run(rowId, fields[0], fields[1], fields[2], fields[3], keyTokens);
        // Identifier expansions have their own route: they must not change every
        // prose score through FTS length normalization.
        insertProse.run(rowId, proseFields[0], proseFields[1], proseFields[2], proseFields[3]);
        // Persist these timeless token sets with the row. Profiles showed that
        // re-tokenizing every matched historical clause dominated warm queries.
        const lexicon = documentLexicon(document, this.#vocabulary);
        this.#rows.set(id, { rowId, digest: documentDigest(document), document, lexicon });
        const { decisions: _decisions, ...slimDoc } = document;
        const rawLen = (3 + lexicon.words.length + lexicon.identifiers.length + lexicon.coverage.length + lexicon.anchor.length) * 4;
        const packedScoring = packScoring(lexicon);
        insertProjection.run(
          id,
          rowId,
          serialize({ ...slimDoc, body: "", tags: "", expansions: "" }),
          packedScoring,
          rawLen > 64 ? 1 : 0,
          (document.decisions?.length ?? 0) > 0
            ? deflateRawSync(serialize({ document: { ...document, body: "", tags: "", expansions: "" }, lexicon }))
            : null,
        );
        const clauseIds: number[] = [];
        for (const [position, decision] of (document.decisions ?? []).entries()) {
          const clauseId = this.#nextClauseId++;
          const indexed = segmentForIndex(decision.text);
          insertClause.run(clauseId, indexed);
          const cWords = wordIds(recallQueryTokens(indexed), this.#vocabulary);
          const oWords = lexicon.clauses[position]!.words;
          insertClauseData.run(
            clauseId,
            id,
            Buffer.from(cWords.buffer, cWords.byteOffset, cWords.byteLength),
            Buffer.from(oWords.buffer, oWords.byteOffset, oWords.byteLength),
          );
          this.#clauses.set(clauseId, { document, words: cWords, originalWords: oWords });
          clauseIds.push(clauseId);
        }
        this.#clauseRows.set(id, clauseIds);
        inserted += 1;
      }
      this.#byExternalKey = new Map();
      this.#keyRuns = new Map();
      this.#frequencies = new Map();
      this.#clauseFrequencies = new Map();
      const vocabulary = new Map([...this.#vocabulary].map(([word, id]) => [id, word]));
      for (const row of this.#rows.values()) {
        const lexicon = row.lexicon ?? this.#rowProjection(row.document.id).lexicon;
        for (const id of lexicon.coverage) {
          const token = vocabulary.get(id)!;
          this.#frequencies.set(token, (this.#frequencies.get(token) ?? 0) + 1);
        }
        for (const clause of lexicon.clauses) {
          for (const id of clause.words) {
            const token = vocabulary.get(id)!;
            this.#clauseFrequencies.set(token, (this.#clauseFrequencies.get(token) ?? 0) + 1);
          }
        }
        if (row.document.key.length === 0) continue;
        this.#byExternalKey.set(row.document.key.toUpperCase(), row.document.id);
        this.#keyRuns.set(row.document.id, keyTokenRun(row.document.key));
      }
      this.#database.exec("DELETE FROM recall_terms");
      const insertTerm = this.#database.prepare("INSERT INTO recall_terms(word, id, frequency, clauseFrequency) VALUES (?, ?, ?, ?)");
      for (const [word, id] of this.#vocabulary) {
        insertTerm.run(word, id, this.#frequencies.get(word) ?? 0, this.#clauseFrequencies.get(word) ?? 0);
      }
      this.#database.exec("COMMIT");
      return { inserted, removed };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * The record a key fragment names, if exactly one: "STORY-474" or "INIT019-C12" spelled inside a
   * prompt names the one record whose key holds those whole tokens in that order. TCRN-CROSS-SUB-303:
   * a fragment is as deliberate as a full key, and at the calibrated strong-hit threshold its prefix
   * score alone (the weight-1 key column) would no longer be answered. A fragment needs two tokens and
   * a digit, so a hyphenated word ("read-only", "e-mail") names nothing.
   */
  #namedByFragment(candidate: string): RecallDocument | undefined {
    const run = keyTokenRun(candidate);
    if (run.length < 2 || !run.some((token) => /[0-9]/u.test(token))) return undefined;
    let named: RecallDocument | undefined;
    for (const [id, keyRun] of this.#keyRuns) {
      if (!containsRun(keyRun, run)) continue;
      if (named !== undefined) return undefined;
      named = this.#rowDoc(id);
    }
    return named;
  }

  /** The ranked answer, before any threshold. The records the prompt names, by key or fragment, lead. */
  search(query: string, limit: number = RECALL_CANDIDATE_LIMIT, details = true): readonly RecallHit[] {
    const makeHit = (document: RecallDocument, score: number, requested = 0): RecallHit => {
      if (details) {
        const row = this.#rows.get(document.id)!;
        return hitOf(row.deliveryDocument ?? document, row.lexicon, this.#wordLookup, score, query, this.#frequencyLookup, requested);
      }
      const hit = hitMetadata(document, score, query);
      this.#requested.set(hit, requested);
      return hit;
    };
    const hits: RecallHit[] = [];
    const seen = new Set<string>();
    const byKey = (key: string): RecallDocument | undefined => {
      const id = this.#byExternalKey.get(key.toUpperCase());
      return id === undefined ? undefined : this.#rowDoc(id);
    };
    const named = new Map<string, { document: RecallDocument; requested: number }>();
    for (const match of query.matchAll(RECORD_REFERENCE_CANDIDATE)) {
      const key = match[1]!;
      let document = this.#rowDoc(key) ?? byKey(key) ?? this.#namedByFragment(key);
      if (document === undefined && key.includes(":")) {
        // An unresolved namespace must not swallow a known key and its adjacent clause.
        const suffix = key.slice(key.indexOf(":") + 1);
        document = byKey(suffix) ?? this.#namedByFragment(suffix);
      }
      if (document === undefined) continue;
      // Bind the adjacent #D through the same resolver as the record, before deduplication.
      if (!named.has(document.id) || named.get(document.id)!.requested === 0) {
        named.set(document.id, { document, requested: Number(match[2] ?? 0) });
      }
    }
    for (const { document, requested } of named.values()) {
      seen.add(document.id);
      hits.push(makeHit(document, RECALL_EXTERNAL_KEY_SCORE, requested));
    }
    const allTokens = [...recallTextTokens(query)];
    const identifiers = [...query.matchAll(/[A-Za-z][A-Za-z0-9_]*/gu)]
      .map((match) => match[0])
      .filter((token) => /[a-z][A-Z]|[A-Z][A-Z][a-z]|_/u.test(token))
      .map((token) => token.toLowerCase());
    // Long prompts cannot collect unbounded evidence from incidental short words.
    // Keep the informative constraints; full identifiers remain query terms as well.
    const queryTerms = (values: readonly string[]): readonly string[] => values.length <= 48 ? values : [...values]
      .sort((a, b) => (this.#frequencyLookup.get(a) ?? Number.MAX_SAFE_INTEGER) - (this.#frequencyLookup.get(b) ?? Number.MAX_SAFE_INTEGER)
        || b.length - a.length || values.indexOf(a) - values.indexOf(b))
      .slice(0, 48);
    const tokens = queryTerms(allTokens);
    const keyExpression = externalKeyExpression(query);
    if (tokens.length === 0 && keyExpression.length === 0) return hits;
    const byRowId = new Map<number, IndexedRow>();
    for (const row of this.#rows.values()) byRowId.set(row.rowId, row);
    const weights = RECALL_FIELD_WEIGHTS;
    const rows: Record<string, unknown>[] = [];
    const searches = [
      {
        table: "recall_prose",
        weights: [weights.title, weights.body, weights.tags, weights.expansions],
        expression: matchExpression(tokens),
      },
      {
        table: "recall_index",
        weights: [weights.title, weights.body, weights.tags, weights.expansions, weights.externalKey],
        expression: keyExpression.length === 0 ? "" : `externalKey : (${keyExpression})`,
      },
      ...(/[a-z][A-Z]|[A-Z][A-Z][a-z]|_/u.test(query) ? [{
        table: "recall_index",
        weights: [weights.title, weights.body, weights.tags, weights.expansions, 0],
        expression: `{title body tags expansions} : (${matchExpression(queryTerms(recallQueryTokens(query)))})`,
      }] : []),
    ];
    for (const search of searches) {
      if (search.expression.length === 0) continue;
      const statement = this.#database.prepare(
        `SELECT rowid AS rowId, bm25(${search.table}, ${search.weights.join(", ")}) AS score`
          + ` FROM ${search.table} WHERE ${search.table} MATCH ? ORDER BY score LIMIT ?`,
      );
      try {
        rows.push(...statement.all(search.expression, limit) as Record<string, unknown>[]);
      } catch (error) {
        throw new RecallError("RECALL_QUERY_FAILED", `the complete recall query could not be evaluated: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (tokens.length > 0 && allTokens.length <= 6 && this.#clauseCount() > 0) {
      // Use the query's actual record/clauses frequencies, including common terms.
      // A unit-only ratio would inflate common words in a one- or two-clause corpus.
      const clauseTokens = recallQueryTokens(query);
      const information = (size: number, frequencies: WordLookup): number => clauseTokens.reduce((sum, token) => {
        const count = frequencies.get(token) ?? 0;
        return sum + Math.max(1e-6, Math.log((size - count + 0.5) / (count + 0.5)));
      }, 0);
      const scale = information(this.size, this.#frequencyLookup) / information(this.#clauseCount(), this.#clauseFrequencyLookup);
      const statement = this.#database.prepare("SELECT rowid AS clauseId, bm25(recall_clauses, 3) AS score FROM recall_clauses WHERE recall_clauses MATCH ? ORDER BY score LIMIT ?");
      const rawClauses = statement.all(matchExpression(clauseTokens), limit) as Record<string, unknown>[];
      if (this.#slim && rawClauses.length > 0) {
        const missingClauseIds = [...new Set(rawClauses.map(r => Number(r["clauseId"])))].filter(id => !this.#clauses.has(id));
        if (missingClauseIds.length > 0) {
          const placeholders = missingClauseIds.map(() => "?").join(",");
          const loaded = this.#database.prepare(`SELECT id, documentId, words, originalWords FROM recall_clause_data WHERE id IN (${placeholders})`).all(...missingClauseIds) as Record<string, unknown>[];
          const missingDocIds = [...new Set(loaded.map(r => String(r["documentId"])))].filter(id => !this.#rows.has(id));
          if (missingDocIds.length > 0) {
            const docPh = missingDocIds.map(() => "?").join(",");
            for (const saved of this.#database.prepare(`SELECT id, rowId, meta, scoring, scoringCompressed FROM recall_documents WHERE id IN (${docPh})`).all(...missingDocIds) as Record<string, unknown>[]) {
              const doc = deserialize(saved["meta"] as Uint8Array) as RecallDocument;
              const scoring = unpackScoring(saved["scoring"] as Uint8Array, Boolean(saved["scoringCompressed"]));
              this.#rows.set(doc.id, { rowId: Number(saved["rowId"]), digest: "", document: doc, lexicon: undefined as unknown as DocumentLexicon, scoring });
            }
          }
          for (const saved of loaded) {
            const doc = this.#rows.get(String(saved["documentId"]))?.document;
            if (doc === undefined) continue;
            const wBuf = saved["words"] as Uint8Array;
            const oBuf = saved["originalWords"] as Uint8Array;
            this.#clauses.set(Number(saved["id"]), {
              document: doc,
              words: new Uint32Array(wBuf.buffer.slice(wBuf.byteOffset, wBuf.byteOffset + wBuf.byteLength)),
              originalWords: new Uint32Array(oBuf.buffer.slice(oBuf.byteOffset, oBuf.byteOffset + oBuf.byteLength)),
            });
          }
        }
      }
      for (const row of rawClauses) {
        const clause = this.#clause(Number(row["clauseId"]));
        if (clause === undefined || !clauseTokens.every((token) => hasWord(clause.words, this.#wordLookup.get(token)))) continue;
        const document = clause.document;
        const rowId = document === undefined ? undefined : this.#rows.get(document.id)?.rowId;
        if (rowId !== undefined) {
          byRowId.set(rowId, this.#rows.get(document.id)!);
          rows.push({ rowId, score: Number(row["score"]) * scale });
        }
      }
    }
    if (this.#slim && rows.length > 0) {
      const needed = [...new Set(rows.map(r => Number(r["rowId"])))].filter(id => !byRowId.has(id));
      if (needed.length > 0) {
        const placeholders = needed.map(() => "?").join(",");
        for (const saved of this.#database.prepare(`SELECT id, rowId, meta, scoring, scoringCompressed FROM recall_documents WHERE rowId IN (${placeholders})`).all(...needed) as Record<string, unknown>[]) {
          const doc = deserialize(saved["meta"] as Uint8Array) as RecallDocument;
          const scoring = unpackScoring(saved["scoring"] as Uint8Array, Boolean(saved["scoringCompressed"]));
          const row: IndexedRow = { rowId: Number(saved["rowId"]), digest: "", document: doc, lexicon: undefined as unknown as DocumentLexicon, scoring };
          this.#rows.set(doc.id, row);
          byRowId.set(row.rowId, row);
        }
      }
      if (allTokens.length >= 2 && allTokens.length <= 6) {
        const docIds = [...new Set(rows.map(r => byRowId.get(Number(r["rowId"]))?.document.id).filter((id): id is string => id !== undefined && !this.#docClausesCache.has(id)))];
        if (docIds.length > 0) {
          for (const docId of docIds) this.#docClausesCache.set(docId, []);
          const ph = docIds.map(() => "?").join(",");
          for (const r of this.#database.prepare(`SELECT id, documentId, words, originalWords FROM recall_clause_data WHERE documentId IN (${ph})`).all(...docIds) as Record<string, unknown>[]) {
            const wBuf = r["words"] as Uint8Array;
            const oBuf = r["originalWords"] as Uint8Array;
            (this.#docClausesCache.get(String(r["documentId"])) as { id: number; words: Uint32Array; originalWords: Uint32Array }[]).push({
              id: Number(r["id"]),
              words: new Uint32Array(wBuf.buffer.slice(wBuf.byteOffset, wBuf.byteOffset + wBuf.byteLength)),
              originalWords: new Uint32Array(oBuf.buffer.slice(oBuf.byteOffset, oBuf.byteOffset + oBuf.byteLength)),
            });
          }
        }
      }
    }
    // Keep the strongest score for a record found by both routes, never sum them.
    // The prose route retains its original length and document-frequency statistics.
    rows.sort((left, right) => Number(left["score"]) - Number(right["score"]));
    const maximumHits = limit < 0 ? Number.POSITIVE_INFINITY : hits.length + limit;
    for (const row of rows) {
      const document = byRowId.get(Number(row["rowId"]))?.document;
      if (document === undefined || seen.has(document.id)) continue;
      seen.add(document.id);
      const indexed = this.#rows.get(document.id)!;
      const lexicon = indexed.lexicon ?? indexed.scoring ?? this.#rowScoring(document.id);
      const decay = document.currentContract && ["done", "cancelled"].includes(document.status) && !recallQueryIsHistorical(query) ? 0.85 : 1;
      const coherent = allTokens.length >= 2 && allTokens.length <= 6 && (
        this.#slim
          ? this.#clausesForDoc(document.id).some(c => allTokens.every(token => hasWord(c.originalWords, this.#wordLookup.get(token))))
          : (this.#clauseRows.get(document.id) ?? []).some(id => allTokens.every(token => hasWord(this.#clause(id)!.originalWords, this.#wordLookup.get(token))))
      );
      // A complete technical name is a deliberate constraint, even in a small
      // library where that name occurs in several records. Every short-query
      // constraint must still match, and withheld clauses cannot supply the name.
      const exactIdentifier = allTokens.length <= 6 && identifiers.some((identifier) => hasWord(lexicon.identifiers, this.#wordLookup.get(identifier)))
        && allTokens.every((token) => hasWord(lexicon.words, this.#wordLookup.get(token)));
      const identifierBonus = exactIdentifier ? RECALL_FIELD_WEIGHTS.body * recallScoreUnit(this.size) : 0;
      let coverage = 1;
      if (allTokens.length > 24) {
        const words = lexicon.coverage;
        const weight = (token: string): number => 1 + Math.log((this.size + 1) / ((this.#frequencyLookup.get(token) ?? 0) + 1));
        const total = allTokens.reduce((sum, token) => sum + weight(token), 0);
        const matched = allTokens.filter((token) => hasWord(words, this.#wordLookup.get(token))).reduce((sum, token) => sum + weight(token), 0);
        const anchor = lexicon.anchor;
        const anchored = allTokens.filter((token) => hasWord(anchor, this.#wordLookup.get(token))).length >= 2;
        coverage = anchored ? 1 : matched / total;
      }
      hits.push(makeHit(document, (-Number(row["score"]) + identifierBonus) * decay * coverage * (coherent ? 1.1 : 1)));
      if (hits.length >= maximumHits) break;
    }
    return [
      ...hits.filter((hit) => hit.score === RECALL_EXTERNAL_KEY_SCORE),
      ...hits.filter((hit) => hit.score !== RECALL_EXTERNAL_KEY_SCORE).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)),
    ];
  }

  deliver(hit: RecallHit, query: string): RecallHit {
    const row = this.#rows.get(hit.id)!;
    const projection = row.lexicon !== undefined ? row : this.#rowProjection(hit.id);
    return hitOf(row.deliveryDocument ?? projection.document, projection.lexicon, this.#wordLookup, hit.score, query, this.#frequencyLookup, this.#requested.get(hit) ?? 0);
  }

  close(): void {
    if (this.#cleanup !== undefined) {
      const cleanup = this.#cleanup;
      this.#cleanup = undefined;
      process.removeListener("exit", cleanup);
      cleanup();
    } else this.#database.close();
  }
}

/**
 * Absolute floor, then relative floor, then the per-kind quota, then the limit. The
 * relative floor's basis is the best bm25 score rather than the best score outright,
 * so a prompt that names one record by key does not silence everything else.
 * TCRN-CROSS-SUB-302: `tau` here is the absolute floor in bm25, the unit of the ranked scores; a
 * list carries no library size, so it has no default of its own. recall() passes the floor its
 * strong-hit threshold becomes in the library it searched (recallStrongHitFloor).
 */
export function selectRecallHits(
  ranked: readonly RecallHit[],
  options: RecallSelectionOptions = {},
): readonly RecallHit[] {
  const tau = options.tau ?? 0;
  const relativeFloor = options.relativeFloor ?? RECALL_RELATIVE_FLOOR;
  const limit = options.limit ?? RECALL_DEFAULT_LIMIT;
  const quota = options.quota ?? null;
  const best = ranked.find((hit) => hit.score !== RECALL_EXTERNAL_KEY_SCORE)?.score ?? 0;
  const floor = Math.max(tau, best * relativeFloor);
  const taken = new Map<RecallKind, number>();
  const out: RecallHit[] = [];
  for (const hit of ranked) {
    if (hit.score !== RECALL_EXTERNAL_KEY_SCORE && hit.score < floor) continue;
    if (quota !== null) {
      const cap = quota[hit.kind];
      if ((taken.get(hit.kind) ?? 0) >= cap) continue;
      taken.set(hit.kind, (taken.get(hit.kind) ?? 0) + 1);
    }
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

export interface RecallKnowledgeInput {
  readonly id: string;
  readonly externalKey: string;
  readonly subject: string;
  readonly summary: string;
  readonly snippet: string;
  /** Optional source text is accepted at the boundary only to prove it is ignored. */
  readonly body?: string;
  readonly tags: readonly string[];
  readonly expansions?: string;
  // TCRN-CROSS-STORY-476 R5: the store the card was read from; carried to its hit.
  readonly scope?: RecallScope;
  // TCRN-CROSS-SUB-426 (MIN-239 D5): the card's source references, never indexed; a minutes id among
  // them links the card to that record's decisions, for the obsolete-decision hint.
  readonly sourceReferences?: readonly string[];
  // TCRN-CROSS-SUB-426 R17 续作修订三 (STORY-514 AC1): a removed card's removal, never indexed; only a
  // read asked for removed cards gives one, and its hit carries it.
  readonly removal?: RecallCardRemoval;
}

export interface RecallMinutesInput {
  readonly id: string;
  readonly conferenceTitle: string;
  readonly conferenceType: string;
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly outcomeClass: string;
  // TCRN-CROSS-STORY-475: a minutes record keeps its external key (a conference's minutes never had
  // one), and it is what an exact-key prompt names.
  readonly externalKey?: string | null;
  // TCRN-CROSS-SUB-426 (MIN-239 D6): the number of each entry of `decisions`, when they are not
  // D1..Dn -- recall indexes a record's valid decisions only, unless it was asked for the obsolete
  // ones too (R17 续作修订二), so the first one given can be D2.
  readonly decisionNumbers?: readonly number[];
  readonly projectId?: string;
  readonly decisionStatuses?: readonly ("valid" | "obsolete")[];
  readonly decisionSuccessors?: readonly (string | null)[];
}

export interface RecallWorkInput {
  readonly involvedProjects?: InvolvedProjects;
  readonly id: string;
  readonly externalKey: string;
  readonly kind: string;
  readonly status: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly scope: string;
  readonly labels: readonly string[];
  // TCRN-CROSS-STORY-474 R1, R2 (recall-inputs.ts): the goal and the free body (story-fields.ts), and
  // the titles above the record, nearest first. A caller that has none leaves them out.
  readonly goal?: string | null;
  readonly body?: string | null;
  readonly parentChain?: readonly string[];
  readonly contract?: string;
}

/**
 * TCRN-CROSS-STORY-474 R1 (MIN-227 D5, D7): which work records recall indexes, and on what. A Story
 * -- and a historical Incident, a Story's predecessor for a defect -- is indexed on its title, goal
 * and body; an Initiative and an Epic on their title and goal (their summary when they have no
 * goal); a Subtask, a Release, a Review and a Knowledge record are not indexed. Status does not
 * matter: a done Story is still the record of what was intended.
 */
export const RECALL_INDEXED_WORK_KINDS = Object.freeze(["Story", "Incident", "Initiative", "Epic"] as const);
const RECALL_FULL_TEXT_KINDS: readonly string[] = ["Story", "Incident"];

export interface RecallInputs {
  readonly knowledge?: readonly RecallKnowledgeInput[];
  readonly minutes?: readonly RecallMinutesInput[];
  readonly work?: readonly RecallWorkInput[];
  readonly scopeExcerptBytes?: number;
}

export const RECALL_DEFAULT_SCOPE_EXCERPT_BYTES = 512;

function excerpt(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

// Knowledge article cards carry only an index contract in the store. Keep the
// recall projection metadata-only as well: the Markdown source is deliberately
// not a RecallKnowledgeInput field, so a body-only term cannot enter the FTS5
// corpus through this adapter.
function knowledgeMetadataBody(card: RecallKnowledgeInput): string {
  return `${card.summary} ${card.snippet}`.trim();
}

/**
 * The three record families reduced to documents.
 *
 * A work record's summary text is its `summary` field when it has one and the bounded
 * head of its scope otherwise, which is the length `retrieval.scopeExcerptBytes` has
 * always governed. A record with neither a title nor summary text is not indexed: of
 * the 802 work records on the cross-project chain on 2026-09-04, 747 carried nothing a
 * reader could have typed, and indexing them adds 747 documents of pure length
 * normalisation to every bm25 score in the corpus.
 */
export function recallDocuments(inputs: RecallInputs): readonly RecallDocument[] {
  const scopeExcerptBytes = inputs.scopeExcerptBytes ?? RECALL_DEFAULT_SCOPE_EXCERPT_BYTES;
  const documents: RecallDocument[] = [];
  for (const card of inputs.knowledge ?? []) {
    documents.push({
      id: card.id,
      kind: "card",
      key: card.externalKey,
      status: "active",
      title: card.subject,
      body: knowledgeMetadataBody(card),
      tags: card.tags.join(" "),
      expansions: card.expansions ?? "",
      summary: card.summary,
      recordKind: "card",
      parentChain: [],
      lead: "",
      ...(card.scope === undefined ? {} : { scope: card.scope }),
    });
  }
  for (const minutes of inputs.minutes ?? []) {
    const key = minutes.externalKey ?? null;
    const first = minutes.decisions[0];
    const firstNumber = minutes.decisionNumbers?.[0] ?? 1;
    documents.push({
      id: minutes.id,
      kind: "minutes",
      key: key === null || key.length === 0 ? minutes.id : key,
      status: minutes.outcomeClass,
      title: minutes.conferenceTitle,
      // Decision references are hyphen-joined identifiers; splitting them lets a prompt
      // naming one part of a ruling reach the minutes that carry it.
      body: `${minutes.summary} ${minutes.decisions.join(" ").replace(/-/gu, " ")}`.trim(),
      tags: `minutes ${minutes.conferenceType}`.trim(),
      expansions: "",
      summary: minutes.summary,
      recordKind: "minutes",
      parentChain: [],
      lead: first === undefined ? "" : `D${String(firstNumber)} ${first}${minutes.decisions.length > 1 ? " …" : ""}`,
      decisions: minutes.decisions.map((text, index) => ({
        number: minutes.decisionNumbers?.[index] ?? index + 1,
        text,
        reference: `${minutes.id}#D${minutes.decisionNumbers?.[index] ?? index + 1}`,
        scope: minutes.projectId ?? "本纪要",
        status: minutes.decisionStatuses?.[index] ?? "valid",
        ...(minutes.decisionSuccessors === undefined ? {} : { supersededBy: minutes.decisionSuccessors[index] ?? null }),
      })),
    });
  }
  for (const record of inputs.work ?? []) {
    if (!(RECALL_INDEXED_WORK_KINDS as readonly string[]).includes(record.kind)) continue;
    const title = record.title ?? "";
    const summary = record.summary !== null && record.summary.length > 0
      ? record.summary
      : excerpt(record.scope, scopeExcerptBytes);
    const goal = record.goal ?? "";
    const fullText = RECALL_FULL_TEXT_KINDS.includes(record.kind);
    // With no goal or body (a caller that did not read the fields), the summary line stands in,
    // as it always did; an Initiative or an Epic falls back to its summary alone.
    const text = fullText
      ? [goal, record.body ?? ""].filter((part) => part.length > 0).join("\n\n")
      : goal;
    const body = record.contract ?? (text.length > 0 ? text : fullText ? summary : (record.summary ?? ""));
    if (title.length === 0 && body.length === 0) continue;
    documents.push({
      id: record.id,
      kind: "work",
      key: record.externalKey,
      status: record.status,
      title,
      body,
      tags: `${record.kind} ${record.status} ${record.labels.join(" ")}`.trim(),
      expansions: record.contract === undefined ? "" : (record.summary ?? ""),
      summary: summary.length > 0 ? summary : goal,
      recordKind: record.kind,
      ...(record.involvedProjects === undefined ? {} : { involvedProjects: record.involvedProjects }),
      parentChain: record.parentChain ?? [],
      lead: "",
      ...(record.contract === undefined ? {} : { currentContract: true }),
    });
  }
  return documents;
}

export interface RecallRequest {
  /** Which store this index belongs to. One entry per workspace root. */
  readonly cacheKey: string;
  /** The storage checkpoint the documents were read at: chain head plus knowledge marker. */
  readonly checkpoint: string;
  /** Read lazily, so a query answered from the cache never pays for the read. */
  readonly documents: () => readonly RecallDocument[];
  readonly query: string;
  readonly tau?: number;
  readonly relativeFloor?: number;
  readonly limit?: number;
  readonly quota?: Readonly<Record<RecallKind, number>> | null;
}

export interface RecallResult {
  // RECALL_NO_STRONG_HIT: the best hit scored below the floor tau becomes, so records is empty.
  readonly reasonCode: "RECALL_READY" | "RECALL_NO_STRONG_HIT";
  readonly checkpoint: string;
  readonly indexed: number;
  readonly rebuilt: boolean;
  readonly inserted: number;
  readonly removed: number;
  readonly tokens: readonly string[];
  // The strong-hit threshold, in recallScoreUnit units (TCRN-CROSS-SUB-302), and the bm25 floor it
  // became in this index: tau times recallScoreUnit(indexed).
  readonly tau: number;
  readonly floor: number;
  readonly relativeFloor: number;
  readonly limit: number;
  readonly total: number;
  readonly records: readonly RecallHit[];
}

/**
 * TCRN-CROSS-STORY-362 requirement 5. The index is cached against the storage
 * checkpoint, so a second query at the same chain head reads nothing and rebuilds
 * nothing; a moved chain head rewrites the rows whose own digest changed and leaves
 * the rest of the table in place. Each explicit cache key owns its index until
 * resetRecallCache closes it; selecting another project does not evict its index.
 */
const cachedIndexes = new Map<string, RecallIndex>();
const PERSISTENT_RECALL_VERSION = "record-clause-fts-v17";

interface SlimRecallHeader {
  readonly checkpoint: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly size: number;
  readonly clauseCount: number;
  readonly nextRowId: number;
  readonly nextClauseId: number;
  readonly byExternalKey: Map<string, string>;
  readonly keyRuns: Map<string, readonly string[]>;
}

interface PersistentRecallProjection {
  readonly checkpoint: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly state: RecallIndexState;
}

interface PackedRecallProjection {
  readonly checkpoint: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly state: {
    readonly rows: Map<string, Pick<IndexedRow, "rowId" | "digest" | "document">>;
    readonly byExternalKey: Map<string, string>;
    readonly keyRuns: Map<string, readonly string[]>;
    readonly clauseRows: Map<string, readonly number[]>;
    readonly packedClauses: PackedRecallClauses;
    readonly packedScoring?: PackedScoringLexicons;
    readonly nextRowId: number;
    readonly nextClauseId: number;
  };
  readonly terms: PackedRecallTerms;
}

function serializableRecallProjection(value: PersistentRecallProjection): PackedRecallProjection {
  const state = value.state;
  const vocabulary = [...state.vocabulary].map(([word, id]) => ({ word, bytes: Buffer.from(word), id })).sort((left, right) => Buffer.compare(left.bytes, right.bytes));
  const entries = new Uint32Array(vocabulary.length * 5);
  let byteOffset = 0;
  for (const [position, term] of vocabulary.entries()) {
    entries.set([byteOffset, term.bytes.length, term.id, state.frequencies.get(term.word) ?? 0, state.clauseFrequencies.get(term.word) ?? 0], position * 5);
    byteOffset += term.bytes.length;
  }
  const terms: PackedRecallTerms = { text: Buffer.concat(vocabulary.map(term => term.bytes)), entries };
  const sortedClauses = [...state.clauses.entries()].sort(([a], [b]) => a - b);
  const docIndex = new Map<string, number>();
  const docIds: string[] = [];
  let totalWords = 0;
  for (const [, clause] of sortedClauses) {
    if (!docIndex.has(clause.documentId)) { docIndex.set(clause.documentId, docIds.length); docIds.push(clause.documentId); }
    totalWords += clause.words.length + clause.originalWords.length;
  }
  const meta = new Uint32Array(sortedClauses.length * 6);
  const words = new Uint32Array(totalWords);
  let wordOffset = 0;
  for (let i = 0; i < sortedClauses.length; i += 1) {
    const [id, clause] = sortedClauses[i]!;
    const off = i * 6;
    meta[off] = id;
    meta[off + 1] = docIndex.get(clause.documentId)!;
    meta[off + 2] = wordOffset;
    meta[off + 3] = clause.words.length;
    words.set(clause.words, wordOffset);
    wordOffset += clause.words.length;
    meta[off + 4] = wordOffset;
    meta[off + 5] = clause.originalWords.length;
    words.set(clause.originalWords, wordOffset);
    wordOffset += clause.originalWords.length;
  }
  return { checkpoint: value.checkpoint, sha256: value.sha256, bytes: value.bytes, state: {
    rows: state.rows, byExternalKey: state.byExternalKey, keyRuns: state.keyRuns,
    clauseRows: state.clauseRows, packedClauses: { docIds, meta, words }, ...(state.packedScoring === undefined ? {} : { packedScoring: state.packedScoring }),
    nextRowId: state.nextRowId, nextClauseId: state.nextClauseId,
  }, terms };
}

function parseRecallProjection(packed: PackedRecallProjection): PersistentRecallProjection {
  return { checkpoint: packed.checkpoint, sha256: packed.sha256, bytes: packed.bytes, state: {
    ...packed.state, clauses: new Map(), packedClauses: packed.state.packedClauses,
    frequencies: new Map(), vocabulary: new Map(), packedTerms: packed.terms, clauseFrequencies: new Map(),
  } };
}

/** Ordinary CLI/Hook reads keep an immutable, checkpoint-bound SQLite artifact
 * on this device. A changed corpus is applied transactionally to a private copy
 * and atomically published. Readers never modify an index another process uses.
 * The independent projection record authenticates both SQLite bytes and maps. */
export async function recallPersistent(request: RecallRequest, root: string): Promise<RecallResult> {
  const current = cachedIndexes.get(request.cacheKey);
  // A retained SQLite connection is also exposed to external mapped writes.
  // Reopen only after verifying current bytes, even within one process.
  if (current !== undefined) { current.close(); cachedIndexes.delete(request.cacheKey); }
  const library = await openLibrary(root);
  const name = `recall-${createHash("sha256").update(request.cacheKey).digest("hex")}`;
  const binding = PERSISTENT_RECALL_VERSION;
  let temporary: string | undefined;
  let index: RecallIndex | undefined;
  let documents: readonly RecallDocument[] | undefined;
  const inputs = (): readonly RecallDocument[] => documents ??= request.documents();
  try {
    const directory = cachePath(library.manifest.libraryId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const database = join(directory, `${name}.sqlite`);
    const slimSaved = await readProtectedProjection<SlimRecallHeader>(library, name, binding);
    let bytes: Buffer | undefined;
    if (slimSaved !== null) {
      let file: number | undefined;
      try {
        file = openSync(database, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(file, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(slimSaved.bytes)) throw new Error("invalid index file");
        // ctime/inode equality cannot detect every mmap write. The independent
        // projection authenticates the full SHA-256; verify it on every open.
        if (slimSaved.checkpoint === request.checkpoint) {
          const digest = observeAuthorityWork("cacheHash", () => fileContentDigest(file!));
          observeCacheRead(digest.bytes);
          if (digest.bytes !== slimSaved.bytes || digest.sha256 !== slimSaved.sha256) throw new Error("damaged index");
          index = new RecallIndex([], slimSaved.checkpoint, database, undefined, slimSaved);
        } else {
          bytes = readFileSync(file);
          observeCacheRead(bytes.length);
          if (bytes.length !== slimSaved.bytes || observeAuthorityWork("cacheHash", () => createHash("sha256").update(bytes!).digest("hex")) !== slimSaved.sha256) throw new Error("damaged index");
          const deltaSaved = await readProtectedProjection<PackedRecallProjection>(library, `${name}-delta`, binding);
          if (deltaSaved !== null && deltaSaved.sha256 === slimSaved.sha256 && deltaSaved.bytes === slimSaved.bytes) {
            index = new RecallIndex([], slimSaved.checkpoint, database, parseRecallProjection(deltaSaved).state);
          }
        }
        if (index !== undefined) {
          const after = lstatSync(database, { bigint: true });
          if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs) throw new Error("index replaced during open");
        }
      } catch {
        index?.close();
        index = undefined;
        bytes = undefined;
        observeCacheReason("fts-persistent-invalid-or-busy");
      } finally { if (file !== undefined) closeSync(file); }
    }
    if (index?.checkpoint === request.checkpoint) {
      observeCacheReason("fts-persistent-hit");
      cachedIndexes.set(request.cacheKey, index);
      return recall(request);
    }
    temporary = join(directory, `.tmp-${name}-${process.pid}-${crypto.randomUUID()}.sqlite`);
    let moved;
    if (index !== undefined && bytes !== undefined) {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      index.writableCopy(temporary);
      moved = index.update(inputs(), request.checkpoint);
      observeCacheReason(`fts-persistent-delta:${moved.inserted}:${moved.removed}`);
    } else {
      index = new RecallIndex(inputs(), request.checkpoint, temporary);
      moved = { inserted: index.size, removed: 0 };
      observeCacheReason(`fts-persistent-build:${index.size}`);
    }
    const written = await index.publish(temporary, database);
    temporary = undefined;
    const sha256 = createHash("sha256").update(written).digest("hex");
    const projection: PersistentRecallProjection = { checkpoint: request.checkpoint, sha256, bytes: written.length,
      state: index.projection() };
    await writeProtectedProjection(library, `${name}-delta`, binding, serializableRecallProjection(projection));
    await writeProtectedProjection(library, name, binding, {
      checkpoint: request.checkpoint,
      sha256,
      bytes: written.length,
      size: index.size,
      clauseCount: projection.state.clauses.size,
      nextRowId: projection.state.nextRowId,
      nextClauseId: projection.state.nextClauseId,
      byExternalKey: projection.state.byExternalKey,
      keyRuns: projection.state.keyRuns,
    } satisfies SlimRecallHeader);
    cachedIndexes.set(request.cacheKey, index);
    return { ...recall(request), rebuilt: true, inserted: moved.inserted, removed: moved.removed };
  } catch {
    try { index?.close(); } catch { /* An unsuccessful open may already be closed. */ }
    cachedIndexes.delete(request.cacheKey);
    observeCacheReason("fts-persistent-fallback-memory");
    return recall({ ...request, documents: inputs });
  } finally {
    if (temporary !== undefined) {
      await rm(temporary, { force: true }).catch(() => undefined);
      await rm(`${temporary}-journal`, { force: true }).catch(() => undefined);
    }
  }
}

/** A request recall cannot answer as asked. */
export class RecallError extends Error {
  readonly reasonCode: "RECALL_TAU_INVALID" | "RECALL_QUERY_FAILED";
  constructor(reasonCode: "RECALL_TAU_INVALID" | "RECALL_QUERY_FAILED", message: string) {
    super(message);
    this.name = "RecallError";
    this.reasonCode = reasonCode;
  }
}

export function recall(request: RecallRequest): RecallResult {
  let index = cachedIndexes.get(request.cacheKey);
  observeRecall(index === undefined ? "index-build" : index.checkpoint === request.checkpoint ? "request-index-hit" : "checkpoint-changed");
  let rebuilt = false;
  let moved = { inserted: 0, removed: 0 };
  if (index === undefined) {
    index = new RecallIndex(request.documents(), request.checkpoint);
    rebuilt = true;
    moved = { inserted: index.size, removed: 0 };
  } else if (index.checkpoint !== request.checkpoint) {
    moved = index.update(request.documents(), request.checkpoint);
    rebuilt = true;
  }
  cachedIndexes.delete(request.cacheKey);
  cachedIndexes.set(request.cacheKey, index);
  const ranked = index.search(request.query, RECALL_CANDIDATE_LIMIT, false);
  const tau = request.tau ?? RECALL_STRONG_TAU;
  if (!Number.isFinite(tau) || tau < 0) {
    throw new RecallError("RECALL_TAU_INVALID", `recall tau must be a finite non-negative number, not ${String(tau)}`);
  }
  const relativeFloor = request.relativeFloor ?? RECALL_RELATIVE_FLOOR;
  const limit = request.limit ?? RECALL_DEFAULT_LIMIT;
  // TCRN-CROSS-STORY-474 R3: no strong hit, no answer. An exact external-key hit is the strongest
  // hit there is (RECALL_EXTERNAL_KEY_SCORE), so naming a record is always answered, whatever tau.
  // MIN-235 D9 (TCRN-CROSS-SUB-302): tau is counted in words only one record of this library carries,
  // so the bm25 floor it becomes moves with the library the prompt is put to.
  const floor = recallStrongHitFloor(tau, index.size);
  const strong = ranked.some((hit) => hit.score === RECALL_EXTERNAL_KEY_SCORE || hit.score >= floor);
  const records = strong
    ? selectRecallHits(ranked, {
      tau: floor,
      relativeFloor,
      limit,
      quota: request.quota ?? null,
    }).map(hit => index.deliver(hit, request.query))
    : [];
  return {
    reasonCode: strong ? "RECALL_READY" : "RECALL_NO_STRONG_HIT",
    checkpoint: request.checkpoint,
    indexed: index.size,
    rebuilt,
    inserted: moved.inserted,
    removed: moved.removed,
    tokens: recallQueryTokens(request.query),
    tau,
    floor,
    relativeFloor,
    limit,
    total: ranked.length,
    records,
  };
}

/** Drop every cached index. For a process that wants the memory back. */
export function resetRecallCache(): void {
  for (const index of cachedIndexes.values()) index.close();
  cachedIndexes.clear();
}
