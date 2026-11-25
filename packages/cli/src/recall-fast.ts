// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { withRecallObservation } from "../../core/src/recall-observation.js";
import type { RecallObservation } from "../../core/src/recall-observation.js";
import { openLibrary } from "../../core/src/ether-library.js";
import { readRecallAuthority } from "../../core/src/recall-authority.js";
import { effectiveProjectState } from "../../core/src/project-state-read.js";
import { readRuntimeKnowledgeLanguagePolicy, resolveQueryLanguage } from "../../core/src/knowledge-language.js";
import { RECALL_DEFAULT_TAU, preparePersistentRecall, recallDocuments, recallPersistent } from "../../core/src/recall.js";
import type { RecallHit } from "../../core/src/recall.js";
import { formatRecallLine, readRecallCards, recallContextEntries, recallDecisionHints, recallInputsFromState } from "../../core/src/recall-inputs.js";
import type { RecallCardStoreRead, RecallUserCrestDegraded } from "../../core/src/recall-inputs.js";
import type { DecisionStatusFilter } from "../../core/src/minutes.js";
import type { KnowledgeStatusFilter } from "../../core/src/knowledge-core.js";
import { AGENT_OUTPUT_MAX_BYTES } from "../../core/src/runtime-output-limit.js";
import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
import { booleanValue, fail, integerValue, parseArguments, required } from "./cli-args.js";
import type { CliIo } from "./cli-args.js";

const RECALL_STATUS_FILTERS = Object.freeze(["valid", "removed", "obsolete", "all"] as const);
type RecallStatusFilter = typeof RECALL_STATUS_FILTERS[number];

function recallStatusOption(value: string | undefined): { readonly status?: RecallStatusFilter } {
  if (value === undefined) return {};
  if (!(RECALL_STATUS_FILTERS as readonly string[]).includes(value)) {
    fail("CLI_ARGUMENT_MALFORMED", `status=${value}; one of ${RECALL_STATUS_FILTERS.join(", ")}`);
  }
  return { status: value as RecallStatusFilter };
}

function recallCrestSummary(degraded: RecallUserCrestDegraded, store: RecallCardStoreRead): Readonly<Record<string, JsonValue>> {
  const diagnostics = store.evidence?.["diagnostics"] as Readonly<Record<string, JsonValue>> | undefined;
  return {
    reasonCode: degraded.reasonCode,
    withheldCards: degraded.withheldCards ?? null,
    conflictPairs: diagnostics?.["conflictPairCount"] ?? store.unresolvedConflicts.length,
    duplicateIds: diagnostics?.["duplicateIdCount"] ?? store.unresolvedDuplicates.length,
    unresolvedScopes: diagnostics?.["unresolvedScopeCount"] ?? store.unresolvedScopes.length,
    awaitingChain: diagnostics?.["awaitingChainCount"] ?? store.awaitingChain.length,
  };
}

