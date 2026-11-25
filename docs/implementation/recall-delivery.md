# Recall clause delivery

Recall keeps the record as the ranking unit and carries the matching decision's
number, text, validity, scope and stable source into the hit. A clause index keeps
a technical query from being diluted by the other decisions in a long minutes
record. Its scores use the query's actual clause and record frequencies, so common
terms in a small clause corpus cannot acquire artificial record-level rarity. Full identifiers
and their case/underscore/hyphen subwords are indexed together. The tokenizer used
by conflict detection is unchanged.

Identifier expansions use a separate index route so they cannot change unrelated
prose scores through length normalization. Short clause queries must match their
constraints together; a complete clause match receives a 1.1 multiplier.
An exact technical identifier in a short query receives the existing body weight
in record IDF units only when all query constraints match. A minutes record must
carry that name in an eligible clause. Unmatched words receive no such bonus.

Long prose queries use at most 48 informative terms, selected by corpus rarity.
In the controlled comparison on the migrated project corpus, both rarity and
title-or-tag priority retrieved 6 of 12 judged references for queries of 87–108
terms at the default threshold. The short controls retrieved 11 of 12 under
both orders. The engine retains rarity ordering.

Without a title, summary or
authored expansion anchor, their scores scale by coverage of the complete query,
including terms absent from the corpus. Explicit
external keys retain their existing priority. The strong-hit threshold, relative
floor and prompt budget retain their existing values.

The state adapter constructs a Work current contract from its current summary,
goal, acceptance, required requirements, constraints and valid associated decisions.
Legacy prose before a history/revision/progress heading remains searchable;
annotation history stays available through work-show and work-content-context.
A terminal current contract has a score multiplier of 0.85 for action queries;
explicit keys and historical queries retain their priority. Akasha records and
conflict/scope admission are unchanged.

Minutes lines label current validity or historical intent, state their project
scope (or the minutes-local scope of a legacy compact fixture), include a clause
excerpt and retain a complete minutes-show locator. Excerpts reserve source bytes
before shortening prose. Empty titles, bare keys/numbers and empty summary shells
are not injected. A line that does not fit is skipped; later candidates still
compete for the remaining bytes. Returning no line is legitimate when no complete
line fits. CLI records remain diagnostic and do not prove injection.

The decision-delivery freeze supplements the existing retrieval-eval corpus and
floors. Its source-derived public regression questions are not independent blind
user prompts. Development and tuning are scored before holdout; holdout sources
are disjoint and are not used to choose parameters. Snapshot sources may coexist
in the disposable evaluation library even when their prose overlaps; this is a
fixture import declaration, not a new live-chain decision.

The evaluator calls the normal CLI with --view agent and checks the actual context
for the expected D number, validity, excerpt, scope and complete expandable source.
It separately reports record Top-3, actual clause delivery, budget omissions,
ranked records without the expected clause, obsolete clauses injected as current,
historical correctness, legal empty results, invalid empty results and unrelated
false injections. An invalid empty positive result refuses the gate independently
of aggregate delivery. The content-addressed manifest and existing threshold policy
bind the cases and floors before scoring. Byte drift and private text refuse by
name. Recording and scoring run with the filesystem write tripwire over the
fixture library, with before/after byte digests. Raw outputs stay in the caller's
private output directory.
## Candidate delivery and minutes search

Admitted native dispatches offer short candidate lines using the work title and goal. Each line carries a record type, key, title, and read reference. Preparation keeps the references beside the bound prompt, and native execution receipts retain that preparation.

Use `recall --view candidates` to repeat or rephrase a query. Use `recall-read --refs` to read any useful references. The optional recall observation records only successfully returned references for that library.

Atelier and `minutes-list --query` use the same query and ranking path as explicit recall. After review of the historical supplements, the library setting `retrieval.metadataOnly` switches matching to titles, tags, authored search terms, and identifiers. The same switch enables short candidates in prompt hooks. The default preserves the existing matching and prompt format. Direct reads continue returning the original content.

The supplement commands report the state of the append. Record an Owner sample review with the library, project, source version, supplemented version, and sample digest. Use that bounded copy for the retrieval rehearsal and relevance comparison allowed by the review. Record the production cutover scope and timing when making that decision.