export async function runRecallCommand(rest: readonly string[], io: CliIo): Promise<void> {
  // TCRN-CROSS-STORY-474: recall answers from one library, whatever directory it sits in; the
  // partition flag went with the partition registry. --host stays: it names the prompt-language
  // policy the answer is negotiated against.
  // TCRN-CROSS-SUB-425 (MIN-239 D6), TCRN-CROSS-SUB-426 R17 续作修订三 (C-R18-1; STORY-514 R4): the
  // cards and the decisions are the valid ones unless --status names a status of one family, which reads
  // that family as its list verb does (removed: the removed cards alone; obsolete: the obsolete
  // decisions alone; all: both families whole) and the other family's valid records; a model adds it
  // only when a user asked for them. See recallStatusOption.
  const values = parseArguments(rest, ["project-id", "workspace", "host", "at", "query", "limit", "tau", "allow-trailing", "status", "view"]);
  required(values, ["workspace", "at", "query"]);
  const status = recallStatusOption(values.status);
  if (values.view !== undefined && values.view !== "agent" && values.view !== "preview") fail("CLI_ARGUMENT_MALFORMED", "view");
  const cardStatus: KnowledgeStatusFilter = status.status === "removed" || status.status === "all" ? status.status : "valid";
  const decisions: DecisionStatusFilter = status.status === "obsolete" || status.status === "all" ? status.status : "valid";
  const workspace = values.workspace ?? "";
  const query = values.query ?? "";
  if (query.trim().length === 0 || query.length > RUNTIME_CAPACITY.stringCodeUnits || !query.isWellFormed()) fail("CLI_ARGUMENT_MALFORMED", "query");
  const limit = values.limit === undefined ? undefined : integerValue(values, "limit");
  if (limit !== undefined && (limit < 1 || !Number.isSafeInteger(limit))) fail("CLI_ARGUMENT_MALFORMED", "limit");
  const allowTrailing = booleanValue(values["allow-trailing"], "allow-trailing");
  const projectId = values["project-id"];
  const authorityPromise = readRecallAuthority(workspace, true);
  const cardsPromise = readRecallCards(workspace, {
    ...(projectId === undefined ? {} : { projectId }),
    at: values.at ?? "",
    allowTrailing,
    ...(cardStatus === "valid" ? {} : { status: cardStatus }),
  }, authorityPromise.then((resolved) => resolved.authority));
  const preparedPromise = openLibrary(workspace)
    .then((library) => preparePersistentRecall(`${library.manifest.libraryId}:${projectId ?? ""}`, workspace))
    .catch(() => undefined);
  const [{ state: rawState }, cards, prepared] = await Promise.all([authorityPromise, cardsPromise, preparedPromise]).catch(async (error: unknown) => {
    await (await preparedPromise)?.handle.close().catch(() => {});
    throw error;
  });
  let result;
  let state: Awaited<ReturnType<typeof effectiveProjectState>>;
  let languageAnswer;
  let scopeExcerptBytes = 512;
  let perPromptBytes = 1600;
  try {
    state = await effectiveProjectState(rawState, projectId);
    const settingValue = (key: string): string | undefined => state.settings.find((entry) => entry.key === key)?.value;
    const configuredTau = Number(settingValue("retrieval.tau") ?? String(RECALL_DEFAULT_TAU));
    const tau = values.tau === undefined
      ? (Number.isFinite(configuredTau) && configuredTau >= 0 ? configuredTau : RECALL_DEFAULT_TAU)
      : Number(values.tau);
    if (!Number.isFinite(tau) || tau < 0) fail("CLI_ARGUMENT_MALFORMED", "tau");
    languageAnswer = resolveQueryLanguage(query, await readRuntimeKnowledgeLanguagePolicy(state.settings, values.host));
    const scopeBytes = Number(settingValue("retrieval.scopeExcerptBytes") ?? "512");
    scopeExcerptBytes = Number.isSafeInteger(scopeBytes) && scopeBytes > 0 ? scopeBytes : 512;
    const promptBytes = Number(settingValue("injection.perPromptBytes") ?? "1600");
    perPromptBytes = Number.isSafeInteger(promptBytes) && promptBytes > 0 ? promptBytes : 1600;
    result = await recallPersistent({
      cacheKey: `${state.metadata.workspaceId}:${values["project-id"] ?? ""}`,
      checkpoint: `${state.headEventHash}:${cards.digest}:scope-bytes=${scopeExcerptBytes}${decisions === "valid" ? "" : `:decisions=${decisions}`}`,
      documents: () => recallDocuments(recallInputsFromState(state, cards.cards, { scopeExcerptBytes,
        ...(projectId === undefined ? {} : { projectId }), ...(decisions === "valid" ? {} : { decisions }) })),
      query,
      tau,
      ...(values.view === "preview" ? { explain: true } : {}),
      ...(limit === undefined ? {} : { limit }),
    }, workspace, prepared);
  } catch (error) {
    await prepared?.handle.close().catch(() => {});
    throw error;
  }
  // TCRN-CROSS-SUB-425, TCRN-CROSS-SUB-426 R17 续作修订三 (STORY-514 AC1): a hit on a removed card, which
  // only --status removed or all reads, says so and carries the card's removal as knowledge-list
  // answers it: the reason, basis, actor and instant, the card that superseded it, and its event.
  const removals = new Map(cards.cards.flatMap((card) => (card.removal === undefined ? [] : [[card.id, card.removal] as const])));
  const statusHits = result.records.map((hit) => {
    const removal = hit.kind === "card" ? removals.get(hit.id) : undefined;
    return removal === undefined ? hit : { ...hit, status: "removed", removal };
  });
  // TCRN-CROSS-SUB-426 (MIN-239 D5, D6): the valid decisions are indexed unless --status named
  // obsolete (the obsolete ones alone) or all (every one); a work or card hit that points at an
  // obsolete decision -- and, in a recall that indexed them, a minutes hit that holds one -- carries it
  // under obsoleteDecisions, with the decision that superseded it (null when withdrawn), and its line
  // says so.
  const hits = recallDecisionHints(state, cards.cards, statusHits, { decisions });
  const delivery = recallContextEntries(hits, perPromptBytes);
  const context = delivery.map((entry) => entry.line);
  const source = {
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
  };
  if (result.explanation !== undefined) {
    const { threshold, matchedTerms, nearMisses } = result.explanation;
    const candidate = (hit: RecallHit) => ({
      id: hit.id, key: hit.key, title: hit.title, kind: hit.kind, score: String(hit.score),
      matchedTerms: matchedTerms.get(hit.id) ?? [],
      ...(hit.decision === undefined ? {} : { decisionReference: hit.decision.reference }),
    });
    io.write(canonicalJson({
      schemaVersion: "tcrn.recall-preview.v1", reasonCode: result.reasonCode, ...source, ...status,
      indexed: result.indexed, threshold: String(threshold), tau: String(result.tau), relativeFloor: String(result.relativeFloor),
      candidates: delivery.map(({ hit }) => candidate(hit)), nearMisses: nearMisses.map(candidate),
    }));
    return;
  }
  const knowledge = {
    knowledgeReasonCode: cards.stores.project.reasonCode,
    // Both stores' reads: each one's reason code and how many cards it gave.
    knowledgeStores: {
      project: { reasonCode: cards.stores.project.reasonCode, cards: cards.stores.project.cards, ...cards.stores.project.evidence },
      user: { reasonCode: cards.stores.user.reasonCode, cards: cards.stores.user.cards, ...cards.stores.user.evidence },
    },
    // TCRN-CROSS-SUB-310 (MIN-235 D7): a user crest that gave fewer cards than it holds says so at
    // the top of the answer -- its read refused (the refusal's reasonCode), or cards withheld in
    // unresolved conflict (KNOWLEDGE_POSSIBLE_CONFLICT with unresolvedConflicts and withheldCards)
    // -- so "no user card matched" never stands in for "the user crest was not read".
    // TCRN-CROSS-SUB-413: every version of an id two devices wrote is withheld too, named under
    // unresolvedDuplicates (KNOWLEDGE_DUPLICATE when no pair is withheld as well).
    ...(cards.userCrestDegraded === null ? {} : { userCrestDegraded: cards.userCrestDegraded as unknown as JsonValue }),
    // TCRN-CROSS-SUB-414 (C-R15-1): the cards the library's crest withheld are named the same way,
    // in the same form: an unresolved pair (KNOWLEDGE_POSSIBLE_CONFLICT), versions of an unresolved
    // duplicate (KNOWLEDGE_DUPLICATE when no pair is withheld), cards whose project the chain no
    // longer holds, under unresolvedScopes (KNOWLEDGE_LINK_INVALID when neither is withheld; R16,
    // C-R16-1), or records awaiting chain events this device has not received, under awaitingChain
    // (KNOWLEDGE_HIGH_WATER_MISMATCH when they are all that is withheld), with withheldCards. A
    // refused read stays knowledgeReasonCode.
    ...(cards.projectCrestDegraded === null ? {} : { projectCrestDegraded: cards.projectCrestDegraded as unknown as JsonValue }),
  };
  // Both stores can be degraded at once. Reserve envelope space and avoid duplicating their
  // bounded examples in the legacy disclosure when that would exceed the empty-response budget.
  // Snapshot totals and ID examples remain in knowledgeStores; explicit list pages retain detail.
  if (Buffer.byteLength(JSON.stringify(knowledge), "utf8") > 3000) {
    if (cards.userCrestDegraded !== null) knowledge.userCrestDegraded = { ...recallCrestSummary(cards.userCrestDegraded, cards.stores.user), truncated: true };
    if (cards.projectCrestDegraded !== null) knowledge.projectCrestDegraded = { ...recallCrestSummary(cards.projectCrestDegraded, cards.stores.project), truncated: true };
  }
  if (values.view === "agent") {
    const summary = {
      schemaVersion: "tcrn.recall-agent.v1",
      reasonCode: result.reasonCode,
      ...source,
      ...status,
      indexed: result.indexed,
      total: result.total,
      perPromptBytes,
      queryLanguage: languageAnswer.queryLanguage,
      translationTarget: languageAnswer.queryTranslation?.to ?? null,
      knowledgeReasonCode: knowledge.knowledgeReasonCode,
      knowledgeStores: knowledge.knowledgeStores,
      ...(cards.userCrestDegraded === null ? {} : { userCrestDegraded: recallCrestSummary(cards.userCrestDegraded, cards.stores.user) }),
      ...(cards.projectCrestDegraded === null ? {} : { projectCrestDegraded: recallCrestSummary(cards.projectCrestDegraded, cards.stores.project) }),
      diagnostics: {
        schemaVersion: "tcrn.recall.v1",
        knowledgeSha256: canonicalSha256(knowledge),
        projectSnapshotDigest: cards.stores.project.digest === "absent" ? null : cards.stores.project.digest,
        userSnapshotDigest: cards.stores.user.digest === "absent" ? null : cards.stores.user.digest,
      },
      outputLimitBytes: AGENT_OUTPUT_MAX_BYTES,
    };
    const output = canonicalJson({ ...summary, delivery: "complete", context });
    const bytes = Buffer.byteLength(output, "utf8");
    io.write(bytes <= AGENT_OUTPUT_MAX_BYTES
      ? output
      : canonicalJson({ ...summary, delivery: "over-budget", requiredBytes: bytes }));
    return;
  }
  io.write(canonicalJson({
    schemaVersion: "tcrn.recall.v1",
    reasonCode: result.reasonCode,
    ...source,
    at: values.at ?? "",
    ...status,
    ...knowledge,
    query,
    queryTokens: [...result.tokens],
    // The canonical protocol carries only safe integers, and a bm25 score is not one.
    // These three are spoken the way every numeric setting in this engine is spoken --
    // as a decimal string -- rather than scaled into an integer whose unit a reader
    // would have to be told.
    tau: result.tau.toFixed(4),
    relativeFloor: result.relativeFloor.toFixed(4),
    limit: result.limit,
    scopeExcerptBytes,
    queryLanguage: languageAnswer.queryLanguage,
    queryTranslation: languageAnswer.queryTranslation,
    telemetry: languageAnswer.telemetry,
    indexed: result.indexed,
    rebuilt: result.rebuilt,
    total: result.total,
    // TCRN-CROSS-STORY-474 R2, R3: each hit also as the one line a host shows (kind and status,
    // title, key, id, the titles above it), and the answer as those lines cut to the prompt's
    // budget. Below the strong-hit threshold the reason code is RECALL_NO_STRONG_HIT and both are
    // empty: a prompt about nothing the library holds gets nothing, not its best weak guesses.
    // A card hit names its store, "project" or "user" (TCRN-CROSS-STORY-476 R5), and its line
    // marks a user card 「用户」.
    records: hits.map((hit) => ({
      kind: hit.kind, key: hit.key, id: hit.id, status: hit.status,
      title: hit.title, summary: hit.summary, score: hit.score.toFixed(4),
      line: formatRecallLine(hit), parentChain: [...hit.parentChain],
      ...(hit.scope === undefined ? {} : { scope: hit.scope }),
      ...(hit.involvedProjects === undefined ? {} : { involvedProjects: hit.involvedProjects }),
      ...(hit.obsoleteDecisions === undefined ? {} : { obsoleteDecisions: hit.obsoleteDecisions.map((entry) => ({ ...entry })) }),
      ...(hit.removal === undefined ? {} : { removal: { ...hit.removal } }),
    })),
    perPromptBytes,
    context,
  }));
}

export async function runRecallCli(arguments_: readonly string[], io: CliIo): Promise<void> {
  const rest = arguments_.slice(1);
  if (process.env["EINZBERN_RECALL_OBSERVATION"] !== "1") {
    return runRecallCommand(rest, io);
  }
  const results: { reasonCode: string; outcome: string }[] = [];
  let observation: RecallObservation | undefined;
  try {
    await withRecallObservation(() => runRecallCommand(rest, { write(value) {
      let reasonCode = "CLI_RECALL_RESULT";
      try {
        const parsed = JSON.parse(value) as { reasonCode?: unknown };
        if (typeof parsed.reasonCode === "string") reasonCode = parsed.reasonCode;
      } catch { /* Non-JSON output is not copied into telemetry. */ }
      const outcome = reasonCode === "RECALL_READY" ? "hit"
        : reasonCode === "RECALL_NO_STRONG_HIT" ? "no-hit" : "result";
      results.push({ reasonCode, outcome });
      io.write(value);
    } }), value => { observation = value; });
  } catch (error) {
    const reason = (error as { reasonCode?: unknown }).reasonCode;
    const queryPosition = arguments_.indexOf("--query");
    const query = queryPosition < 0 ? undefined : arguments_[queryPosition + 1];
    const empty = typeof query === "string" && query.trim().length === 0
      && (error as { message?: unknown }).message === "query"
      && (reason === "CLI_ARGUMENT_MISSING" || reason === "CLI_ARGUMENT_MALFORMED");
    results.push({ reasonCode: typeof reason === "string" ? reason : "CLI_RECALL_FAILED", outcome: empty ? "empty" : "error" });
    throw error;
  } finally {
    if (observation !== undefined) {
      const { logCliRecall } = await import("../../core/src/recall-observation-log.js");
      await logCliRecall(observation, results);
    }
  }
}
